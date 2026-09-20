const {
  app,
  BrowserWindow,
  clipboard,
  Menu,
  Tray,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  powerSaveBlocker,
  safeStorage,
  screen,
  session,
  shell,
} = require('electron');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {
  DEFAULT_SECURITY_SETTINGS,
  TRUSTED_TOKEN_DELIVERY_GRACE_MS,
  isAuthorizedDisplayMediaPermission,
  isTrustedDeviceFresh,
  normalizeSecuritySettings,
  trustedDeviceExpiry,
} = require('./security.cjs');
const { generateTrustedPeerId, isStoredTrustedPeerId } = require('./peer-identity.cjs');
const {
  installLocalWhisper,
  localWhisperStatus,
  removeLocalWhisper,
  transcribeLocalWhisper,
} = require('./local-whisper.cjs');

// Desktop capture and WebRTC encoding should use the GPU by default. Forcing
// software rendering can produce valid local pixels but black encoded frames
// on some Windows graphics stacks. Keep an explicit troubleshooting escape
// hatch without degrading every installation.
if (process.argv.includes('--software-rendering')) app.disableHardwareAcceleration();

// Chromium automatically enables Windows Graphics Capture for full-screen
// capture on Windows 11 24H2. Electron/Chromium have open WGC failures on some
// adapters, so use the mature DXGI/GDI fallback for the monitor stream.
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('disable-features', 'WebRtcAllowWgcScreenCapturer');
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 12;
const JIGGLE_INTERVAL_MS = 30_000;
const DISPLAY_OFF_REASSERT_MS = 2_000;
const DISPLAY_CAPTURE_AUTHORIZATION_MS = 5_000;
const GROQ_TRANSCRIPTION_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_WHISPER_MODEL = 'whisper-large-v3-turbo';
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const MAX_NATIVE_QUEUE = 512;
const MAX_CLIPBOARD_TEXT_LENGTH = 64 * 1024;
const MAX_TRUSTED_DEVICES = 24;
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
let localWhisperInstallPromise = null;
let trustedRendererOrigin = '';
let displayCaptureAuthorization = null;

