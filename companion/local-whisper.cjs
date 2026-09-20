const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WHISPER_BUILD = 'b5130';
const WHISPER_ARCHIVE_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_BUILD}/whisper-bin-x64.zip`;
const WHISPER_ARCHIVE_SHA256 = 'f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c';
const WHISPER_MODEL_REVISION = '98aa99a0a9db05ae2342309f5096248665f7cba3';
const WHISPER_MODEL_NAME = 'ggml-tiny-q5_1.bin';
const WHISPER_MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_MODEL_REVISION}/${WHISPER_MODEL_NAME}`;
const WHISPER_MODEL_SHA256 = '818710568da3ca15689e31a743197b520007872ff9576237bda97bd1b469c3d7';
const WHISPER_MODEL_SIZE_MB = 32.2;
const LOCAL_WHISPER_DIRECTORY = 'local-whisper';
const MAX_LOCAL_AUDIO_BYTES = 20 * 1024 * 1024;

function localWhisperPaths(userDataPath) {
  const root = path.join(userDataPath, LOCAL_WHISPER_DIRECTORY);
  return {
    root,
    executable: path.join(root, 'whisper-cli.exe'),
    model: path.join(root, WHISPER_MODEL_NAME),
    manifest: path.join(root, 'compctrl-manifest.json'),
  };
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let read = 0;
    do {
      read = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (read) hash.update(buffer.subarray(0, read));
    } while (read);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function localWhisperStatus(userDataPath, verifyModel = false) {
  const paths = localWhisperPaths(userDataPath);
  let installed = fs.existsSync(paths.executable) && fs.existsSync(paths.model) && fs.existsSync(paths.manifest);
  if (installed) {
    try {
      const manifest = JSON.parse(fs.readFileSync(paths.manifest, 'utf8'));
      installed = manifest.build === WHISPER_BUILD
        && manifest.modelRevision === WHISPER_MODEL_REVISION
        && manifest.modelSha256 === WHISPER_MODEL_SHA256;
      if (installed && verifyModel) installed = sha256File(paths.model) === WHISPER_MODEL_SHA256;
    } catch {
      installed = false;
    }
  }
  return {
    installed,
    modelName: 'Whisper tiny multilingual Q5_1',
    modelSizeMb: WHISPER_MODEL_SIZE_MB,
    build: WHISPER_BUILD,
  };
}

async function downloadVerified(url, destination, expectedSha256) {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(180_000),
    headers: { 'User-Agent': 'CompCtrl local Whisper installer' },
  });
  if (!response.ok) throw new Error(`Download failed with status ${response.status}.`);
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > 100 * 1024 * 1024) throw new Error('The local Whisper download was unexpectedly large.');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 100 * 1024 * 1024) throw new Error('The local Whisper download was invalid.');
  const actualSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actualSha256 !== expectedSha256) throw new Error('The local Whisper download failed its integrity check.');
  fs.writeFileSync(destination, bytes, { mode: 0o600 });
}

function runProcess(executable, args, options = {}, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
    let stdout = '';
    let stderr = '';
    const append = (target, chunk) => `${target}${chunk}`.slice(-16_384);
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Local Whisper timed out. Try a shorter recording.'));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Local Whisper exited with code ${code ?? 'unknown'}. ${stderr.trim()}`.slice(0, 512)));
    });
  });
}

