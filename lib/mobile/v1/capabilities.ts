import type { ProviderCapabilitySet } from './contract';

const FULL_MAIL: ProviderCapabilitySet = {
  mail: true,
  calendar: true,
  contacts: true,
  folders: true,
  labels: true,
  drafts: true,
  scheduledSend: true,
  push: true,
  search: true,
};

export function capabilitiesForProvider(
  provider: 'google' | 'microsoft' | 'icloud' | 'imap',
): ProviderCapabilitySet {
  switch (provider) {
    case 'google':
      return { ...FULL_MAIL };
    case 'microsoft':
      return { ...FULL_MAIL, labels: false };
    case 'icloud':
      return { ...FULL_MAIL, contacts: false, labels: false };
    case 'imap':
      return {
        mail: true,
        calendar: false,
        contacts: false,
        folders: true,
        labels: false,
        drafts: true,
        scheduledSend: true,
        push: true,
        search: true,
        unsupportedReason: 'Generic IMAP/SMTP accounts do not expose calendar or contacts capabilities.',
      };
  }
}
