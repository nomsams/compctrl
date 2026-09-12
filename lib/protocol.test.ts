import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CODE_LENGTH,
  authProofForCode,
  authProofForTrustedToken,
  createPairingCode,
  isCompatibleProtocol,
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
  const trusted = await authProofForTrustedToken('trustedToken_abcdefghijklmnop', 'abcdefghijklmnop', 'qrstuvwxyzABCDEF');
  assert.notEqual(trusted, first);
  assert.equal(trusted, await authProofForTrustedToken('trustedToken_abcdefghijklmnop', 'abcdefghijklmnop', 'qrstuvwxyzABCDEF'));
});

void test('rejects malformed or oversized remote-control messages', () => {
  assert.equal(isControllerMessage({ type: 'pointer', action: 'move', x: 0.5, y: 0.5 }), true);
  assert.equal(isControllerMessage({ type: 'pointer', action: 'move', x: 4, y: 0.5 }), false);
  assert.equal(isControllerMessage({ type: 'wheel', deltaX: 0, deltaY: 50_000 }), false);
  assert.equal(isControllerMessage({ type: 'text', text: 'x'.repeat(9_000) }), false);
  assert.equal(isControllerMessage({ type: 'clipboard-read', requestId: 'abcdefghijklmnop' }), true);
  assert.equal(isControllerMessage({ type: 'clipboard-write', requestId: 'abcdefghijklmnop', text: 'safe text' }), true);
  assert.equal(isControllerMessage({ type: 'clipboard-write', requestId: 'abcdefghijklmnop', text: 'x'.repeat(70_000) }), false);
  assert.equal(isControllerMessage({ type: 'stream', action: 'request', systemAudio: false }), true);
  assert.equal(isControllerMessage({ type: 'stream', action: 'request', systemAudio: 'yes' }), false);
  assert.equal(isControllerMessage({ type: 'system', action: 'format-disk' }), false);
});

void test('keeps protocol 2 screen sessions working during a protocol 3 rollout', () => {
  assert.equal(isCompatibleProtocol(2), true);
  assert.equal(isCompatibleProtocol(3), true);
  assert.equal(isCompatibleProtocol(1), false);
  assert.equal(isCompatibleProtocol(4), false);
  assert.equal(isControllerMessage({
    type: 'auth-response',
    challenge: 'abcdefghijklmnop',
    nonce: 'qrstuvwxyzABCDEF',
    proof: 'proofProofProof12',
  }), true);
});
