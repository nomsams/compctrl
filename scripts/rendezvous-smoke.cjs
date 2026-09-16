const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const profilePath = path.resolve(os.tmpdir(), 'compctrl-rendezvous-smoke');
if (path.dirname(profilePath) !== path.resolve(os.tmpdir())) throw new Error('Unsafe rendezvous smoke-test profile path.');
fs.rmSync(profilePath, { recursive: true, force: true });
app.setPath('userData', profilePath);

process.once('exit', () => {
  try { fs.rmSync(profilePath, { recursive: true, force: true }); } catch { /* Chromium can retain cache handles until process teardown on Windows. */ }
});

const timeout = (milliseconds) => new Promise((_, reject) => {
  setTimeout(() => reject(new Error(`Rendezvous smoke test timed out after ${milliseconds} ms.`)), milliseconds);
});

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  try {
    await window.loadFile(path.join(__dirname, 'rendezvous-smoke.html'));
    const result = await Promise.race([
      window.webContents.executeJavaScript('window.runRendezvousSmokeTest()', true),
      timeout(45_000),
    ]);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    app.exit(0);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    app.exit(1);
  }
});
