export type MailProvider = 'google' | 'microsoft' | 'icloud' | 'imap';
export type IcloudMode = 'hidden' | 'disabled' | 'beta' | 'enabled';

export interface MailProviderCapability {
  provider: MailProvider;
  label: string;
  visible: boolean;
  connectable: boolean;
  searchable: boolean;
  localSearchEligible: boolean;
  reason?: string;
}

const PROVIDERS: MailProvider[] = ['google', 'microsoft', 'icloud', 'imap'];

export function mailProviderCapabilities(): MailProviderCapability[] {
  return PROVIDERS.map((provider) => mailProviderCapability(provider));
}

export function mailProviderCapability(provider: MailProvider): MailProviderCapability {
  if (provider === 'google') {
    return base(provider, 'Gmail', true, true);
  }
  if (provider === 'microsoft') {
    return base(provider, 'Microsoft', true, true);
  }
  if (provider === 'imap') {
    return {
      ...base(provider, 'IMAP', false, false),
      reason: 'Generic IMAP onboarding is not exposed yet.',
    };
  }

  const mode = icloudMode();
  const connectorReady = isIcloudConnectorReady();
  if (mode === 'disabled') {
    return { ...base(provider, 'iCloud', false, false), reason: 'iCloud is disabled.' };
  }
  if (mode === 'hidden') {
    return { ...base(provider, 'iCloud', false, false), reason: 'iCloud is hidden until validation.' };
  }
  if (!connectorReady) {
    return {
      ...base(provider, 'iCloud', false, false),
      reason: 'Nylas iCloud connector is not marked ready.',
    };
  }
  return {
    ...base(provider, mode === 'beta' ? 'iCloud beta' : 'iCloud', true, true),
    reason: 'Requires an Apple app-specific password.',
  };
}

export function icloudMode(): IcloudMode {
  const raw = process.env.LAB86_MAIL_ICLOUD_MODE;
  return raw === 'disabled' || raw === 'beta' || raw === 'enabled' ? raw : 'hidden';
}

export function isIcloudConnectorReady() {
  return process.env.LAB86_MAIL_NYLAS_ICLOUD_CONNECTOR_READY === '1';
}

function base(
  provider: MailProvider,
  label: string,
  visible: boolean,
  connectable: boolean,
): MailProviderCapability {
  return {
    provider,
    label,
    visible,
    connectable,
    searchable: connectable,
    localSearchEligible: provider === 'icloud' ? connectable : true,
  };
}
