const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  WHISPER_ARCHIVE_SHA256,
  WHISPER_MODEL_SHA256,
  cleanWhisperTranscript,
  isPcmWav,
  localWhisperPaths,
  localWhisperStatus,
} = require('./local-whisper.cjs');

function minimalWhisperWav() {
  const wav = Buffer.alloc(46);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(38, 4);
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
  wav.writeUInt32LE(2, 40);
  return wav;
}

test('local Whisper is opt-in and absent from a fresh profile', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compctrl-local-whisper-test-'));
  try {
    const paths = localWhisperPaths(root);
    assert.equal(path.dirname(paths.root), root);
    assert.equal(localWhisperStatus(root).installed, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pins full SHA-256 digests for both executable archive and model', () => {
  assert.match(WHISPER_ARCHIVE_SHA256, /^[a-f0-9]{64}$/);
  assert.match(WHISPER_MODEL_SHA256, /^[a-f0-9]{64}$/);
});

test('accepts only the PCM format required by local Whisper', () => {
  assert.equal(isPcmWav(minimalWhisperWav()), true);
  const stereo = minimalWhisperWav();
  stereo.writeUInt16LE(2, 22);
  assert.equal(isPcmWav(stereo), false);
  const wrongRate = minimalWhisperWav();
  wrongRate.writeUInt32LE(48_000, 24);
  assert.equal(isPcmWav(wrongRate), false);
});

test('does not insert Whisper non-speech markers into the focused field', () => {
  assert.equal(cleanWhisperTranscript('[BLANK_AUDIO]'), '');
  assert.equal(cleanWhisperTranscript('(silence)'), '');
  assert.equal(cleanWhisperTranscript('Hello there. [Music]'), 'Hello there.');
});
