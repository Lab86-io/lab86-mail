// A sealed file on a mail needs a send permission (docs/albatross-goal-runs.md
// G5, "Secret values in a PDF"). `POST /api/compose` refuses with 409
// `needs_allow`; the composer shows one small choice in its send area; each
// choice posts `/api/secure-details/allow-send`, through the identity check,
// then sends the same form again with the same `pendingId` (and the
// `allowToken` after "once"). Pure rules and the fetches; no React here.

export interface AllowSendItem {
  itemId: string;
  itemLabel: string;
  fieldLabels: string[];
  domains: string[];
}

export interface AllowSendRefusal {
  code: 'needs_allow' | 'allow_ended';
  grant: 'send';
  /** The form's `pendingId`; the retry sends the same one. */
  sendId: string;
  domains: string[];
  allow: AllowSendItem[];
  /** The server's sentence, shown as written for `allow_ended`. */
  error: string;
}

export type AllowSendScope = 'once' | 'always';

export interface AllowSendBody {
  sendId: string;
  scope: AllowSendScope;
  items: Array<{ itemId: string; domains: string[] }>;
}

export type AllowSendAnswer =
  | { ok: true; scope: 'once'; allowToken: string; expiresAt: number }
  | { ok: true; scope: 'always' };

export const ALLOW_SEND_COPY = {
  once: 'Allow for this send',
  always: (domain: string) => `Always for mail to ${domain}`,
  sentence: (itemLabel: string, fileName: string, domains: string) =>
    `${itemLabel} goes in ${fileName} for mail to ${domains}.`,
  theFile: 'the attached file',
  theFiles: 'the attached files',
  busy: 'One more check…',
  failed: 'The permission did not save. Try again.',
  cancelled: 'Not sent. The permission needs the identity check.',
} as const;

/** "example.com", "a.com and b.com", "a.com, b.com, and c.com". */
export function joinDomains(domains: readonly string[]): string {
  const list = domains.map((domain) => domain.trim()).filter(Boolean);
  if (list.length <= 1) return list[0] ?? '';
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(', ')}, and ${list[list.length - 1]}`;
}

/** The 409 of the compose route as a refusal, or null for any other answer. */
export function parseAllowSendRefusal(status: number, body: unknown): AllowSendRefusal | null {
  if (status !== 409 || !body || typeof body !== 'object') return null;
  const raw = body as Record<string, unknown>;
  if (raw.code !== 'needs_allow' && raw.code !== 'allow_ended') return null;
  const sendId = typeof raw.sendId === 'string' ? raw.sendId : '';
  const allow = Array.isArray(raw.allow)
    ? raw.allow
        .map((entry) => {
          const item = (entry ?? {}) as Record<string, unknown>;
          return {
            itemId: String(item.itemId ?? ''),
            itemLabel: String(item.itemLabel ?? ''),
            fieldLabels: Array.isArray(item.fieldLabels) ? item.fieldLabels.map(String) : [],
            domains: Array.isArray(item.domains) ? item.domains.map(String) : [],
          };
        })
        .filter((item) => item.itemId)
    : [];
  return {
    code: raw.code,
    grant: 'send',
    sendId,
    domains: Array.isArray(raw.domains) ? raw.domains.map(String) : [],
    allow,
    error: typeof raw.error === 'string' ? raw.error : '',
  };
}

/** The sentences of the choice: one per item. The file name is the sealed attachment's, when one is known. */
export function allowSendSentences(
  refusal: AllowSendRefusal,
  sealedFileNames: readonly string[] = [],
): string[] {
  const file =
    sealedFileNames.length === 1
      ? sealedFileNames[0]
      : sealedFileNames.length > 1
        ? ALLOW_SEND_COPY.theFiles
        : ALLOW_SEND_COPY.theFile;
  return refusal.allow.map((item) =>
    ALLOW_SEND_COPY.sentence(
      item.itemLabel,
      file,
      joinDomains(item.domains.length ? item.domains : refusal.domains),
    ),
  );
}

/** The body of the allow-send call for a choice. */
export function allowSendBody(refusal: AllowSendRefusal, scope: AllowSendScope): AllowSendBody {
  return {
    sendId: refusal.sendId,
    scope,
    items: refusal.allow.map((item) => ({
      itemId: item.itemId,
      domains: item.domains.length ? item.domains : refusal.domains,
    })),
  };
}

/** The "Always" label names the domains of the refusal. */
export function allowSendAlwaysLabel(refusal: AllowSendRefusal): string {
  const domains = refusal.domains.length ? refusal.domains : refusal.allow.flatMap((item) => item.domains);
  return ALLOW_SEND_COPY.always(joinDomains([...new Set(domains)]));
}

/** What the retry of the compose form carries after an answer. */
export function sendRetryFields(
  refusal: AllowSendRefusal,
  answer: AllowSendAnswer,
): { pendingId: string; allowToken?: string } {
  return answer.scope === 'once'
    ? { pendingId: refusal.sendId, allowToken: answer.allowToken }
    : { pendingId: refusal.sendId };
}

export class AllowSendError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** The body of a 403 that asks for the identity check. */
export function isAllowSendCheckBody(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const value = body as { code?: unknown; clerk_error?: { type?: string; reason?: string } };
  return (
    value.code === 'verify_identity' ||
    (value.clerk_error?.type === 'forbidden' && value.clerk_error?.reason === 'reverification-error')
  );
}

/**
 * Posts one choice. A 403 that asks for the identity check comes back as a
 * value, so Clerk's `useReverification` can run the check and call again.
 */
export async function postAllowSendOrCheck(body: AllowSendBody): Promise<AllowSendAnswer | { check: true }> {
  const response = await fetch('/api/secure-details/allow-send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (response.status === 403 && isAllowSendCheckBody(data))
    return { ...(data as object), check: true } as { check: true };
  if (!response.ok || !data?.ok) {
    const code = typeof data?.code === 'string' ? data.code : undefined;
    throw new AllowSendError(String(data?.error || ALLOW_SEND_COPY.failed), response.status, code);
  }
  return data as AllowSendAnswer;
}
