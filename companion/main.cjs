const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  desktopCapturer,
  ipcMain,
  nativeImage,
  powerSaveBlocker,
  session,
  shell,
} = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const JIGGLE_INTERVAL_MS = 30_000;
const isDevelopment = !app.isPackaged;

let mainWindow = null;
let tray = null;
let staticServer = null;
let nativeBridge = null;
let nativeBridgeReady = false;
let nativeQueue = [];
let jigglerTimer = null;
let displaySleepBlocker = null;
let isQuitting = false;

function generateCode() {
  const crypto = require('node:crypto');
  return Array.from(crypto.randomBytes(8), (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function defaultSettings() {
  return {
    pairingCode: generateCode(),
    controllerUrl: process.env.COMPCTRL_WEB_URL || '',
    jigglerEnabled: false,
    autoStart: true,
  };
}

function readSettings() {
  try {
    return { ...defaultSettings(), ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) };
  } catch {
    return defaultSettings();
  }
}

function writeSettings(settings) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  const temporaryPath = `${settingsPath()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporaryPath, settingsPath());
}

let settings = null;

function sendNative(message) {
  const line = `${JSON.stringify(message)}\n`;
  if (!nativeBridgeReady || !nativeBridge?.stdin?.writable) {
    nativeQueue.push(line);
    return;
  }
  nativeBridge.stdin.write(line);
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

function registerIpc() {
  ipcMain.handle('compctrl:get-settings', () => ({
    ...settings,
    computerName: os.hostname(),
    version: app.getVersion(),
  }));

  ipcMain.handle('compctrl:save-settings', (_event, changes) => {
    const next = { ...settings };
    if (typeof changes?.pairingCode === 'string' && /^[A-Z2-9]{8}$/.test(changes.pairingCode)) {
      next.pairingCode = changes.pairingCode;
    }
    if (typeof changes?.controllerUrl === 'string' && changes.controllerUrl.length < 2048) {
      next.controllerUrl = changes.controllerUrl;
    }
    if (typeof changes?.autoStart === 'boolean') {
      next.autoStart = changes.autoStart;
      configureAutoStart(next.autoStart);
    }
    settings = next;
    writeSettings(settings);
  });

  ipcMain.handle('compctrl:dispatch', (_event, message) => {
    if (!message || typeof message !== 'object') return;
    const allowed = new Set(['pointer', 'wheel', 'key', 'text']);
    if (allowed.has(message.type)) sendNative(message);
  });

  ipcMain.handle('compctrl:set-jiggler', (_event, enabled) => {
    settings.jigglerEnabled = Boolean(enabled);
    writeSettings(settings);
    configureJiggler(settings.jigglerEnabled);
  });

  ipcMain.handle('compctrl:system-action', (_event, action) => {
    if (action === 'restart' || action === 'shutdown') runSystemAction(action);
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
    const requestPath = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    const requested = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
    let filePath = path.resolve(webRoot, requested);
    if (!filePath.startsWith(path.resolve(webRoot))) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) filePath = path.join(webRoot, 'index.html');
    response.setHeader('Content-Type', mimeType(filePath));
    response.setHeader('Cache-Control', requested === 'index.html' ? 'no-cache' : 'public, max-age=31536000, immutable');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; media-src 'self' blob:; connect-src 'self' https://0.peerjs.com wss://0.peerjs.com https://*.peerjs.com wss://*.peerjs.com;",
    );
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
  await mainWindow.loadURL(rendererUrl);
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('CompCtrl companion');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open CompCtrl', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus(); });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { mainWindow?.show(); mainWindow?.focus(); });
  app.whenReady().then(async () => {
    settings = readSettings();
    writeSettings(settings);
    registerIpc();
    startNativeBridge();
    configureJiggler(settings.jigglerEnabled);
    configureAutoStart(settings.autoStart);

    const appSession = session.defaultSession;
    appSession.setDisplayMediaRequestHandler(async (_request, callback) => {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      callback({ video: sources[0] });
    }, { useSystemPicker: false });
    appSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
      const requestingUrl = details.requestingUrl || '';
      const trusted = requestingUrl.startsWith('http://localhost:') || requestingUrl.startsWith('http://127.0.0.1:');
      callback(trusted && (permission === 'media' || permission === 'display-capture'));
    });

    createTray();
    await createWindow();
  });
}

app.on('before-quit', () => { isQuitting = true; });
app.on('will-quit', () => {
  if (jigglerTimer) clearInterval(jigglerTimer);
  nativeBridge?.kill();
  staticServer?.close();
});
