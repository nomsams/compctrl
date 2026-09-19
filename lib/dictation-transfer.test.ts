import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DICTATION_AUDIO_CHUNK_BYTES,
  DICTATION_SEND_INTERVAL_MS,
  encodeDictationChunks,
  uploadDictationAudio,
} from './dictation-transfer.ts';
import { MAX_DICTATION_CHUNK_LENGTH, isControllerMessage } from './protocol.ts';

const DICTATION_TEST_BYTES = DICTATION_AUDIO_CHUNK_BYTES * 3 + 17;

void test('creates mobile-safe dictation messages within protocol limits', () => {
  const audio = new Uint8Array(DICTATION_TEST_BYTES);
  audio.forEach((_, index) => { audio[index] = index % 251; });
  const chunks = encodeDictationChunks(audio);

  assert.equal(chunks.length, 4);
  assert.ok(chunks.every((chunk) => chunk.length <= MAX_DICTATION_CHUNK_LENGTH));
  assert.ok(chunks.every((data, index) => isControllerMessage({ type: 'dictation-chunk', id: 'dictation_test_123', index, data })));
});

void test('uploads chunks sequentially with pacing before the end marker', async () => {
  const messages: Array<{ type: string; index?: number }> = [];
  const pauses: number[] = [];
  let concurrentSends = 0;
  let maximumConcurrentSends = 0;

  const total = await uploadDictationAudio(
    new Uint8Array(DICTATION_AUDIO_CHUNK_BYTES * 2 + 7),
    'dictation_test_123',
    async (message) => {
      concurrentSends += 1;
      maximumConcurrentSends = Math.max(maximumConcurrentSends, concurrentSends);
      await Promise.resolve();
      messages.push(message);
      concurrentSends -= 1;
      return true;
    },
    async (milliseconds) => { pauses.push(milliseconds); },
  );

  assert.equal(total, 3);
  assert.equal(maximumConcurrentSends, 1);
  assert.deepEqual(messages.map((message) => message.type), ['dictation-chunk', 'dictation-chunk', 'dictation-chunk', 'dictation-end']);
  assert.deepEqual(messages.slice(0, 3).map((message) => message.index), [0, 1, 2]);
  assert.deepEqual(pauses, [DICTATION_SEND_INTERVAL_MS, DICTATION_SEND_INTERVAL_MS]);
});
