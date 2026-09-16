const { app, BrowserWindow, desktopCapturer, screen, session } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { isAuthorizedDisplayMediaPermission } = require('../companion/security.cjs');

const useSoftwareRendering = process.argv.includes('--software-rendering');
const disableWgc = process.argv.includes('--disable-wgc');
const useWebRtcLoopback = process.argv.includes('--webrtc-loopback');
const useStrictPermissions = process.argv.includes('--strict-permissions');
const useSystemAudio = process.argv.includes('--system-audio');
const logPermissions = process.argv.includes('--log-permissions');

if (useSoftwareRendering) app.disableHardwareAcceleration();
if (disableWgc && process.platform === 'win32') {
  app.commandLine.appendSwitch('disable-features', 'WebRtcAllowWgcScreenCapturer');
}
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

async function run() {
  const appSession = session.defaultSession;
  let selectedSource = null;
  let trustedRendererOrigin = '';
  let staticServer = null;
  let window = null;
  let captureAuthorized = false;
  const isTrustedRendererUrl = (value) => {
    try { return Boolean(trustedRendererOrigin) && new URL(value).origin === trustedRendererOrigin; } catch { return false; }
  };
  appSession.setDisplayMediaRequestHandler(async (request, callback) => {
    if (useStrictPermissions) {
      const trustedFrame = Boolean(request.frame && window && request.frame.top === window.webContents.mainFrame);
      if (!captureAuthorized || !trustedFrame || !isTrustedRendererUrl(request.securityOrigin) || !request.videoRequested || request.audioRequested !== useSystemAudio) {
        captureAuthorized = false;
        callback(null);
        return;
      }
    }
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      const primaryId = String(screen.getPrimaryDisplay().id);
      selectedSource = sources.find((source) => String(source.display_id) === primaryId) ?? sources[0] ?? null;
      callback(selectedSource ? { video: selectedSource, ...(request.audioRequested ? { audio: 'loopback' } : {}) } : null);
    } catch (error) {
      console.error(error);
      callback(null);
    } finally {
      captureAuthorized = false;
    }
  }, { useSystemPicker: false });

  if (useStrictPermissions) {
    appSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
      const requestingUrl = details?.requestingUrl || '';
      const trusted = Boolean(window && webContents === window.webContents && isTrustedRendererUrl(webContents.getURL()) && isTrustedRendererUrl(requestingUrl));
      const allowed = trusted && isAuthorizedDisplayMediaPermission(permission, details, captureAuthorized);
      if (logPermissions) console.error(JSON.stringify({ phase: 'request', permission, requestingUrl, webContentsUrl: webContents?.getURL?.() ?? '', mediaTypes: details?.mediaTypes, allowed }));
      callback(allowed);
    });
    appSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
      const requestingUrl = details?.requestingUrl || requestingOrigin || details?.securityOrigin || '';
      const trusted = Boolean(window && webContents === window.webContents && isTrustedRendererUrl(webContents.getURL()) && isTrustedRendererUrl(requestingUrl));
      const allowed = trusted && isAuthorizedDisplayMediaPermission(permission, details, captureAuthorized);
      if (logPermissions) console.error(JSON.stringify({ phase: 'check', permission, requestingOrigin, requestingUrl, webContentsUrl: webContents?.getURL?.() ?? '', mediaType: details?.mediaType, allowed }));
      return allowed;
    });
    const html = fs.readFileSync(path.join(__dirname, 'capture-smoke.html'));
    staticServer = http.createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      response.end(html);
    });
    await new Promise((resolve) => staticServer.listen(0, '127.0.0.1', resolve));
    trustedRendererOrigin = `http://127.0.0.1:${staticServer.address().port}`;
  }

  window = new BrowserWindow({
    show: false,
    webPreferences: { backgroundThrottling: false, sandbox: true },
  });
  if (useStrictPermissions) await window.loadURL(`${trustedRendererOrigin}/`);
  else await window.loadFile(path.join(__dirname, 'capture-smoke.html'));
  captureAuthorized = true;
  const result = await window.webContents.executeJavaScript(`
    (async () => {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 10 }, audio: ${JSON.stringify(useSystemAudio)} });
      let inspectedStream = stream;
      let sender = null;
      let receiver = null;
      if (${JSON.stringify(process.argv.includes('--webrtc-loopback'))}) {
        sender = new RTCPeerConnection({ iceServers: [] });
        receiver = new RTCPeerConnection({ iceServers: [] });
        sender.addEventListener('icecandidate', (event) => {
          if (event.candidate) receiver.addIceCandidate(event.candidate);
        });
        receiver.addEventListener('icecandidate', (event) => {
          if (event.candidate) sender.addIceCandidate(event.candidate);
        });
        const remoteStream = new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Local WebRTC produced no remote track.')), 8000);
          receiver.addEventListener('track', (event) => {
            clearTimeout(timeout);
            resolve(event.streams[0] ?? new MediaStream([event.track]));
          }, { once: true });
        });
        for (const track of stream.getTracks()) sender.addTrack(track, stream);
        await sender.setLocalDescription(await sender.createOffer());
        await receiver.setRemoteDescription(sender.localDescription);
        await receiver.setLocalDescription(await receiver.createAnswer());
        await sender.setRemoteDescription(receiver.localDescription);
        inspectedStream = await remoteStream;
      }
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = inspectedStream;
      await video.play();
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('No desktop frame arrived within 8 seconds.')), 8000);
        const done = () => { clearTimeout(timeout); resolve(); };
        if (typeof video.requestVideoFrameCallback === 'function') video.requestVideoFrameCallback(done);
        else if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) done();
        else video.addEventListener('loadeddata', done, { once: true });
      });
      const canvas = document.createElement('canvas');
      canvas.width = 80;
      canvas.height = 45;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let signaledPixels = 0;
      let channelTotal = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        const signal = pixels[index] + pixels[index + 1] + pixels[index + 2];
        channelTotal += signal;
        if (signal > 18) signaledPixels += 1;
      }
      const settings = stream.getVideoTracks()[0]?.getSettings() ?? {};
      sender?.close();
      receiver?.close();
      stream.getTracks().forEach((track) => track.stop());
      return {
        width: settings.width ?? video.videoWidth,
        height: settings.height ?? video.videoHeight,
        signaledPixels,
        sampledPixels: pixels.length / 4,
        meanChannelValue: channelTotal / (pixels.length / 4) / 3,
      };
    })()
  `, true);
  console.log(JSON.stringify({
    useSoftwareRendering,
    disableWgc,
    useWebRtcLoopback,
    useStrictPermissions,
    useSystemAudio,
    source: selectedSource ? { id: selectedSource.id, name: selectedSource.name, displayId: selectedSource.display_id } : null,
    ...result,
  }));
  staticServer?.close();
  app.exit(result.signaledPixels > 0 ? 0 : 2);
}

app.whenReady().then(run).catch((error) => {
  console.error(error);
  app.exit(1);
});
