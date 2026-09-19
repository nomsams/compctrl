import type { DictationMessage } from './protocol';

// Keeping the encoded payload near 16 KiB avoids the large-message edge cases
// seen in mobile WebRTC data channels. The short pause also keeps bulk audio
// below the host's anti-flood limit while preserving ordered delivery.
export const DICTATION_AUDIO_CHUNK_BYTES = 12 * 1024;
export const DICTATION_SEND_INTERVAL_MS = 8;

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

type DictationSender = (message: DictationMessage) => boolean | void | Promise<boolean | void>;

export async function uploadDictationAudio(
  audio: Uint8Array,
  id: string,
  send: DictationSender,
  pause: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
) {
  const chunks = encodeDictationChunks(audio);
  if (!chunks.length) throw new Error('No audio was recorded.');

  for (let index = 0; index < chunks.length; index += 1) {
    const result = await send({ type: 'dictation-chunk', id, index, data: chunks[index] });
    if (result === false) throw new Error('The computer connection was lost.');
    if (index + 1 < chunks.length) await pause(DICTATION_SEND_INTERVAL_MS);
  }

  const result = await send({ type: 'dictation-end', id, totalChunks: chunks.length });
  if (result === false) throw new Error('The computer connection was lost.');
  return chunks.length;
}
