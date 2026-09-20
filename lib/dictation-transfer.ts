import { MAX_DICTATION_CHUNKS, type DictationMessage } from './protocol.ts';

// PeerJS's JSON serializer rejects an encoded message at 16,300 bytes. Base64
// expands data by 4/3 and JSON adds metadata, so keep ample headroom for the
// longest valid dictation id and index instead of aiming at that boundary.
export const PEERJS_JSON_MESSAGE_LIMIT_BYTES = 16_300;
export const DICTATION_AUDIO_CHUNK_BYTES = 8 * 1024;
export const DICTATION_SEND_INTERVAL_MS = 20;
export const MAX_DICTATION_AUDIO_BYTES = DICTATION_AUDIO_CHUNK_BYTES * MAX_DICTATION_CHUNKS;

function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function encodeDictationChunks(audio: Uint8Array) {
  const chunks: string[] = [];
  for (let offset = 0; offset < audio.length; offset += DICTATION_AUDIO_CHUNK_BYTES) {
    chunks.push(bytesToBase64(audio.subarray(offset, Math.min(audio.length, offset + DICTATION_AUDIO_CHUNK_BYTES))));
  }
  return chunks;
}

export function serializedDictationMessageBytes(message: DictationMessage) {
  return new TextEncoder().encode(JSON.stringify(message)).byteLength;
}

type DictationSender = (message: DictationMessage) => boolean | void | Promise<boolean | void>;

export async function uploadDictationAudio(
  audio: Uint8Array,
  id: string,
  send: DictationSender,
  pause: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  signal?: AbortSignal,
) {
  if (audio.length > MAX_DICTATION_AUDIO_BYTES) throw new Error('Recording is too large. Keep dictation under 90 seconds.');
  const chunks = encodeDictationChunks(audio);
  if (!chunks.length) throw new Error('No audio was recorded.');

  for (let index = 0; index < chunks.length; index += 1) {
    if (signal?.aborted) throw new Error('Voice upload was cancelled.');
    const message = { type: 'dictation-chunk', id, index, data: chunks[index] } satisfies DictationMessage;
    if (serializedDictationMessageBytes(message) >= PEERJS_JSON_MESSAGE_LIMIT_BYTES) {
      throw new Error('A voice chunk exceeded the safe connection limit.');
    }
    const result = await send(message);
    if (result === false) throw new Error('The computer connection was lost.');
    if (index + 1 < chunks.length) await pause(DICTATION_SEND_INTERVAL_MS);
  }

  if (signal?.aborted) throw new Error('Voice upload was cancelled.');
  const result = await send({ type: 'dictation-end', id, totalChunks: chunks.length });
  if (result === false) throw new Error('The computer connection was lost.');
  return chunks.length;
}
