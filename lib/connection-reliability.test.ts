import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SAME_DEVICE_TAKEOVER_IDLE_MS,
  pongMissed,
  reconnectDelayMs,
  shouldRejectControllerTakeover,
} from './connection-reliability.ts';

void test('uses bounded reconnect backoff and a steady offline retry', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 8].map((attempt) => reconnectDelayMs(attempt, true)), [1_000, 2_000, 4_000, 8_000, 8_000, 8_000]);
  assert.equal(reconnectDelayMs(20, false), 2_500);
});

void test('allows only a stale connection from the same authenticated device to be replaced', () => {
  const now = 100_000;
  assert.equal(shouldRejectControllerTakeover(false, false, 0, now), false);
  assert.equal(shouldRejectControllerTakeover(true, false, 0, now), true);
  assert.equal(shouldRejectControllerTakeover(true, true, now - SAME_DEVICE_TAKEOVER_IDLE_MS + 1, now), true);
  assert.equal(shouldRejectControllerTakeover(true, true, now - SAME_DEVICE_TAKEOVER_IDLE_MS, now), false);
});

void test('requires a pong at or after a mobile-resume probe', () => {
  assert.equal(pongMissed(10_000, 9_999), true);
  assert.equal(pongMissed(10_000, 10_000), false);
  assert.equal(pongMissed(0, 0), false);
});
