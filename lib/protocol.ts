export const PROTOCOL_VERSION = 1;
export const CODE_LENGTH = 8;
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export type PointerButton = 'left' | 'right' | 'middle';

export type PointerMessage = {
  type: 'pointer';
  action: 'move' | 'down' | 'up' | 'click';
  x: number;
  y: number;
  button?: PointerButton;
};

export type WheelMessage = {
  type: 'wheel';
  deltaX: number;
  deltaY: number;
};

export type KeyMessage = {
  type: 'key';
  action: 'down' | 'up' | 'tap';
  key: string;
  modifiers?: Array<'Control' | 'Alt' | 'Shift' | 'Meta'>;
};

export type TextMessage = { type: 'text'; text: string };
export type JigglerMessage = { type: 'jiggler'; enabled: boolean };
export type SystemMessage = {
  type: 'system';
  action: 'restart' | 'shutdown';
};
export type PingMessage = { type: 'ping'; sentAt: number };

export type ControllerMessage =
  | PointerMessage
  | WheelMessage
  | KeyMessage
  | TextMessage
  | JigglerMessage
  | SystemMessage
  | PingMessage;

export type HostMessage =
  | { type: 'ready'; computerName: string; jigglerEnabled: boolean }
  | { type: 'status'; jigglerEnabled: boolean }
  | { type: 'pong'; sentAt: number }
  | { type: 'notice'; message: string };

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'offline';

export function cleanCode(value: string) {
  return value
    .toUpperCase()
    .replace(/[^A-Z2-9]/g, '')
    .slice(0, CODE_LENGTH);
}

export function pairingCodeFromQr(payload: string) {
  const trimmed = payload.trim();
  try {
    const url = new URL(trimmed);
    const fromHash = url.hash.slice(1).toUpperCase().replace(/[^A-Z2-9]/g, '');
    return fromHash.length === CODE_LENGTH ? fromHash : '';
  } catch {
    const direct = trimmed.toUpperCase().replace(/[\s-]/g, '');
    return /^[A-Z2-9]{8}$/.test(direct) ? direct : '';
  }
}

export function createPairingCode() {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
}

export function peerIdForCode(code: string) {
  return `compctrl-${cleanCode(code).toLowerCase()}`;
}

export function isControllerMessage(value: unknown): value is ControllerMessage {
  if (!value || typeof value !== 'object' || !('type' in value)) return false;
  return ['pointer', 'wheel', 'key', 'text', 'jiggler', 'system', 'ping'].includes(
    String((value as { type: unknown }).type),
  );
}
