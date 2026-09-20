import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DICTATION_AUDIO_CHUNK_BYTES,
  DICTATION_SEND_INTERVAL_MS,
  MAX_DICTATION_AUDIO_BYTES,
  PEERJS_JSON_MESSAGE_LIMIT_BYTES,
  encodeDictationChunks,
  serializedDictationMessageBytes,
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

void test('keeps serialized audio messages below the PeerJS JSON MTU', () => {
  const id = 'x'.repeat(80);
  const safeChunk = encodeDictationChunks(new Uint8Array(DICTATION_AUDIO_CHUNK_BYTES))[0];
  const safeBytes = serializedDictationMessageBytes({ type: 'dictation-chunk', id, index: 2_046, data: safeChunk });
  assert.ok(safeBytes < PEERJS_JSON_MESSAGE_LIMIT_BYTES);

  const oldChunk = 'A'.repeat(16_384);
  const oldBytes = serializedDictationMessageBytes({ type: 'dictation-chunk', id, index: 0, data: oldChunk });
  assert.ok(oldBytes >= PEERJS_JSON_MESSAGE_LIMIT_BYTES, 'The regression sample must reproduce PeerJS message-too-big.');
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

void test('cancels an in-flight upload without sending the end marker', async () => {
  const controller = new AbortController();
  const messageTypes: string[] = [];
  await assert.rejects(
    uploadDictationAudio(
      new Uint8Array(DICTATION_AUDIO_CHUNK_BYTES * 2),
      'dictation_test_123',
      (message) => {
        messageTypes.push(message.type);
        controller.abort();
        return true;
      },
      async () => {},
      controller.signal,
    ),
    /cancelled/,
  );
  assert.deepEqual(messageTypes, ['dictation-chunk']);
});

void test('rejects recordings that cannot fit within the protocol chunk count', async () => {
  await assert.rejects(
    uploadDictationAudio(new Uint8Array(MAX_DICTATION_AUDIO_BYTES + 1), 'dictation_test_123', () => true),
    /too large/,
  );
});
