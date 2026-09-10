import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CODE_LENGTH,
  authProofForCode,
  createPairingCode,
  isControllerMessage,
  peerIdForCode,
} from './protocol.ts';

void test('creates stronger pairing codes and hides them from the rendezvous id', async () => {
  const code = createPairingCode();
  assert.equal(code.length, CODE_LENGTH);
  assert.match(code, /^[A-HJ-NP-Z2-9]{12}$/);
  const peerId = await peerIdForCode(code);
  assert.equal(peerId, await peerIdForCode(code));
  assert.equal(peerId.includes(code.toLowerCase()), false);
});

void test('binds authentication proofs to a fresh challenge and nonce', async () => {
  const code = 'ABCD2345WXYZ';
  const first = await authProofForCode(code, 'abcdefghijklmnop', 'qrstuvwxyzABCDEF');
  const second = await authProofForCode(code, 'abcdefghijklmnop2', 'qrstuvwxyzABCDEF');
  assert.notEqual(first, second);
  assert.equal(first, await authProofForCode(code, 'abcdefghijklmnop', 'qrstuvwxyzABCDEF'));
});

void test('rejects malformed or oversized remote-control messages', () => {
  assert.equal(isControllerMessage({ type: 'pointer', action: 'move', x: 0.5, y: 0.5 }), true);
  assert.equal(isControllerMessage({ type: 'pointer', action: 'move', x: 4, y: 0.5 }), false);
  assert.equal(isControllerMessage({ type: 'wheel', deltaX: 0, deltaY: 50_000 }), false);
  assert.equal(isControllerMessage({ type: 'text', text: 'x'.repeat(9_000) }), false);
  assert.equal(isControllerMessage({ type: 'system', action: 'format-disk' }), false);
});
