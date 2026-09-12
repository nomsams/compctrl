export const PROTOCOL_VERSION = 3;
export const MIN_COMPATIBLE_PROTOCOL_VERSION = 2;
export const CODE_LENGTH = 12;
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const MAX_DICTATION_CHUNK_LENGTH = 64 * 1024;
export const MAX_TEXT_LENGTH = 8 * 1024;
export const MAX_CLIPBOARD_TEXT_LENGTH = 64 * 1024;

export type PointerButton = 'left' | 'right' | 'middle';
export type Modifier = 'Control' | 'Alt' | 'Shift' | 'Meta';

export type PointerMessage = {
  type: 'pointer';
  action: 'move' | 'down' | 'up' | 'click';
  x: number;
  y: number;
  button?: PointerButton;
};

export type WheelMessage = { type: 'wheel'; deltaX: number; deltaY: number };
export type KeyMessage = { type: 'key'; action: 'down' | 'up' | 'tap'; key: string; modifiers?: Modifier[] };
export type TextMessage = { type: 'text'; text: string };
export type JigglerMessage = { type: 'jiggler'; enabled: boolean };
export type DisplayMessage = { type: 'display'; blanked: boolean };
export type StreamMessage = { type: 'stream'; action: 'request'; systemAudio?: boolean };
export type SystemMessage = { type: 'system'; action: 'restart' | 'shutdown' };
export type PingMessage = { type: 'ping'; sentAt: number };
export type AuthResponseMessage = {
  type: 'auth-response';
  method?: 'code' | 'trusted';
  challenge: string;
  nonce: string;
  proof: string;
  deviceId?: string;
};
export type ClipboardMessage =
  | { type: 'clipboard-read'; requestId: string }
  | { type: 'clipboard-write'; requestId: string; text: string };
export type DictationMessage =
  | { type: 'dictation-start'; id: string; mimeType: string }
  | { type: 'dictation-chunk'; id: string; index: number; data: string }
  | { type: 'dictation-end'; id: string; totalChunks: number }
  | { type: 'dictation-cancel'; id: string };

export type ControllerMessage =
  | PointerMessage
  | WheelMessage
  | KeyMessage
  | TextMessage
  | JigglerMessage
  | DisplayMessage
  | StreamMessage
  | SystemMessage
  | PingMessage
  | AuthResponseMessage
  | ClipboardMessage
  | DictationMessage;

export type HostMessage =
  | { type: 'auth-challenge'; challenge: string }
  | { type: 'auth-ok' }
  | { type: 'auth-rejected'; reason: 'trusted-device-revoked' | 'authentication-failed' }
  | { type: 'trusted-credential'; deviceId: string; hostId: string; token: string }
  | {
    type: 'ready';
    computerName: string;
    jigglerEnabled: boolean;
    screenBlanked: boolean;
    dictationAvailable: boolean;
    protocolVersion?: number;
    capabilities?: { trustedReconnect: boolean; clipboardText: boolean; systemAudio: boolean };
  }
  | { type: 'status'; jigglerEnabled: boolean; screenBlanked: boolean; dictationAvailable: boolean }
  | { type: 'clipboard-result'; requestId: string; action: 'read' | 'write'; ok: boolean; text?: string; message: string }
  | { type: 'dictation-status'; id: string; status: 'receiving' | 'transcribing' | 'done' | 'error'; message: string }
  | { type: 'pong'; sentAt: number }
  | { type: 'notice'; message: string };

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'offline';

const tokenPattern = /^[A-Za-z0-9_-]{16,128}$/;
const peerIdPattern = /^[A-Za-z0-9_-]{16,128}$/;
const dictationIdPattern = /^[A-Za-z0-9_-]{8,80}$/;
const audioMimeTypes = new Set(['audio/webm', 'audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg', 'audio/ogg;codecs=opus']);
const pointerActions = new Set(['move', 'down', 'up', 'click']);
const pointerButtons = new Set(['left', 'right', 'middle']);
const keyActions = new Set(['down', 'up', 'tap']);
const modifierKeys = new Set(['Control', 'Alt', 'Shift', 'Meta']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function cleanCode(value: string) {
  return value.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, CODE_LENGTH);
}

export function pairingCodeFromQr(payload: string) {
  const trimmed = payload.trim();
  try {
    const url = new URL(trimmed);
    const fromHash = cleanCode(url.hash.slice(1));
    return fromHash.length === CODE_LENGTH ? fromHash : '';
  } catch {
    const direct = cleanCode(trimmed.replace(/[\s-]/g, ''));
    return direct.length === CODE_LENGTH ? direct : '';
  }
}

export function createPairingCode() {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
}

export function createSecurityToken(byteLength = 24) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export async function peerIdForCode(code: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`compctrl-rendezvous-v2:${cleanCode(code)}`));
  return `compctrl-v2-${bytesToBase64Url(new Uint8Array(digest)).slice(0, 32)}`;
}

export function isCompatibleProtocol(value: unknown) {
  return Number.isInteger(value)
    && Number(value) >= MIN_COMPATIBLE_PROTOCOL_VERSION
    && Number(value) <= PROTOCOL_VERSION;
}

export async function authProofForCode(code: string, challenge: string, nonce: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(cleanCode(code)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const proof = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`compctrl-auth-v2:${challenge}:${nonce}`));
  return bytesToBase64Url(new Uint8Array(proof));
}

export async function authProofForTrustedToken(token: string, challenge: string, nonce: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(token),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const proof = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`compctrl-trusted-v1:${challenge}:${nonce}`));
  return bytesToBase64Url(new Uint8Array(proof));
}

