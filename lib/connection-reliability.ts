export const HEARTBEAT_INTERVAL_MS = 8_000;
export const HEARTBEAT_TIMEOUT_MS = 25_000;
export const RESUME_PROBE_TIMEOUT_MS = 5_000;
export const SIGNALING_RECONNECT_DELAY_MS = 1_200;
export const SAME_DEVICE_TAKEOVER_IDLE_MS = 12_000;

export function reconnectDelayMs(attempt: number, online: boolean) {
  if (!online) return 2_500;
  return Math.min(1_000 * 2 ** Math.max(0, attempt), 8_000);
}

export function shouldRejectControllerTakeover(
  activeConnectionOpen: boolean,
  sameDevice: boolean,
  lastActivityAt: number,
  now = Date.now(),
) {
  return activeConnectionOpen && (!sameDevice || now - lastActivityAt < SAME_DEVICE_TAKEOVER_IDLE_MS);
}

export function pongMissed(probeSentAt: number, lastPongAt: number) {
  return probeSentAt > 0 && lastPongAt < probeSentAt;
}
