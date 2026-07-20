export type MobilePushEnvironment = 'development' | 'production';

export interface MobileDeviceRegistration {
  platform: 'ios';
  token: string;
  deviceId: string;
  environment: MobilePushEnvironment;
  appVersion?: string;
}

export interface MobileDeviceRevocation {
  token?: string;
  deviceId?: string;
}

export class MobileDeviceInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MobileDeviceInputError';
  }
}

export function isAPNsDeviceToken(value: string) {
  return value.length >= 64 && value.length <= 256 && value.length % 2 === 0 && /^[a-f\d]+$/i.test(value);
}

function deviceId(value: unknown) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 180 || !/^[a-z\d._:-]+$/i.test(normalized)) {
    throw new MobileDeviceInputError('A valid deviceId is required.');
  }
  return normalized;
}

function token(value: unknown) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (!isAPNsDeviceToken(normalized)) {
    throw new MobileDeviceInputError('A valid APNs device token is required.');
  }
  return normalized;
}

export function parseMobileDeviceRegistration(input: unknown): MobileDeviceRegistration {
  if (!input || typeof input !== 'object')
    throw new MobileDeviceInputError('A device registration is required.');
  const record = input as Record<string, unknown>;
  if (record.platform !== 'ios') throw new MobileDeviceInputError('Only iOS devices are supported.');
  if (record.environment !== 'development' && record.environment !== 'production') {
    throw new MobileDeviceInputError('A valid APNs environment is required.');
  }
  const appVersion = String(record.appVersion || '').trim();
  if (appVersion.length > 64 || /[\u0000-\u001f\u007f]/.test(appVersion)) {
    throw new MobileDeviceInputError('The app version is invalid.');
  }
  return {
    platform: 'ios',
    token: token(record.token),
    deviceId: deviceId(record.deviceId),
    environment: record.environment,
    ...(appVersion ? { appVersion } : {}),
  };
}

export function parseMobileDeviceRevocation(input: unknown): MobileDeviceRevocation {
  if (!input || typeof input !== 'object')
    throw new MobileDeviceInputError('A device revocation is required.');
  const record = input as Record<string, unknown>;
  const parsed: MobileDeviceRevocation = {};
  if (record.token) parsed.token = token(record.token);
  if (record.deviceId) parsed.deviceId = deviceId(record.deviceId);
  if (!parsed.token && !parsed.deviceId) {
    throw new MobileDeviceInputError('A token or deviceId is required.');
  }
  return parsed;
}