async function installLocalWhisper(userDataPath) {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('The built-in local Whisper installer currently supports 64-bit Windows.');
  }
  const finalPaths = localWhisperPaths(userDataPath);
  const stagingRoot = fs.mkdtempSync(path.join(userDataPath, 'local-whisper-install-'));
  const archivePath = path.join(stagingRoot, 'whisper.zip');
  const backupRoot = path.join(userDataPath, `local-whisper-backup-${crypto.randomBytes(8).toString('hex')}`);
  let previousMoved = false;
  try {
    await downloadVerified(WHISPER_ARCHIVE_URL, archivePath, WHISPER_ARCHIVE_SHA256);
    await runProcess('tar.exe', ['-xf', archivePath, '-C', stagingRoot], {}, 60_000);
    const releaseDirectory = path.join(stagingRoot, 'Release');
    const executable = path.join(releaseDirectory, 'whisper-cli.exe');
    if (!fs.existsSync(executable)) throw new Error('The verified Whisper archive did not contain whisper-cli.exe.');
    const modelPath = path.join(releaseDirectory, WHISPER_MODEL_NAME);
    await downloadVerified(WHISPER_MODEL_URL, modelPath, WHISPER_MODEL_SHA256);
    fs.writeFileSync(path.join(releaseDirectory, 'compctrl-manifest.json'), JSON.stringify({
      build: WHISPER_BUILD,
      archiveSha256: WHISPER_ARCHIVE_SHA256,
      modelRevision: WHISPER_MODEL_REVISION,
      modelSha256: WHISPER_MODEL_SHA256,
      installedAt: new Date().toISOString(),
    }, null, 2), { encoding: 'utf8', mode: 0o600 });
    if (fs.existsSync(finalPaths.root)) {
      fs.renameSync(finalPaths.root, backupRoot);
      previousMoved = true;
    }
    try {
      fs.renameSync(releaseDirectory, finalPaths.root);
    } catch (error) {
      if (previousMoved && !fs.existsSync(finalPaths.root) && fs.existsSync(backupRoot)) {
        fs.renameSync(backupRoot, finalPaths.root);
        previousMoved = false;
      }
      throw error;
    }
    if (previousMoved && fs.existsSync(backupRoot)) {
      try { fs.rmSync(backupRoot, { recursive: true, force: true }); } catch { /* New verified install remains usable. */ }
      previousMoved = false;
    }
    return localWhisperStatus(userDataPath, true);
  } finally {
    if (fs.existsSync(stagingRoot)) fs.rmSync(stagingRoot, { recursive: true, force: true });
    if (previousMoved && fs.existsSync(backupRoot) && !fs.existsSync(finalPaths.root)) {
      fs.renameSync(backupRoot, finalPaths.root);
    }
  }
}

function removeLocalWhisper(userDataPath) {
  const paths = localWhisperPaths(userDataPath);
  if (path.resolve(path.dirname(paths.root)) !== path.resolve(userDataPath)) throw new Error('Refusing to remove an unexpected path.');
  if (fs.existsSync(paths.root)) fs.rmSync(paths.root, { recursive: true, force: true });
  return localWhisperStatus(userDataPath);
}

function isPcmWav(audio) {
  return Buffer.isBuffer(audio)
    && audio.length >= 44
    && audio.subarray(0, 4).toString('ascii') === 'RIFF'
    && audio.subarray(8, 12).toString('ascii') === 'WAVE'
    && audio.subarray(12, 16).toString('ascii') === 'fmt '
    && audio.readUInt16LE(20) === 1
    && audio.readUInt16LE(22) === 1
    && audio.readUInt32LE(24) === 16_000
    && audio.readUInt16LE(34) === 16;
}

function cleanWhisperTranscript(value) {
  return String(value)
    .replace(/[[(](?:blank[_ ]audio|silence|music|no speech|inaudible)[\])]/giu, '')
    .trim();
}

async function transcribeLocalWhisper(userDataPath, audio) {
  if (!isPcmWav(audio) || audio.length > MAX_LOCAL_AUDIO_BYTES) {
    throw new Error('Local Whisper received invalid audio.');
  }
  const status = localWhisperStatus(userDataPath, true);
  if (!status.installed) throw new Error('Install the local Whisper model in the companion first.');
  const paths = localWhisperPaths(userDataPath);
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'compctrl-whisper-'));
  const inputPath = path.join(temporaryDirectory, 'dictation.wav');
  const outputPath = path.join(temporaryDirectory, 'transcript');
  try {
    fs.writeFileSync(inputPath, audio, { mode: 0o600 });
    const threads = Math.max(1, Math.min(4, os.availableParallelism?.() ?? os.cpus().length ?? 2));
    await runProcess(paths.executable, [
      '-m', paths.model,
      '-f', inputPath,
      '-l', 'auto',
      '-t', String(threads),
      '-otxt',
      '-of', outputPath,
      '-nt',
      '-np',
      '--no-gpu',
    ], { cwd: paths.root }, 150_000);
    const transcriptFile = `${outputPath}.txt`;
    if (!fs.existsSync(transcriptFile)) throw new Error('Local Whisper did not produce a transcript.');
    const transcript = cleanWhisperTranscript(fs.readFileSync(transcriptFile, 'utf8'));
    if (!transcript) throw new Error('No speech was detected.');
    if (transcript.length > 16_384) throw new Error('The transcript was too long to insert safely.');
    return transcript;
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

module.exports = {
  MAX_LOCAL_AUDIO_BYTES,
  WHISPER_ARCHIVE_SHA256,
  WHISPER_BUILD,
  WHISPER_MODEL_NAME,
  WHISPER_MODEL_SHA256,
  cleanWhisperTranscript,
  installLocalWhisper,
  isPcmWav,
  localWhisperPaths,
  localWhisperStatus,
  removeLocalWhisper,
  transcribeLocalWhisper,
};
