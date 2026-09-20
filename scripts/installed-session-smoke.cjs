const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const controllerUrl = process.env.COMPCTRL_CONTROLLER_URL || 'https://nomsams.github.io/compctrl/';
const sessionCycles = Math.max(1, Math.min(3, Number.parseInt(process.env.COMPCTRL_SESSION_CYCLES || '1', 10) || 1));
const settingsPath = path.join(process.env.APPDATA || '', 'CompCtrl', 'settings.json');
const profilePath = path.resolve(os.tmpdir(), 'compctrl-installed-session-smoke');
if (path.dirname(profilePath) !== path.resolve(os.tmpdir())) throw new Error('Unsafe installed-session smoke-test profile path.');
fs.rmSync(profilePath, { recursive: true, force: true });
app.setPath('userData', profilePath);

process.once('exit', () => {
  try { fs.rmSync(profilePath, { recursive: true, force: true }); } catch { /* Chromium may retain cache handles briefly. */ }
});

function readPairingCode() {
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const code = typeof settings.pairingCode === 'string' ? settings.pairingCode : '';
  if (!/^[A-Z2-9]{12}$/.test(code)) throw new Error('The installed companion has no valid pairing code.');
  return code;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function snapshot(window) {
  return window.webContents.executeJavaScript(`(() => {
    const text = document.body?.innerText || '';
    const video = document.querySelector('video.remote-video');
    return {
      title: document.title,
      connecting: text.includes('Finding your computer'),
      securingVideo: text.includes('Securing video'),
      live: /(^|\\n)Live ·/.test(text),
      startingScreen: text.includes('Starting live screen'),
      authenticationFailed: /no longer trusted|authentication failed|session is busy/i.test(text),
      notice: [...document.querySelectorAll('.remote-empty span, .stream-diagnostic')]
        .map((element) => element.textContent?.trim()).filter(Boolean).slice(0, 4),
      video: video ? {
        readyState: video.readyState,
        paused: video.paused,
        width: video.videoWidth,
        height: video.videoHeight,
        hasStream: Boolean(video.srcObject),
      } : null,
    };
  })()`, true);
}

app.whenReady().then(async () => {
  const diagnostics = [];
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const recordDiagnostic = (value) => {
    const safe = String(value)
      .replace(/compctrl-v2-[A-Za-z0-9_-]+/g, 'compctrl-v2-[redacted]')
      .replace(/[A-Za-z0-9_-]{40,}/g, '[redacted]')
      .slice(0, 500);
    if (safe && !diagnostics.includes(safe)) diagnostics.push(safe);
  };
  window.webContents.setUserAgent(`${window.webContents.getUserAgent()} CompCtrlSmoke`);
  window.webContents.on('console-message', (...args) => {
    const details = args[1];
    const message = details && typeof details === 'object' ? details.message : args[2];
    if (/PeerJS|peer|error|failed/i.test(String(message))) recordDiagnostic(message);
  });
  window.webContents.on('did-fail-load', (_event, code, description) => recordDiagnostic(`load ${code}: ${description}`));
  try {
    const code = readPairingCode();
    const baseUrl = controllerUrl.replace(/#.*$/, '');
    const results = [];
    for (let cycle = 0; cycle < sessionCycles; cycle += 1) {
      await window.loadURL(cycle === 0 ? `${baseUrl}#${code}` : baseUrl);
      let state = await snapshot(window);
      const startedAt = Date.now();
      while (Date.now() - startedAt < 45_000) {
        if (state.live && state.video?.hasStream && state.video.readyState >= 2 && state.video.width > 0) break;
        await delay(1_000);
        state = await snapshot(window);
      }
      if (!state.live || !state.video?.hasStream || state.video.readyState < 2 || state.video.width <= 0) {
        const pairingCodeChanged = readPairingCode() !== code;
        throw new Error(`Installed session did not become live: ${JSON.stringify({ cycle: cycle + 1, state, diagnostics, pairingCodeChanged })}`);
      }
      results.push({ cycle: cycle + 1, elapsedMs: Date.now() - startedAt, state });
      if (cycle + 1 < sessionCycles) {
        await window.loadURL('about:blank');
        await delay(13_000);
      }
    }
    process.stdout.write(`${JSON.stringify({ connected: true, cycles: results })}\n`);
    app.exit(0);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    app.exit(1);
  }
});
