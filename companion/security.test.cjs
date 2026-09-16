const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DEFAULT_SECURITY_SETTINGS,
  TRUSTED_DEVICE_MAX_AGE_MS,
  TRUSTED_DEVICE_MAX_IDLE_MS,
  TRUSTED_TOKEN_DELIVERY_GRACE_MS,
  isAuthorizedDisplayMediaPermission,
  isTrustedDeviceFresh,
  normalizeSecuritySettings,
  trustedDeviceExpiry,
} = require('./security.cjs');

test('sensitive remote capabilities default to denied', () => {
  assert.deepEqual(normalizeSecuritySettings(), DEFAULT_SECURITY_SETTINGS);
  assert.equal(DEFAULT_SECURITY_SETTINGS.remoteInputEnabled, true);
  assert.equal(DEFAULT_SECURITY_SETTINGS.clipboardEnabled, false);
  assert.equal(DEFAULT_SECURITY_SETTINGS.powerActionsEnabled, false);
  assert.equal(DEFAULT_SECURITY_SETTINGS.displayControlEnabled, false);
  assert.equal(DEFAULT_SECURITY_SETTINGS.dictationEnabled, false);
  assert.equal(DEFAULT_SECURITY_SETTINGS.systemAudioEnabled, false);
});

test('security settings accept booleans only', () => {
  const settings = normalizeSecuritySettings({ clipboardEnabled: true, powerActionsEnabled: 'true' });
  assert.equal(settings.clipboardEnabled, true);
  assert.equal(settings.powerActionsEnabled, false);
});

test('trusted credentials expire by age and inactivity', () => {
  const now = 2_000_000_000_000;
  assert.equal(isTrustedDeviceFresh({ createdAt: now - 1000, lastSeenAt: now - 1000 }, now), true);
  assert.equal(isTrustedDeviceFresh({ createdAt: now - TRUSTED_DEVICE_MAX_AGE_MS - 1, lastSeenAt: now }, now), false);
  assert.equal(isTrustedDeviceFresh({ createdAt: now - TRUSTED_DEVICE_MAX_IDLE_MS, lastSeenAt: now - TRUSTED_DEVICE_MAX_IDLE_MS - 1 }, now), false);
  assert.equal(trustedDeviceExpiry({ createdAt: now, expiresAt: now + TRUSTED_DEVICE_MAX_AGE_MS * 2 }), now + TRUSTED_DEVICE_MAX_AGE_MS);
  assert.equal(TRUSTED_TOKEN_DELIVERY_GRACE_MS, 120_000);
});

test('display capture permission does not grant camera or microphone access', () => {
  assert.equal(isAuthorizedDisplayMediaPermission('display-capture', {}, true), true);
  assert.equal(isAuthorizedDisplayMediaPermission('media', { mediaTypes: [] }, true), true);
  assert.equal(isAuthorizedDisplayMediaPermission('media', { mediaTypes: ['video'] }, true), false);
  assert.equal(isAuthorizedDisplayMediaPermission('media', { mediaTypes: ['audio'] }, true), false);
  assert.equal(isAuthorizedDisplayMediaPermission('media', { mediaTypes: [] }, false), false);
  assert.equal(isAuthorizedDisplayMediaPermission('notifications', {}, true), false);
});
