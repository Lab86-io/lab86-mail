'use client';

import type { ContactAccountStatus } from '@/lib/contacts/lookup';
import { cn } from '@/lib/utils';

function ago(ms: number, now: number) {
  const diff = now - ms;
  if (diff < 60_000) return 'just now';
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return `${minutes} min${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** The plain line for one mailbox's contacts, or null when there is nothing to say. */
export function contactStatusText(status: ContactAccountStatus, now = Date.now()): string | null {
  switch (status.state) {
    case 'ready': {
      const count =
        status.contactCount === 0
          ? 'No contacts'
          : `${status.contactCount.toLocaleString()} contact${status.contactCount === 1 ? '' : 's'}`;
      return status.lastSyncedAt ? `${count} · synced ${ago(status.lastSyncedAt, now)}` : count;
    }
    case 'needsReconnect':
      return 'Contacts need permission.';
    case 'syncing':
      return 'Contacts are syncing.';
    case 'pending':
      return 'The first contact sync has not finished.';
    case 'unsupported':
      return 'This mailbox has no contacts to sync.';
    case 'error':
      return 'Contact sync failed. It will try again.';
    default:
      // A paused mailbox shows the mail reconnect line instead.
      return null;
  }
}

/**
 * Settings, Mailboxes: the contact state under each mailbox, with a
 * "Reconnect to add contacts" link when the grant lacks a contact scope. The
 * link runs the usual connect flow; Nylas updates the same grant.
 */
export function ContactsStatusLine({
  status,
  reconnectHref,
  now,
}: {
  status?: ContactAccountStatus;
  reconnectHref: string;
  now?: number;
}) {
  if (!status) return null;
  const text = contactStatusText(status, now);
  if (!text) return null;
  return (
    <div
      data-slot="contacts-status"
      className={cn(
        'mt-0.5 truncate text-[11px]',
        status.state === 'needsReconnect' || status.state === 'error'
          ? 'text-[var(--color-text-muted)]'
          : 'text-[var(--color-text-faint)]',
      )}
    >
      {text}
      {status.needsReconnect ? (
        <>
          {' '}
          <a href={reconnectHref} className="font-medium text-[var(--color-accent)] underline">
            Reconnect to add contacts
          </a>
        </>
      ) : null}
    </div>
  );
}
