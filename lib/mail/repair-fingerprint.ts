import { contentHash } from '../sync/content-hash';

// The repair sweep (M6) re-reads the newest mail of each mailbox every 30
// minutes to catch read, folder, and star changes that a lost webhook missed.
// Most of that mail did not change. The fingerprint holds the fields that the
// sweep can change, so the sweep writes only the messages whose fingerprint
// differs from the stored one. Bodies are not in it: a message body does not
// change after it arrives, and bodies can move to their own table.

export interface RepairFingerprintInput {
  providerThreadId?: string;
  subject?: string;
  from?: string;
  to?: string;
  receivedAt?: number;
  snippet?: string;
  labels?: readonly string[];
  unread?: boolean;
  starred?: boolean;
  attachments?: readonly unknown[];
}

/** The change fingerprint of one message, from a stored row or from a provider read. */
export function repairFingerprint(message: RepairFingerprintInput): string {
  return contentHash({
    thread: message.providerThreadId ?? '',
    subject: message.subject ?? '',
    from: message.from ?? '',
    to: message.to ?? '',
    receivedAt: Number(message.receivedAt) || 0,
    snippet: message.snippet ?? '',
    labels: [...new Set(message.labels ?? [])].sort(),
    unread: Boolean(message.unread),
    starred: Boolean(message.starred),
    attachments: Array.isArray(message.attachments) ? message.attachments.length : 0,
  });
}

/**
 * The messages that a repair page must write: the new ones, and the ones whose
 * fingerprint differs from the stored fingerprint. `stored` maps a provider
 * message id to its stored fingerprint, or to null when no row exists.
 */
export function changedRepairMessages<T extends RepairFingerprintInput & { providerMessageId: string }>(
  messages: readonly T[],
  stored: Record<string, string | null>,
): T[] {
  return messages.filter((message) => {
    const fingerprint = stored[message.providerMessageId];
    return !fingerprint || fingerprint !== repairFingerprint(message);
  });
}