export function isControllerMessage(value: unknown): value is ControllerMessage {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  switch (value.type) {
    case 'pointer':
      return pointerActions.has(String(value.action))
        && isFiniteNumber(value.x) && value.x >= 0 && value.x <= 1
        && isFiniteNumber(value.y) && value.y >= 0 && value.y <= 1
        && (value.button === undefined || (typeof value.button === 'string' && pointerButtons.has(value.button)));
    case 'wheel':
      return isFiniteNumber(value.deltaX) && Math.abs(value.deltaX) <= 2_000
        && isFiniteNumber(value.deltaY) && Math.abs(value.deltaY) <= 2_000;
    case 'key':
      return keyActions.has(String(value.action))
        && typeof value.key === 'string' && value.key.length >= 1 && value.key.length <= 32
        && (value.modifiers === undefined || (
          Array.isArray(value.modifiers) && value.modifiers.length <= 4
          && value.modifiers.every((modifier) => modifierKeys.has(String(modifier)))
        ));
    case 'text':
      return typeof value.text === 'string' && value.text.length > 0 && value.text.length <= MAX_TEXT_LENGTH;
    case 'jiggler': return typeof value.enabled === 'boolean';
    case 'display': return typeof value.blanked === 'boolean';
    case 'stream': return value.action === 'request' && (value.systemAudio === undefined || typeof value.systemAudio === 'boolean');
    case 'system': return value.action === 'restart' || value.action === 'shutdown';
    case 'ping': return isFiniteNumber(value.sentAt) && value.sentAt >= 0;
    case 'auth-response':
      return (value.method === undefined || value.method === 'code' || value.method === 'trusted')
        && typeof value.challenge === 'string' && tokenPattern.test(value.challenge)
        && typeof value.nonce === 'string' && tokenPattern.test(value.nonce)
        && typeof value.proof === 'string' && tokenPattern.test(value.proof)
        && (value.deviceId === undefined || (typeof value.deviceId === 'string' && tokenPattern.test(value.deviceId)));
    case 'clipboard-read':
      return typeof value.requestId === 'string' && tokenPattern.test(value.requestId);
    case 'clipboard-write':
      return typeof value.requestId === 'string' && tokenPattern.test(value.requestId)
        && typeof value.text === 'string' && value.text.length <= MAX_CLIPBOARD_TEXT_LENGTH;
    case 'dictation-start':
      return typeof value.id === 'string' && dictationIdPattern.test(value.id)
        && typeof value.mimeType === 'string' && audioMimeTypes.has(value.mimeType.toLowerCase());
    case 'dictation-chunk':
      return typeof value.id === 'string' && dictationIdPattern.test(value.id)
        && Number.isInteger(value.index) && Number(value.index) >= 0 && Number(value.index) < 2_048
        && typeof value.data === 'string' && value.data.length > 0 && value.data.length <= MAX_DICTATION_CHUNK_LENGTH
        && /^[A-Za-z0-9+/]*={0,2}$/.test(value.data);
    case 'dictation-end':
      return typeof value.id === 'string' && dictationIdPattern.test(value.id)
        && Number.isInteger(value.totalChunks) && Number(value.totalChunks) >= 1 && Number(value.totalChunks) < 2_048;
    case 'dictation-cancel': return typeof value.id === 'string' && dictationIdPattern.test(value.id);
    default: return false;
  }
}

export function isHostMessage(value: unknown): value is HostMessage {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  switch (value.type) {
    case 'auth-challenge': return typeof value.challenge === 'string' && tokenPattern.test(value.challenge);
    case 'auth-ok': return true;
    case 'auth-rejected': return value.reason === 'trusted-device-revoked' || value.reason === 'authentication-failed';
    case 'trusted-credential':
      return typeof value.deviceId === 'string' && tokenPattern.test(value.deviceId)
        && typeof value.hostId === 'string' && peerIdPattern.test(value.hostId)
        && typeof value.token === 'string' && tokenPattern.test(value.token);
    case 'ready':
      return typeof value.computerName === 'string' && value.computerName.length <= 128
        && typeof value.jigglerEnabled === 'boolean' && typeof value.screenBlanked === 'boolean'
        && typeof value.dictationAvailable === 'boolean'
        && (value.protocolVersion === undefined || isCompatibleProtocol(value.protocolVersion))
        && (value.capabilities === undefined || (
          isRecord(value.capabilities)
          && typeof value.capabilities.trustedReconnect === 'boolean'
          && typeof value.capabilities.clipboardText === 'boolean'
          && typeof value.capabilities.systemAudio === 'boolean'
        ));
    case 'status':
      return typeof value.jigglerEnabled === 'boolean' && typeof value.screenBlanked === 'boolean'
        && typeof value.dictationAvailable === 'boolean';
    case 'clipboard-result':
      return typeof value.requestId === 'string' && tokenPattern.test(value.requestId)
        && (value.action === 'read' || value.action === 'write') && typeof value.ok === 'boolean'
        && (value.text === undefined || (typeof value.text === 'string' && value.text.length <= MAX_CLIPBOARD_TEXT_LENGTH))
        && typeof value.message === 'string' && value.message.length <= 256;
    case 'dictation-status':
      return typeof value.id === 'string' && dictationIdPattern.test(value.id)
        && ['receiving', 'transcribing', 'done', 'error'].includes(String(value.status))
        && typeof value.message === 'string' && value.message.length <= 256;
    case 'pong': return isFiniteNumber(value.sentAt) && value.sentAt >= 0;
    case 'notice': return typeof value.message === 'string' && value.message.length <= 512;
    default: return false;
  }
}
