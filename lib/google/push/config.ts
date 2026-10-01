// Direct Google push: the flags, the routes, and the Pub/Sub settings
// (docs/google-direct-transport.md, "Push"). Each flag is off by default.
// With a flag off, its route answers 204 and does nothing, and the renewal
// cron stops the watches or channels of that kind.

import { hostedPublicUrl } from '@/lib/hosted/env';
import type { GooglePushKind } from './rules';

type Env = Record<string, string | undefined>;

export const GOOGLE_PUSH_ROUTES = {
  gmail: '/api/google/push/gmail',
  calendar: '/api/google/push/calendar',
  drive: '/api/google/push/drive',
} as const satisfies Record<GooglePushKind, string>;

export type GooglePushFlags = Record<GooglePushKind, boolean>;

export function googlePushFlags(env: Env = process.env): GooglePushFlags {
  return {
    gmail: env.LAB86_GOOGLE_GMAIL_PUSH === '1',
    calendar: env.LAB86_GOOGLE_CALENDAR_PUSH === '1',
    drive: env.LAB86_GOOGLE_DRIVE_PUSH === '1',
  };
}

export function anyGooglePushEnabled(flags: GooglePushFlags): boolean {
  return flags.gmail || flags.calendar || flags.drive;
}

export interface GmailPushConfig {
  /** `projects/<project id>/topics/<topic>`: the topic that Gmail publishes to. */
  topic: string;
  /** The `aud` claim of the Pub/Sub push token. */
  audience: string;
  /** The `email` claim of the Pub/Sub push token: the invoker service account. */
  serviceAccount: string;
}

const TOPIC_NAME = /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/topics\/[A-Za-z][\w.~+%-]{2,254}$/;

/** The Pub/Sub settings of Gmail push, or null when a value is missing or not valid. */
export function gmailPushConfig(env: Env = process.env): GmailPushConfig | null {
  const topic = env.LAB86_GOOGLE_PUBSUB_TOPIC?.trim() || '';
  const audience = env.LAB86_GOOGLE_PUBSUB_AUDIENCE?.trim() || '';
  const serviceAccount = env.LAB86_GOOGLE_PUBSUB_SERVICE_ACCOUNT?.trim().toLowerCase() || '';
  if (!TOPIC_NAME.test(topic) || !audience || !serviceAccount.includes('@')) return null;
  return { topic, audience, serviceAccount };
}

/**
 * The HTTPS address that Google posts the messages of a Calendar or Drive
 * channel to. Null when the app has no HTTPS address (local development):
 * Google accepts only HTTPS.
 */
export function googlePushAddress(
  kind: 'calendar' | 'drive',
  base: string = hostedPublicUrl(),
): string | null {
  try {
    const url = new URL(GOOGLE_PUSH_ROUTES[kind], `${base.replace(/\/$/, '')}/`);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}
