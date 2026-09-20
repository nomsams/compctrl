const assert = require('node:assert/strict');
const test = require('node:test');

const { generateTrustedPeerId, isStoredTrustedPeerId, isValidPeerId } = require('./peer-identity.cjs');

test('generated trusted rendezvous IDs are always valid PeerJS IDs', () => {
  for (let index = 0; index < 512; index += 1) {
    const id = generateTrustedPeerId();
    assert.equal(isValidPeerId(id), true);
    assert.equal(isStoredTrustedPeerId(id), true);
    assert.match(id, /^compctrl-trusted-v2-[a-f0-9]{48}$/);
  }
});

test('migrates invalid legacy IDs but preserves legacy IDs accepted by PeerJS', () => {
  assert.equal(isStoredTrustedPeerId(`compctrl-trusted-v1-${'a'.repeat(15)}__${'b'.repeat(15)}`), false);
  assert.equal(isStoredTrustedPeerId(`compctrl-trusted-v1-${'A'.repeat(15)}-${'b'.repeat(16)}`), true);
  assert.equal(isValidPeerId('compctrl-v2-bad__separator'), false);
});
