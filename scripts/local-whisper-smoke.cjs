const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  installLocalWhisper,
  localWhisperStatus,
  transcribeLocalWhisper,
} = require('../companion/local-whisper.cjs');

function oneSecondOfSilence() {
  const samples = 16_000;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16_000, 24);
  wav.writeUInt32LE(32_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(samples * 2, 40);
  return wav;
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compctrl-local-whisper-smoke-'));
  if (path.dirname(root) !== path.resolve(os.tmpdir())) throw new Error('Unsafe local Whisper smoke-test path.');
  try {
    const installed = await installLocalWhisper(root);
    if (!installed.installed || !localWhisperStatus(root, true).installed) {
      throw new Error('Local Whisper did not pass its post-install integrity check.');
    }
    let inference = 'completed';
    try {
      await transcribeLocalWhisper(root, oneSecondOfSilence());
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'No speech was detected.') throw error;
      inference = 'no-speech-detected';
    }
    process.stdout.write(`${JSON.stringify({ installed: true, integrity: true, inference })}\n`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