function generateCode() {
  return Array.from(crypto.randomBytes(CODE_LENGTH), (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
}

function normalizeTrustedDevices(value) {
  if (!Array.isArray(value)) return [];
  const now = Date.now();
  return value.slice(0, MAX_TRUSTED_DEVICES).flatMap((entry) => {
    if (
      !entry || typeof entry !== 'object'
      || typeof entry.id !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(entry.id)
      || typeof entry.tokenProtected !== 'string' || entry.tokenProtected.length > 1024
    ) return [];
    const device = {
      id: entry.id,
      name: typeof entry.name === 'string' ? entry.name.replace(/[^\p{L}\p{N} ._'()-]/gu, '').slice(0, 48) || 'Phone' : 'Phone',
      tokenProtected: entry.tokenProtected,
      createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : Date.now(),
      lastSeenAt: Number.isFinite(entry.lastSeenAt) ? entry.lastSeenAt : Date.now(),
      expiresAt: trustedDeviceExpiry(entry),
      previousTokenProtected: typeof entry.previousTokenProtected === 'string' && entry.previousTokenProtected.length <= 1024
        ? entry.previousTokenProtected
        : '',
      previousTokenValidUntil: Number.isFinite(entry.previousTokenValidUntil) ? entry.previousTokenValidUntil : 0,
    };
    return isTrustedDeviceFresh(device, now) ? [device] : [];
  });
}

function trustedDeviceSummaries() {
  return [...(settings?.trustedDevices ?? [])]
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .map(({ id, name, createdAt, lastSeenAt, expiresAt }) => ({ id, name, createdAt, lastSeenAt, expiresAt }));
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
    transcriptionProvider: 'groq',
    groqApiKeyProtected: '',
    trustedPeerId: generateTrustedPeerId(),
    trustedDevices: [],
    security: { ...DEFAULT_SECURITY_SETTINGS },
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
      transcriptionProvider: stored.transcriptionProvider === 'local' ? 'local' : 'groq',
      groqApiKeyProtected: typeof stored.groqApiKeyProtected === 'string' ? stored.groqApiKeyProtected : '',
      trustedPeerId: isStoredTrustedPeerId(stored.trustedPeerId)
        ? stored.trustedPeerId
        : defaults.trustedPeerId,
      trustedDevices: normalizeTrustedDevices(stored.trustedDevices),
      security: normalizeSecuritySettings(stored.security),
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

function issueTrustedDevice(deviceId, deviceName) {
  if (!settings.security.trustedReconnectEnabled) {
    throw new Error('Trusted reconnect is disabled in the companion.');
  }
  if (!settings.security.trustedReconnectEnabled) throw new Error('Trusted reconnect is disabled.');
  if (typeof deviceId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(deviceId)) {
    throw new Error('The controller supplied an invalid device identity.');
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Windows credential encryption is unavailable, so trusted reconnect cannot be enabled.');
  }
  const now = Date.now();
  const name = typeof deviceName === 'string'
    ? deviceName.replace(/[^\p{L}\p{N} ._'()-]/gu, '').slice(0, 48) || 'Phone'
    : 'Phone';
  const token = crypto.randomBytes(32).toString('base64url');
  const nextDevice = {
    id: deviceId,
    name,
    tokenProtected: safeStorage.encryptString(token).toString('base64'),
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + 30 * 24 * 60 * 60 * 1000,
    previousTokenProtected: '',
    previousTokenValidUntil: 0,
  };
  settings.trustedDevices = [
    nextDevice,
    ...settings.trustedDevices.filter((device) => device.id !== deviceId),
  ].slice(0, MAX_TRUSTED_DEVICES);
  writeSettings(settings);
  return { deviceId, hostId: settings.trustedPeerId, token, expiresAt: nextDevice.expiresAt, devices: trustedDeviceSummaries() };
}

function verifyTrustedDevice(deviceId, challenge, nonce, proof) {
  if (!settings.security.trustedReconnectEnabled) return { ok: false, devices: trustedDeviceSummaries() };
  if (!settings.security.trustedReconnectEnabled) return { ok: false, devices: trustedDeviceSummaries() };
  if (
    typeof deviceId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(deviceId)
    || typeof challenge !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(challenge)
    || typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce)
    || typeof proof !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(proof)
  ) return { ok: false, devices: trustedDeviceSummaries() };
  const device = settings.trustedDevices.find((candidate) => candidate.id === deviceId);
  if (!device || !safeStorage.isEncryptionAvailable()) return { ok: false, devices: trustedDeviceSummaries() };
  if (!isTrustedDeviceFresh(device)) {
    settings.trustedDevices = settings.trustedDevices.filter((candidate) => candidate.id !== deviceId);
    writeSettings(settings);
    return { ok: false, devices: trustedDeviceSummaries() };
  }
  try {
    const actualBuffer = Buffer.from(proof);
    const candidates = [device.tokenProtected];
    if (device.previousTokenProtected && Date.now() <= device.previousTokenValidUntil) {
      candidates.push(device.previousTokenProtected);
    }
    let matchedProtectedToken = '';
    for (const protectedToken of candidates) {
      const token = safeStorage.decryptString(Buffer.from(protectedToken, 'base64'));
      const expected = crypto.createHmac('sha256', token)
        .update(`compctrl-trusted-v1:${challenge}:${nonce}`)
        .digest('base64url');
      const expectedBuffer = Buffer.from(expected);
      if (expectedBuffer.length === actualBuffer.length && crypto.timingSafeEqual(expectedBuffer, actualBuffer)) {
        matchedProtectedToken = protectedToken;
        break;
      }
    }
    if (!matchedProtectedToken) {
      return { ok: false, devices: trustedDeviceSummaries() };
    }
    const replacementToken = crypto.randomBytes(32).toString('base64url');
    device.tokenProtected = safeStorage.encryptString(replacementToken).toString('base64');
    device.previousTokenProtected = matchedProtectedToken;
    device.previousTokenValidUntil = Date.now() + TRUSTED_TOKEN_DELIVERY_GRACE_MS;
    device.lastSeenAt = Date.now();
    device.expiresAt = trustedDeviceExpiry(device);
    writeSettings(settings);
    return {
      ok: true,
      deviceId,
      hostId: settings.trustedPeerId,
      token: replacementToken,
      expiresAt: device.expiresAt,
      devices: trustedDeviceSummaries(),
    };
  } catch {
    return { ok: false, devices: trustedDeviceSummaries() };
  }
}

function revokeTrustedDevice(deviceId) {
  if (typeof deviceId !== 'string') return trustedDeviceSummaries();
  settings.trustedDevices = settings.trustedDevices.filter((device) => device.id !== deviceId);
  writeSettings(settings);
  return trustedDeviceSummaries();
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
  const local = settings.transcriptionProvider === 'local';
  const allowedMimeTypes = local
    ? new Set(['audio/wav'])
    : new Set(['audio/webm', 'audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg', 'audio/ogg;codecs=opus']);
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
    if (local) return await transcribeLocalWhisper(app.getPath('userData'), audio);
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
    return Boolean(trustedRendererOrigin) && url.origin === trustedRendererOrigin;
  } catch {
    return false;
  }
}

function activeDisplayCaptureAuthorization() {
  if (!displayCaptureAuthorization || displayCaptureAuthorization.expiresAt < Date.now()) {
    displayCaptureAuthorization = null;
    return null;
  }
  return displayCaptureAuthorization;
}

function isTrustedMainRenderer(webContents, requestingUrl) {
  return Boolean(
    mainWindow && !mainWindow.isDestroyed()
    && webContents === mainWindow.webContents
    && isTrustedRendererUrl(webContents.getURL())
    && isTrustedRendererUrl(requestingUrl),
  );
}

function isAllowedExternalUrl(value) {
  try {
    const url = new URL(value);
    if (url.origin === 'https://console.groq.com') return true;
    const controller = new URL(settings.controllerUrl);
    return url.origin === controller.origin && url.pathname.startsWith(controller.pathname);
  } catch {
    return false;
  }
}

function panicLockdown() {
  if (!settings) return;
  displayCaptureAuthorization = null;
  settings.security = { ...settings.security, remoteInputEnabled: false, trustedReconnectEnabled: false };
  settings.trustedDevices = [];
  settings.pairingCode = generateCode();
  settings.trustedPeerId = generateTrustedPeerId();
  settings.jigglerEnabled = false;
  configureJiggler(false);
  setScreenBlanked(false);
  sendNative({ type: 'release-all' });
  writeSettings(settings);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('compctrl:lockdown', {
      pairingCode: settings.pairingCode,
      trustedPeerId: settings.trustedPeerId,
      security: settings.security,
    });
    mainWindow.show();
    mainWindow.focus();
  }
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open CompCtrl', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    ...(screenBlanked ? [{ label: 'Turn local screens back on', click: () => setScreenBlanked(false) }] : []),
    { label: 'Emergency lockdown', click: panicLockdown },
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
    const localWhisper = localWhisperStatus(app.getPath('userData'), true);
    return {
      pairingCode: settings.pairingCode,
      controllerUrl: settings.controllerUrl,
      jigglerEnabled: settings.jigglerEnabled,
      autoStart: settings.autoStart,
      groqKeyConfigured: hasGroqApiKey(),
      transcriptionProvider: settings.transcriptionProvider,
      transcriptionReady: settings.transcriptionProvider === 'local' ? localWhisper.installed : hasGroqApiKey(),
      localWhisper,
      trustedPeerId: settings.trustedPeerId,
      trustedDevices: trustedDeviceSummaries(),
      security: settings.security,
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
    if (changes?.transcriptionProvider === 'groq' || changes?.transcriptionProvider === 'local') {
      if (changes.transcriptionProvider === 'local' && !localWhisperStatus(app.getPath('userData'), true).installed) {
        throw new Error('Install the local Whisper model before selecting it.');
      }
      next.transcriptionProvider = changes.transcriptionProvider;
    }
    if (changes?.security && typeof changes.security === 'object') {
      next.security = normalizeSecuritySettings({ ...next.security, ...changes.security });
      if (!next.security.trustedReconnectEnabled) next.trustedDevices = [];
      if (!next.security.remoteInputEnabled) sendNative({ type: 'release-all' });
    }
    settings = next;
    writeSettings(settings);
  });

  ipcMain.handle('compctrl:dispatch', (event, message) => {
    assertTrustedIpc(event);
    if (settings.security.remoteInputEnabled && isNativeMessage(message)) sendNative(message);
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

  ipcMain.handle('compctrl:authorize-display-capture', (event, audioRequested) => {
    assertTrustedIpc(event);
    if (typeof audioRequested !== 'boolean') throw new Error('Invalid display-capture authorization request.');
    if (audioRequested && !settings.security.systemAudioEnabled) throw new Error('System audio is disabled.');
    displayCaptureAuthorization = {
      audioRequested,
      expiresAt: Date.now() + DISPLAY_CAPTURE_AUTHORIZATION_MS,
    };
  });

  ipcMain.handle('compctrl:system-action', (event, action) => {
    assertTrustedIpc(event);
    if (settings.security.powerActionsEnabled && (action === 'restart' || action === 'shutdown')) runSystemAction(action);
  });

  ipcMain.handle('compctrl:set-groq-api-key', (event, value) => {
    assertTrustedIpc(event);
    return setGroqApiKey(value);
  });

  ipcMain.handle('compctrl:install-local-whisper', async (event) => {
    assertTrustedIpc(event);
    if (!localWhisperInstallPromise) {
      localWhisperInstallPromise = installLocalWhisper(app.getPath('userData'))
        .finally(() => { localWhisperInstallPromise = null; });
    }
    return localWhisperInstallPromise;
  });

  ipcMain.handle('compctrl:remove-local-whisper', (event) => {
    assertTrustedIpc(event);
    if (settings.transcriptionProvider === 'local') {
      settings.transcriptionProvider = 'groq';
      writeSettings(settings);
    }
    return removeLocalWhisper(app.getPath('userData'));
  });

  ipcMain.handle('compctrl:transcribe-audio', (event, chunks, audioMimeType) => {
    assertTrustedIpc(event);
    if (!settings.security.dictationEnabled) throw new Error('Voice dictation is disabled.');
    return transcribeAudio(chunks, audioMimeType);
  });

  ipcMain.handle('compctrl:issue-trusted-device', (event, deviceId, deviceName) => {
    assertTrustedIpc(event);
    return issueTrustedDevice(deviceId, deviceName);
  });

  ipcMain.handle('compctrl:verify-trusted-device', (event, deviceId, challenge, nonce, proof) => {
    assertTrustedIpc(event);
    return verifyTrustedDevice(deviceId, challenge, nonce, proof);
  });

  ipcMain.handle('compctrl:revoke-trusted-device', (event, deviceId) => {
    assertTrustedIpc(event);
    return revokeTrustedDevice(deviceId);
  });

  ipcMain.handle('compctrl:panic-lockdown', (event) => {
    assertTrustedIpc(event);
    panicLockdown();
  });

  ipcMain.handle('compctrl:read-clipboard', (event) => {
    assertTrustedIpc(event);
    if (!settings.security.clipboardEnabled) throw new Error('Clipboard access is disabled.');
    return clipboard.readText().slice(0, MAX_CLIPBOARD_TEXT_LENGTH);
  });

  ipcMain.handle('compctrl:write-clipboard', (event, value) => {
    assertTrustedIpc(event);
    if (!settings.security.clipboardEnabled) throw new Error('Clipboard access is disabled.');
    if (typeof value !== 'string' || value.length > MAX_CLIPBOARD_TEXT_LENGTH) throw new Error('Clipboard text is too large.');
    clipboard.writeText(value);
  });
}

function mimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
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
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
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
  trustedRendererOrigin = new URL(rendererUrl).origin;

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
      devTools: isDevelopment,
      backgroundThrottling: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  // Do not enable BrowserWindow content protection here. On Windows it marks
  // this process as excluded from capture, and some Chromium/Windows capture
  // backends return an entirely black monitor stream when the same process is
  // also the desktop capturer. Pairing details are hidden by the renderer as
  // soon as a controller authenticates instead.

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
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
    appSession.setDisplayMediaRequestHandler(async (request, callback) => {
      const authorization = activeDisplayCaptureAuthorization();
      const trustedFrame = Boolean(
        request.frame && mainWindow && !mainWindow.isDestroyed()
        && request.frame.top === mainWindow.webContents.mainFrame,
      );
      if (
        !authorization || !trustedFrame || !isTrustedRendererUrl(request.securityOrigin)
        || !request.videoRequested || request.audioRequested !== authorization.audioRequested
      ) {
        displayCaptureAuthorization = null;
        callback(null);
        return;
      }
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
        const primaryDisplayId = String(screen.getPrimaryDisplay().id);
        const source = sources.find((candidate) => String(candidate.display_id) === primaryDisplayId)
          ?? sources.find((candidate) => Boolean(candidate.display_id))
          ?? sources[0];
        callback(source
          ? { video: source, ...(request.audioRequested ? { audio: 'loopback' } : {}) }
          : null);
      } catch (error) {
        console.error('Could not enumerate desktop capture sources:', error);
        callback(null);
      } finally {
        displayCaptureAuthorization = null;
      }
    }, { useSystemPicker: false });
    appSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
      const requestingUrl = details?.requestingUrl || webContents?.getURL?.() || '';
      callback(
        isTrustedMainRenderer(webContents, requestingUrl)
        && isAuthorizedDisplayMediaPermission(permission, details, Boolean(activeDisplayCaptureAuthorization())),
      );
    });
    appSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
      const requestingUrl = details?.requestingUrl || requestingOrigin || details?.securityOrigin || '';
      return isTrustedMainRenderer(webContents, requestingUrl)
        && isAuthorizedDisplayMediaPermission(permission, details, Boolean(activeDisplayCaptureAuthorization()));
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
    const lockdownShortcutRegistered = globalShortcut.register(
      'CommandOrControl+Alt+Shift+F11',
      panicLockdown,
    );
    if (!lockdownShortcutRegistered) {
      console.warn('The emergency lockdown shortcut Ctrl+Alt+Shift+F11 is already in use.');
    }
  });
}

app.on('before-quit', () => {
  displayCaptureAuthorization = null;
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
