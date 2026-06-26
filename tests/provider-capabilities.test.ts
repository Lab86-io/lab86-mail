import { describe, expect, test } from 'bun:test';
import {
  icloudMode,
  isIcloudConnectorReady,
  mailProviderCapabilities,
  mailProviderCapability,
} from '../lib/mail/provider-capabilities';

describe('mailProviderCapability', () => {
  test('exposes Google and Microsoft by default', () => {
    expect(mailProviderCapability('google')).toMatchObject({
      visible: true,
      connectable: true,
      searchable: true,
      localSearchEligible: true,
    });
    expect(mailProviderCapability('microsoft')).toMatchObject({
      visible: true,
      connectable: true,
    });
  });
  test('hides generic IMAP onboarding', () => {
    expect(mailProviderCapability('imap')).toMatchObject({
      visible: false,
      connectable: false,
      reason: expect.stringContaining('IMAP'),
    });
  });
  test('respects iCloud rollout env flags', () => {
    const previousMode = process.env.LAB86_MAIL_ICLOUD_MODE;
    const previousReady = process.env.LAB86_MAIL_NYLAS_ICLOUD_CONNECTOR_READY;
    try {
      delete process.env.LAB86_MAIL_ICLOUD_MODE;
      delete process.env.LAB86_MAIL_NYLAS_ICLOUD_CONNECTOR_READY;
      expect(mailProviderCapability('icloud')).toMatchObject({ visible: false, connectable: false });

      process.env.LAB86_MAIL_ICLOUD_MODE = 'beta';
      expect(mailProviderCapability('icloud')).toMatchObject({ visible: true, connectable: false });

      process.env.LAB86_MAIL_NYLAS_ICLOUD_CONNECTOR_READY = '1';
      expect(mailProviderCapability('icloud')).toMatchObject({
        visible: true,
        connectable: true,
        searchable: true,
        localSearchEligible: true,
      });
    } finally {
      if (previousMode === undefined) delete process.env.LAB86_MAIL_ICLOUD_MODE;
      else process.env.LAB86_MAIL_ICLOUD_MODE = previousMode;
      if (previousReady === undefined) delete process.env.LAB86_MAIL_NYLAS_ICLOUD_CONNECTOR_READY;
      else process.env.LAB86_MAIL_NYLAS_ICLOUD_CONNECTOR_READY = previousReady;
    }
  });
});

describe('mailProviderCapabilities', () => {
  test('returns all configured providers', () => {
    expect(mailProviderCapabilities().map((item) => item.provider)).toEqual([
      'google',
      'microsoft',
      'icloud',
      'imap',
    ]);
  });
});

describe('icloud helpers', () => {
  test('reads mode and connector readiness from env', () => {
    const previousMode = process.env.LAB86_MAIL_ICLOUD_MODE;
    const previousReady = process.env.LAB86_MAIL_NYLAS_ICLOUD_CONNECTOR_READY;
    try {
      process.env.LAB86_MAIL_ICLOUD_MODE = 'enabled';
      process.env.LAB86_MAIL_NYLAS_ICLOUD_CONNECTOR_READY = '1';
      expect(icloudMode()).toBe('enabled');
      expect(isIcloudConnectorReady()).toBe(true);
    } finally {
      if (previousMode === undefined) delete process.env.LAB86_MAIL_ICLOUD_MODE;
      else process.env.LAB86_MAIL_ICLOUD_MODE = previousMode;
      if (previousReady === undefined) delete process.env.LAB86_MAIL_NYLAS_ICLOUD_CONNECTOR_READY;
      else process.env.LAB86_MAIL_NYLAS_ICLOUD_CONNECTOR_READY = previousReady;
    }
  });
});
