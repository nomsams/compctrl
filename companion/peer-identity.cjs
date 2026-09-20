const crypto = require('node:crypto');

const PEERJS_ID_PATTERN = /^[A-Za-z0-9]+(?:[ _-][A-Za-z0-9]+)*$/;
const TRUSTED_PEER_ID_PATTERN = /^compctrl-trusted-v(?:1-[A-Za-z0-9_-]{32}|2-[a-f0-9]{48})$/;

function isValidPeerId(value) {
  return typeof value === 'string' && PEERJS_ID_PATTERN.test(value);
}

function isStoredTrustedPeerId(value) {
  return isValidPeerId(value) && TRUSTED_PEER_ID_PATTERN.test(value);
}

function generateTrustedPeerId() {
  return `compctrl-trusted-v2-${crypto.randomBytes(24).toString('hex')}`;
}

module.exports = { generateTrustedPeerId, isStoredTrustedPeerId, isValidPeerId };
