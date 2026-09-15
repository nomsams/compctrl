const DAY_MS = 24 * 60 * 60 * 1000;
const TRUSTED_DEVICE_MAX_AGE_MS = 30 * DAY_MS;
const TRUSTED_DEVICE_MAX_IDLE_MS = 7 * DAY_MS;
const TRUSTED_TOKEN_DELIVERY_GRACE_MS = 2 * 60 * 1000;

const DEFAULT_SECURITY_SETTINGS = Object.freeze({
  remoteInputEnabled: true,
  trustedReconnectEnabled: true,
  clipboardEnabled: false,
  powerActionsEnabled: false,
  displayControlEnabled: false,
  dictationEnabled: false,
  systemAudioEnabled: false,
});

function normalizeSecuritySettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  return Object.fromEntries(
    Object.entries(DEFAULT_SECURITY_SETTINGS).map(([key, defaultValue]) => [
      key,
      typeof source[key] === 'boolean' ? source[key] : defaultValue,
    ]),
  );
}

function trustedDeviceExpiry(entry) {
  const createdAt = Number.isFinite(entry?.createdAt) ? entry.createdAt : Date.now();
  const maximum = createdAt + TRUSTED_DEVICE_MAX_AGE_MS;
  return Number.isFinite(entry?.expiresAt) ? Math.min(entry.expiresAt, maximum) : maximum;
}

function isTrustedDeviceFresh(entry, now = Date.now()) {
  if (!entry || typeof entry !== 'object') return false;
  const lastSeenAt = Number.isFinite(entry.lastSeenAt) ? entry.lastSeenAt : entry.createdAt;
  return Number.isFinite(lastSeenAt)
    && now <= trustedDeviceExpiry(entry)
    && now - lastSeenAt <= TRUSTED_DEVICE_MAX_IDLE_MS;
}

module.exports = {
  DEFAULT_SECURITY_SETTINGS,
  TRUSTED_DEVICE_MAX_AGE_MS,
  TRUSTED_DEVICE_MAX_IDLE_MS,
  TRUSTED_TOKEN_DELIVERY_GRACE_MS,
  isTrustedDeviceFresh,
  normalizeSecuritySettings,
  trustedDeviceExpiry,
};
