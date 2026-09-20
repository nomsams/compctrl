import { DICTATION_AUDIO_CHUNK_BYTES } from './dictation-transfer.ts';

const LOCAL_WHISPER_SAMPLE_RATE = 16_000;

function decodeBase64(value: string) {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function encodeBase64(bytes: Uint8Array) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return window.btoa(binary);
}

function joinBase64Chunks(chunks: string[]) {
  const decoded = chunks.map(decodeBase64);
  const length = decoded.reduce((total, chunk) => total + chunk.length, 0);
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of decoded) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}

export function encodeMonoPcm16Wav(samples: Float32Array, sampleRate = LOCAL_WHISPER_SAMPLE_RATE) {
  const wav = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(wav.buffer);
  const writeAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, wav.length - 8, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return wav;
}

function resampleToMono(buffer: AudioBuffer, targetRate = LOCAL_WHISPER_SAMPLE_RATE) {
  const length = Math.max(1, Math.round(buffer.duration * targetRate));
  const output = new Float32Array(length);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
  const ratio = buffer.sampleRate / targetRate;
  for (let index = 0; index < length; index += 1) {
    const sourcePosition = Math.min(buffer.length - 1, index * ratio);
    const lower = Math.floor(sourcePosition);
    const upper = Math.min(buffer.length - 1, lower + 1);
    const mix = sourcePosition - lower;
    let sample = 0;
    for (const channel of channels) sample += channel[lower] + (channel[upper] - channel[lower]) * mix;
    output[index] = sample / channels.length;
  }
  return output;
}

export async function recordingChunksToLocalWhisperWav(chunks: string[]) {
  if (!chunks.length) throw new Error('No audio was recorded.');
  const compressed = joinBase64Chunks(chunks);
  const OfflineAudioContextClass = window.OfflineAudioContext;
  if (!OfflineAudioContextClass) throw new Error('This computer cannot prepare audio for local Whisper.');
  // Offline decoding works on headless PCs and does not require a working
  // speaker/output device or an autoplay permission.
  const context = new OfflineAudioContextClass(1, 1, LOCAL_WHISPER_SAMPLE_RATE);
  try {
    const decoded = await context.decodeAudioData(compressed.buffer.slice(0));
    if (!decoded.length || decoded.duration > 95) throw new Error('The recording was empty or too long.');
    const wav = encodeMonoPcm16Wav(resampleToMono(decoded));
    const encoded: string[] = [];
    for (let offset = 0; offset < wav.length; offset += DICTATION_AUDIO_CHUNK_BYTES) {
      encoded.push(encodeBase64(wav.subarray(offset, offset + DICTATION_AUDIO_CHUNK_BYTES)));
    }
    return encoded;
  } catch (error) {
    if (error instanceof Error && /empty|too long|local Whisper/i.test(error.message)) throw error;
    throw new Error('The computer could not decode this phone recording for local Whisper.');
  }
}
