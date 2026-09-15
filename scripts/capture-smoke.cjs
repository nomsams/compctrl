const { app, BrowserWindow, desktopCapturer, screen, session } = require('electron');
const path = require('node:path');

const useSoftwareRendering = process.argv.includes('--software-rendering');
const disableWgc = process.argv.includes('--disable-wgc');
const useWebRtcLoopback = process.argv.includes('--webrtc-loopback');

if (useSoftwareRendering) app.disableHardwareAcceleration();
if (disableWgc && process.platform === 'win32') {
  app.commandLine.appendSwitch('disable-features', 'WebRtcAllowWgcScreenCapturer');
}
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

async function run() {
  const appSession = session.defaultSession;
  let selectedSource = null;
  appSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      const primaryId = String(screen.getPrimaryDisplay().id);
      selectedSource = sources.find((source) => String(source.display_id) === primaryId) ?? sources[0] ?? null;
      callback(selectedSource ? { video: selectedSource } : null);
    } catch (error) {
      console.error(error);
      callback(null);
    }
  }, { useSystemPicker: false });

  const window = new BrowserWindow({
    show: false,
    webPreferences: { backgroundThrottling: false, sandbox: true },
  });
  await window.loadFile(path.join(__dirname, 'capture-smoke.html'));
  const result = await window.webContents.executeJavaScript(`
    (async () => {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 10 }, audio: false });
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
    source: selectedSource ? { id: selectedSource.id, name: selectedSource.name, displayId: selectedSource.display_id } : null,
    ...result,
  }));
  app.exit(result.signaledPixels > 0 ? 0 : 2);
}

app.whenReady().then(run).catch((error) => {
  console.error(error);
  app.exit(1);
});
