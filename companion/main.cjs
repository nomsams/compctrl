const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  powerSaveBlocker,
  safeStorage,
  session,
  shell,
} = require('electron');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 12;
const JIGGLE_INTERVAL_MS = 30_000;
const DISPLAY_OFF_REASSERT_MS = 2_000;
const GROQ_TRANSCRIPTION_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_WHISPER_MODEL = 'whisper-large-v3-turbo';
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const MAX_NATIVE_QUEUE = 512;
const DEFAULT_CONTROLLER_URL = 'https://nomsams.github.io/compctrl/';
const isDevelopment = !app.isPackaged;

let mainWindow = null;
let tray = null;
let staticServer = null;
let nativeBridge = null;
let nativeBridgeReady = false;
let nativeQueue = [];
let jigglerTimer = null;
let displaySleepBlocker = null;
let displayOffTimer = null;
let displayOffAfterInputTimer = null;
let screenBlanked = false;
let isQuitting = false;
let transcriptionInProgress = false;
let transcriptionTimes = [];

function generateCode() {
  return Array.from(crypto.randomBytes(CODE_LENGTH), (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function defaultSettings() {
  return {
    pairingCode: generateCode(),
    controllerUrl: process.env.COMPCTRL_WEB_URL || DEFAULT_CONTROLLER_URL,
    jigglerEnabled: false,
    autoStart: true,
    groqApiKeyProtected: '',
  };
}

function readSettings() {
  try {
    const defaults = defaultSettings();
    const stored = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    return {
      pairingCode: typeof stored.pairingCode === 'string' && new RegExp(`^[A-Z2-9]{${CODE_LENGTH}}$`).test(stored.pairingCode)
        ? stored.pairingCode
        : defaults.pairingCode,
      controllerUrl: typeof stored.controllerUrl === 'string' && stored.controllerUrl.length < 2_048
        ? stored.controllerUrl
        : defaults.controllerUrl,
      jigglerEnabled: stored.jigglerEnabled === true,
      autoStart: stored.autoStart !== false,
      groqApiKeyProtected: typeof stored.groqApiKeyProtected === 'string' ? stored.groqApiKeyProtected : '',
    };
  } catch {
    return defaultSettings();
  }
}

function writeSettings(settings) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  const temporaryPath = `${settingsPath()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporaryPath, settingsPath());
  try { fs.chmodSync(settingsPath(), 0o600); } catch { /* Windows protects this through the user profile ACL. */ }
}

let settings = null;

function hasGroqApiKey() {
  return Boolean(settings?.groqApiKeyProtected && safeStorage.isEncryptionAvailable());
}

function setGroqApiKey(value) {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!key) {
    settings.groqApiKeyProtected = '';
    writeSettings(settings);
    return false;
  }
  if (key.length < 20 || key.length > 256 || /\s/.test(key)) throw new Error('Enter a valid Groq API key.');
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows credential encryption is unavailable for this account.');
  settings.groqApiKeyProtected = safeStorage.encryptString(key).toString('base64');
  writeSettings(settings);
  return true;
}

function readGroqApiKey() {
  if (!hasGroqApiKey()) throw new Error('Add a Groq API key in the Windows companion first.');
  try {
    return safeStorage.decryptString(Buffer.from(settings.groqApiKeyProtected, 'base64'));
  } catch {
    throw new Error('The saved Groq API key could not be unlocked by this Windows account. Save it again.');
  }
}

function isNativeMessage(message) {
  if (!message || typeof message !== 'object') return false;
  if (message.type === 'pointer') {
    return ['move', 'down', 'up', 'click'].includes(message.action)
      && Number.isFinite(message.x) && message.x >= 0 && message.x <= 1
      && Number.isFinite(message.y) && message.y >= 0 && message.y <= 1
      && (message.button === undefined || ['left', 'right', 'middle'].includes(message.button));
  }
  if (message.type === 'wheel') {
    return Number.isFinite(message.deltaX) && Math.abs(message.deltaX) <= 2_000
      && Number.isFinite(message.deltaY) && Math.abs(message.deltaY) <= 2_000;
  }
  if (message.type === 'key') {
    return ['down', 'up', 'tap'].includes(message.action)
      && typeof message.key === 'string' && message.key.length >= 1 && message.key.length <= 32
      && (message.modifiers === undefined || (
        Array.isArray(message.modifiers) && message.modifiers.length <= 4
        && message.modifiers.every((modifier) => ['Control', 'Alt', 'Shift', 'Meta'].includes(modifier))
      ));
  }
  return message.type === 'text' && typeof message.text === 'string' && message.text.length > 0 && message.text.length <= 16_384;
}

function assertTrustedIpc(event) {
  if (
    !mainWindow
    || mainWindow.isDestroyed()
    || event.sender !== mainWindow.webContents
    || !isTrustedRendererUrl(event.senderFrame?.url || event.sender?.getURL?.() || '')
  ) {
    throw new Error('Blocked IPC request from an untrusted renderer.');
  }
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function verifyBundledIntegrity() {
  if (!app.isPackaged) return { ok: true };
  try {
    const manifestPath = path.join(app.getAppPath(), 'companion', 'integrity.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.version !== 1 || manifest.algorithm !== 'sha256' || !Array.isArray(manifest.files)) {
      throw new Error('invalid integrity manifest');
    }
    const resourcesRoot = path.resolve(process.resourcesPath);
    for (const entry of manifest.files) {
      if (!entry || typeof entry.path !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
        throw new Error('invalid integrity entry');
      }
      const target = path.resolve(resourcesRoot, ...entry.path.split('/'));
      const relative = path.relative(resourcesRoot, target);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('unsafe integrity path');
      if (sha256File(target) !== entry.sha256) throw new Error(`resource changed: ${entry.path}`);
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'unknown integrity failure' };
  }
}

function sendNative(message) {
  const line = `${JSON.stringify(message)}\n`;
  if (!nativeBridgeReady || !nativeBridge?.stdin?.writable) {
    if (nativeQueue.length >= MAX_NATIVE_QUEUE) nativeQueue.shift();
    nativeQueue.push(line);
    return;
  }
  nativeBridge.stdin.write(line);
  if (screenBlanked && ['pointer', 'wheel', 'key', 'text', 'jiggle'].includes(message.type)) {
    if (displayOffAfterInputTimer) clearTimeout(displayOffAfterInputTimer);
    displayOffAfterInputTimer = setTimeout(() => {
      displayOffAfterInputTimer = null;
      sendNative({ type: 'display-power', state: 'off' });
    }, 80);
  }
}

function startNativeBridge() {
  if (process.platform !== 'win32') return;
  // PowerShell cannot read a script embedded inside app.asar. Ship the bridge as
  // an extra resource and use the source copy only while developing.
  const scriptPath = app.isPackaged
    ? path.join(process.resourcesPath, 'native-bridge.ps1')
    : path.join(__dirname, 'native-bridge.ps1');
  nativeBridge = spawn(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  nativeBridge.stdout.setEncoding('utf8');
  nativeBridge.stdout.on('data', (chunk) => {
    if (chunk.includes('READY')) {
      nativeBridgeReady = true;
      for (const line of nativeQueue.splice(0)) nativeBridge.stdin.write(line);
    }
  });
  nativeBridge.on('exit', () => {
    nativeBridgeReady = false;
    nativeBridge = null;
    if (!isQuitting) setTimeout(startNativeBridge, 1500);
  });
}

function configureJiggler(enabled) {
  if (jigglerTimer) clearInterval(jigglerTimer);
  jigglerTimer = null;
  if (displaySleepBlocker !== null && powerSaveBlocker.isStarted(displaySleepBlocker)) {
    powerSaveBlocker.stop(displaySleepBlocker);
  }
  displaySleepBlocker = null;
  if (enabled) {
    displaySleepBlocker = powerSaveBlocker.start('prevent-display-sleep');
    jigglerTimer = setInterval(() => sendNative({ type: 'jiggle' }), JIGGLE_INTERVAL_MS);
  }
}

function configureAutoStart(enabled) {
  if (process.platform !== 'win32' || isDevelopment) return;
  app.setLoginItemSettings({
    openAtLogin: Boolean(enabled),
    openAsHidden: true,
    args: ['--hidden'],
  });
}

function runSystemAction(action) {
  if (process.platform !== 'win32') return;
  const args = action === 'restart' ? ['/r', '/t', '5'] : ['/s', '/t', '5'];
  const child = spawn('shutdown.exe', args, { detached: true, windowsHide: true, stdio: 'ignore' });
  child.unref();
}

async function transcribeAudio(chunks, mimeType) {
  if (transcriptionInProgress) throw new Error('Another dictation is already being transcribed.');
  const normalizedMime = typeof mimeType === 'string' ? mimeType.toLowerCase() : '';
  const allowedMimeTypes = new Set(['audio/webm', 'audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg', 'audio/ogg;codecs=opus']);
  if (!allowedMimeTypes.has(normalizedMime) || !Array.isArray(chunks) || chunks.length < 1 || chunks.length > 2_048) {
    throw new Error('The recorded audio was invalid.');
  }
  const encodedLength = chunks.reduce((total, chunk) => total + (typeof chunk === 'string' ? chunk.length : MAX_AUDIO_BYTES * 2), 0);
  if (encodedLength > Math.ceil(MAX_AUDIO_BYTES * 4 / 3) + chunks.length * 4) throw new Error('Dictation is too long. Keep it under 90 seconds.');
  const buffers = chunks.map((chunk) => {
    if (typeof chunk !== 'string' || chunk.length > 64 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(chunk)) {
      throw new Error('The recorded audio was invalid.');
    }
    return Buffer.from(chunk, 'base64');
  });
  const audio = Buffer.concat(buffers);
  if (!audio.length || audio.length > MAX_AUDIO_BYTES) throw new Error('Dictation is too long. Keep it under 90 seconds.');

  const now = Date.now();
  transcriptionTimes = transcriptionTimes.filter((time) => now - time < 5 * 60_000);
  if (transcriptionTimes.length >= 10) throw new Error('Dictation rate limit reached. Try again in a few minutes.');
  transcriptionTimes.push(now);
  transcriptionInProgress = true;
  try {
    const extension = normalizedMime.includes('mp4') ? 'mp4' : normalizedMime.includes('ogg') ? 'ogg' : 'webm';
    const form = new FormData();
    form.append('file', new Blob([audio], { type: normalizedMime }), `dictation.${extension}`);
    form.append('model', GROQ_WHISPER_MODEL);
    form.append('response_format', 'json');
    form.append('temperature', '0');
    const response = await fetch(GROQ_TRANSCRIPTION_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${readGroqApiKey()}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error('Groq rejected the saved API key. Check it in the companion.');
      if (response.status === 429) throw new Error('Groq rate-limited this request. Try again shortly.');
      throw new Error(`Groq transcription failed with status ${response.status}.`);
    }
    const result = await response.json();
    const text = typeof result?.text === 'string' ? result.text.trim() : '';
    if (!text) throw new Error('No speech was detected.');
    if (text.length > 16_384) throw new Error('The transcript was too long to insert safely.');
    return text;
  } finally {
    transcriptionInProgress = false;
  }
}

function isTrustedRendererUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  } catch {
    return false;
  }
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open CompCtrl', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    ...(screenBlanked ? [{ label: 'Turn local screens back on', click: () => setScreenBlanked(false) }] : []),
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        setScreenBlanked(false);
        isQuitting = true;
        setTimeout(() => app.quit(), 120);
      },
    },
  ]));
}

function setScreenBlanked(enabled) {
  if (displayOffTimer) clearInterval(displayOffTimer);
  if (displayOffAfterInputTimer) clearTimeout(displayOffAfterInputTimer);
  displayOffTimer = null;
  displayOffAfterInputTimer = null;
  screenBlanked = Boolean(enabled);
  sendNative({ type: 'display-power', state: screenBlanked ? 'off' : 'on' });
  if (screenBlanked) {
    displayOffTimer = setInterval(
      () => sendNative({ type: 'display-power', state: 'off' }),
      DISPLAY_OFF_REASSERT_MS,
    );
  }
  updateTrayMenu();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('compctrl:display-state', screenBlanked);
  }
  return screenBlanked;
}

function registerIpc() {
  ipcMain.handle('compctrl:get-settings', (event) => {
    assertTrustedIpc(event);
    return {
      pairingCode: settings.pairingCode,
      controllerUrl: settings.controllerUrl,
      jigglerEnabled: settings.jigglerEnabled,
      autoStart: settings.autoStart,
      groqKeyConfigured: hasGroqApiKey(),
      screenBlanked,
      computerName: os.hostname(),
      version: app.getVersion(),
    };
  });

  ipcMain.handle('compctrl:save-settings', (event, changes) => {
    assertTrustedIpc(event);
    const next = { ...settings };
    if (typeof changes?.pairingCode === 'string' && new RegExp(`^[A-Z2-9]{${CODE_LENGTH}}$`).test(changes.pairingCode)) {
      next.pairingCode = changes.pairingCode;
    }
    if (typeof changes?.controllerUrl === 'string' && changes.controllerUrl.length < 2048) {
      try {
        const url = new URL(changes.controllerUrl);
        if (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
          next.controllerUrl = url.toString();
        }
      } catch { /* Ignore invalid controller addresses. */ }
    }
    if (typeof changes?.autoStart === 'boolean') {
      next.autoStart = changes.autoStart;
      configureAutoStart(next.autoStart);
    }
    settings = next;
    writeSettings(settings);
  });

  ipcMain.handle('compctrl:dispatch', (event, message) => {
    assertTrustedIpc(event);
    if (isNativeMessage(message)) sendNative(message);
  });

  ipcMain.handle('compctrl:set-jiggler', (event, enabled) => {
    assertTrustedIpc(event);
    if (typeof enabled !== 'boolean') return;
    settings.jigglerEnabled = Boolean(enabled);
    writeSettings(settings);
    configureJiggler(settings.jigglerEnabled);
  });

  ipcMain.handle('compctrl:set-display-blanked', (event, enabled) => {
    assertTrustedIpc(event);
    if (typeof enabled !== 'boolean') return screenBlanked;
    return setScreenBlanked(enabled);
  });

  ipcMain.handle('compctrl:system-action', (event, action) => {
    assertTrustedIpc(event);
    if (action === 'restart' || action === 'shutdown') runSystemAction(action);
  });

  ipcMain.handle('compctrl:set-groq-api-key', (event, value) => {
    assertTrustedIpc(event);
    return setGroqApiKey(value);
  });

  ipcMain.handle('compctrl:transcribe-audio', (event, chunks, audioMimeType) => {
    assertTrustedIpc(event);
    return transcribeAudio(chunks, audioMimeType);
  });
}

function mimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
  }[extension] || 'application/octet-stream';
}

function startStaticServer() {
  const webRoot = path.join(process.resourcesPath, 'web');
  staticServer = http.createServer((request, response) => {
    let requestPath;
    try {
      requestPath = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    } catch {
      response.writeHead(400).end('Bad request');
      return;
    }
    const requested = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
    let filePath = path.resolve(webRoot, requested);
    const relativePath = path.relative(path.resolve(webRoot), filePath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) filePath = path.join(webRoot, 'index.html');
    response.setHeader('Content-Type', mimeType(filePath));
    response.setHeader('Cache-Control', requested === 'index.html' ? 'no-cache' : 'public, max-age=31536000, immutable');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; connect-src 'self' https://0.peerjs.com wss://0.peerjs.com https://*.peerjs.com wss://*.peerjs.com; worker-src 'self' blob:;",
    );
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    fs.createReadStream(filePath).pipe(response);
  });
  return new Promise((resolve) => staticServer.listen(0, '127.0.0.1', () => resolve(staticServer.address().port)));
}

function trayIcon() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="9" fill="#315efb"/><path d="M9 7.5 24 17l-7 1.5-3.2 6.2z" fill="white"/><path d="m17 18.5 4.5 5" stroke="white" stroke-width="2.4" stroke-linecap="round"/></svg>`;
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`).resize({ width: 20, height: 20 });
}

async function createWindow() {
  const rendererUrl = isDevelopment
    ? (process.env.ELECTRON_RENDERER_URL || 'http://localhost:3000/')
    : `http://127.0.0.1:${await startStaticServer()}/`;

  mainWindow = new BrowserWindow({
    width: 1040,
    height: 790,
    minWidth: 760,
    minHeight: 620,
    backgroundColor: '#eef1f5',
    show: !process.argv.includes('--hidden'),
    title: 'CompCtrl companion',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://localhost')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url)) event.preventDefault();
  });
  mainWindow.webContents.session.on('will-download', (event) => event.preventDefault());
  await mainWindow.loadURL(rendererUrl);
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('CompCtrl companion');
  updateTrayMenu();
  tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus(); });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { mainWindow?.show(); mainWindow?.focus(); });
  app.whenReady().then(async () => {
    const integrity = verifyBundledIntegrity();
    if (!integrity.ok) {
      dialog.showErrorBox(
        'CompCtrl integrity check failed',
        `A packaged application file was changed or damaged. Reinstall CompCtrl from a verified download.\n\n${integrity.message}`,
      );
      app.quit();
      return;
    }
    settings = readSettings();
    writeSettings(settings);
    registerIpc();
    startNativeBridge();
    configureJiggler(settings.jigglerEnabled);
    configureAutoStart(settings.autoStart);

    const appSession = session.defaultSession;
    appSession.setDisplayMediaRequestHandler(async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
        callback(sources[0] ? { video: sources[0] } : null);
      } catch (error) {
        console.error('Could not enumerate desktop capture sources:', error);
        callback(null);
      }
    }, { useSystemPicker: false });
    appSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
      const requestingUrl = details.requestingUrl || '';
      callback(isTrustedRendererUrl(requestingUrl) && (permission === 'media' || permission === 'display-capture'));
    });
    appSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
      const requestingUrl = details?.requestingUrl || requestingOrigin || details?.securityOrigin || '';
      return isTrustedRendererUrl(requestingUrl) && (permission === 'media' || permission === 'display-capture');
    });

    createTray();
    await createWindow();
    const recoveryShortcutRegistered = globalShortcut.register(
      'CommandOrControl+Alt+Shift+F12',
      () => setScreenBlanked(false),
    );
    if (!recoveryShortcutRegistered) {
      console.warn('The display recovery shortcut Ctrl+Alt+Shift+F12 is already in use.');
    }
  });
}

app.on('before-quit', () => {
  if (screenBlanked) setScreenBlanked(false);
  isQuitting = true;
});
app.on('will-quit', () => {
  screenBlanked = false;
  if (displayOffTimer) clearInterval(displayOffTimer);
  if (displayOffAfterInputTimer) clearTimeout(displayOffAfterInputTimer);
  globalShortcut.unregisterAll();
  if (jigglerTimer) clearInterval(jigglerTimer);
  if (nativeBridge?.stdin?.writable) nativeBridge.stdin.end();
  else nativeBridge?.kill();
  staticServer?.close();
});
