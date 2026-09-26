import { getAiRequestContext } from '../ai/context';
import { isConvexConfigured } from '../hosted/env';
import { kvGet, kvList, kvUpsert } from '../store/kv';

// Signatures (FEATURES item 11). One signature for each mailbox: plain text,
// with an optional simple HTML version. The server appends it when a message
// goes out (new mail, reply, reply all, forward), so web, iOS, macOS, and the
// assistant send the same thing. The composer shows it and can leave it off
// for one message.

export const SIGNATURE_KIND = 'mailSignature';
export const SIGNATURE_TEXT_MAX = 2_000;
export const SIGNATURE_HTML_MAX = 10_000;

export interface MailSignature {
  accountId: string;
  enabled: boolean;
  text: string;
  /** Sanitized simple HTML. When absent, the HTML part is the text with line breaks. */
  html?: string;
  updatedAt: number;
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function signatureTextToHtml(text: string) {
  return escapeHtml(text.trim()).replace(/\r?\n/g, '<br>');
}

function comparable(value: string) {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** True when the signature has something to add. */
export function signatureIsActive(signature: MailSignature | null | undefined): signature is MailSignature {
  return Boolean(signature?.enabled && signature.text.trim());
}

/**
 * Adds the signature below the message. It is added once: a body that already
 * ends with (or contains) the signature text, for example after the user typed
 * it or a draft kept it, is left alone.
 */
export function appendSignature(
  message: { body: string; html?: string },
  signature: MailSignature | null | undefined,
): { body: string; html?: string; applied: boolean } {
  if (!signatureIsActive(signature)) return { ...message, applied: false };
  const text = signature.text.trim();
  if (comparable(message.body).includes(comparable(text))) return { ...message, applied: false };
  const body = message.body.trimEnd() ? `${message.body.trimEnd()}\n\n${text}` : text;
  const signatureHtml = signature.html?.trim() || signatureTextToHtml(text);
  const html =
    message.html !== undefined
      ? `${message.html}<br><br><div data-signature="true">${signatureHtml}</div>`
      : undefined;
  return { body, ...(html !== undefined ? { html } : {}), applied: true };
}

const ALLOWED_TAGS = ['a', 'b', 'strong', 'i', 'em', 'u', 'br', 'p', 'div', 'span', 'small'];

/**
 * Keeps simple formatting and links only. Signature HTML goes into other
 * people's inboxes, so scripts, styles, forms, and images are removed.
 */
export async function sanitizeSignatureHtml(html: string): Promise<string> {
  const source = html.trim().slice(0, SIGNATURE_HTML_MAX);
  if (!source) return '';
  const [{ JSDOM }, purifyModule] = await Promise.all([import('jsdom'), import('dompurify')]);
  const createPurify: any = (purifyModule as any).default ?? purifyModule;
  const purify = createPurify(new JSDOM('').window as any);
  const clean = String(
    purify.sanitize(source, {
      ALLOWED_TAGS,
      ALLOWED_ATTR: ['href'],
      ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:)/i,
    }),
  );
  return clean.trim();
}

export function defaultSignature(accountId: string): MailSignature {
  return { accountId, enabled: false, text: '', updatedAt: 0 };
}

/** The signature for one mailbox, read as the signed-in user. */
export async function getSignature(accountId: string): Promise<MailSignature | null> {
  if (!accountId) return null;
  return await kvGet<MailSignature>(SIGNATURE_KIND, accountId);
}

export async function listSignatures(): Promise<MailSignature[]> {
  return await kvList<MailSignature>(SIGNATURE_KIND, { limit: 100 });
}

export async function saveSignature(input: {
  accountId: string;
  enabled: boolean;
  text: string;
  html?: string | null;
}): Promise<MailSignature> {
  const text = input.text.replace(/\r\n/g, '\n').trim();
  if (text.length > SIGNATURE_TEXT_MAX) {
    throw new Error(`A signature can be at most ${SIGNATURE_TEXT_MAX} characters.`);
  }
  if (input.enabled && !text) throw new Error('Write a signature before you turn it on.');
  const html = input.html ? await sanitizeSignatureHtml(input.html) : '';
  const signature: MailSignature = {
    accountId: input.accountId,
    enabled: input.enabled,
    text,
    ...(html ? { html } : {}),
    updatedAt: Date.now(),
  };
  await kvUpsert(SIGNATURE_KIND, input.accountId, signature, input.accountId);
  return signature;
}

/**
 * The outgoing body and HTML with this mailbox's signature. `include: false`
 * leaves it off for one message. A store failure never blocks a send.
 */
export async function withAccountSignature(input: {
  account: string;
  body: string;
  html?: string;
  include?: boolean;
}): Promise<{ body: string; html?: string; applied: boolean }> {
  const message = { body: input.body, ...(input.html !== undefined ? { html: input.html } : {}) };
  if (input.include === false) return { ...message, applied: false };
  const signature = await signatureForAccountRef(input.account).catch(() => null);
  return appendSignature(message, signature);
}

/**
 * Signatures are keyed by account id. The assistant and older clients may
 * name the mailbox by email or grant id, so a miss resolves the reference.
 */
export async function signatureForAccountRef(account: string) {
  const direct = await getSignature(account);
  if (direct) return direct;
  const userId = getAiRequestContext().userId;
  if (!userId || !isConvexConfigured()) return null;
  const { resolveConnectedAccount } = await import('../nylas/provider');
  const row = await resolveConnectedAccount(userId, account);
  return row && row.accountId !== account ? await getSignature(row.accountId) : null;
}
