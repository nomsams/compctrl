import assert from 'node:assert/strict';
import test from 'node:test';

import { encodeMonoPcm16Wav } from './audio-wav.ts';

void test('encodes the local Whisper input as 16 kHz mono PCM WAV', () => {
  const wav = encodeMonoPcm16Wav(new Float32Array([-1, -0.5, 0, 0.5, 1]));
  const view = new DataView(wav.buffer);
  assert.equal(new TextDecoder().decode(wav.subarray(0, 4)), 'RIFF');
  assert.equal(new TextDecoder().decode(wav.subarray(8, 12)), 'WAVE');
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16_000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 10);
  assert.equal(view.getInt16(44, true), -32_768);
  assert.equal(view.getInt16(52, true), 32_767);
});
