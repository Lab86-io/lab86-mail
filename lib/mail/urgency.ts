// Urgency assessment for freshly ingested mail.
//
// This decides whether a message is allowed to break through Focus. That is a
// high bar: an interruption the user did not want teaches them to turn the
// whole feature off, and they only do that once. So the lexical pass here is
// a filter, not a classifier — it rejects confidently and promotes cautiously,
// and anything it is unsure about is handed to a nano model for confirmation
// rather than being pushed on the strength of a keyword.

export interface UrgencyMessage {
  subject: string;
  from: string;
  to?: string;
  receivedAt: number;
  snippet?: string;
  textBody?: string;
  headers?: unknown;
  labels?: string[];
}

export interface UrgencyAssessment {
  urgent: boolean;
  /** Short user-facing explanation, shown as the notification subtitle. */
  reason: string;
  /** 'security' and 'code' skip model confirmation; 'language' requires it. */
  kind: 'security' | 'code' | 'deadline' | 'language';
  needsConfirmation: boolean;
}

const HOUR_MS = 3_600_000;

// Account-security mail is the one category worth interrupting for on lexical
// evidence alone: it is transactional, it is never bulk, and it is actionable
// precisely when it arrives.
const SECURITY_SIGNAL =
  /\b(?:new\s+sign[-\s]?in|new\s+login|unusual\s+(?:sign[-\s]?in|activity|login)|suspicious\s+(?:activity|sign[-\s]?in|login)|unrecognized\s+device|password\s+(?:was\s+)?(?:reset|changed)|security\s+alert|account\s+(?:was\s+)?(?:locked|suspended|compromised)|someone\s+(?:has\s+)?(?:signed|logged)\s+in|verify\s+(?:it'?s|it\s+is)\s+you)\b/i;

const DEADLINE_SIGNAL =
  /\b(?:due\s+(?:today|tonight|by\s+\d)|expires?\s+(?:today|tonight|in\s+\d{1,2}\s*(?:hours?|hrs?|minutes?))|deadline\s+(?:is\s+)?today|last\s+chance\s+today|closes?\s+(?:today|tonight)|before\s+(?:end\s+of\s+day|eod)|by\s+(?:end\s+of\s+day|eod|close\s+of\s+business|cob))\b/i;

const URGENT_LANGUAGE =
  /\b(?:urgent(?:ly)?|asap|as\s+soon\s+as\s+possible|immediate(?:ly)?\s+(?:action|attention|response)|action\s+required|response\s+(?:needed|required)|time[-\s]sensitive|emergency|critical\s+issue|blocking|need\s+(?:your\s+)?(?:answer|decision|approval)\s+(?:today|now)|are\s+you\s+(?:free|available)\s+now)\b/i;

// Anything bulk is disqualified outright, regardless of how loud its subject
// line is. Marketing is the single largest source of urgency vocabulary.
const BULK_LANGUAGE =
  /\b(?:unsubscribe|manage\s+(?:your\s+)?preferences|view\s+(?:this\s+)?(?:email\s+)?in\s+(?:your\s+)?browser|you\s+(?:are\s+)?receiving\s+this\s+(?:email|message)\s+because|promotional|newsletter|limited\s+time\s+offer|shop\s+now|% off)\b/i;

const BULK_LABELS = new Set([
  'CATEGORY_PROMOTIONS',
  'CATEGORY_SOCIAL',
  'CATEGORY_UPDATES',
  'CATEGORY_FORUMS',
  'SPAM',
  'TRASH',
]);

const BULK_HEADERS = ['list-unsubscribe', 'list-id', 'precedence', 'x-campaign-id', 'x-mailer-campaign'];

function headerRecord(headers: unknown): Record<string, string> {
  if (!headers) return {};
  const record: Record<string, string> = {};
  if (Array.isArray(headers)) {
    for (const entry of headers) {
      const name = String((entry as any)?.name || '').toLowerCase();
      if (name) record[name] = String((entry as any)?.value ?? '');
    }
    return record;
  }
  if (typeof headers === 'object') {
    for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
      record[name.toLowerCase()] = String(value ?? '');
    }
  }
  return record;
}

export function isBulkMail(message: UrgencyMessage): boolean {
  const headers = headerRecord(message.headers);
  for (const name of BULK_HEADERS) {
    const value = headers[name];
    if (!value) continue;
    // `Precedence: list|bulk` marks bulk; other precedence values do not.
    if (name === 'precedence' && !/\b(?:list|bulk|junk)\b/i.test(value)) continue;
    return true;
  }
  if ((message.labels || []).some((label) => BULK_LABELS.has(label))) return true;
  const text = `${message.snippet || ''}\n${message.textBody || ''}`.slice(0, 8_000);
  return BULK_LANGUAGE.test(text);
}

export function assessUrgency(
  message: UrgencyMessage,
  options: { hasOneTimeCode?: boolean; now?: number } = {},
): UrgencyAssessment {
  const notUrgent: UrgencyAssessment = {
    urgent: false,
    reason: '',
    kind: 'language',
    needsConfirmation: false,
  };
  const now = options.now ?? Date.now();

  // Stale mail is never an interruption. A redelivered webhook backlog is the
  // common way old messages reach this path, and pushing that batch would fire
  // a burst of alerts for mail the user read days ago.
  if (message.receivedAt && message.receivedAt < now - 6 * HOUR_MS) return notUrgent;
  if (isBulkMail(message)) return notUrgent;

  const text = `${message.subject || ''}\n${message.snippet || ''}\n${message.textBody || ''}`.slice(
    0,
    8_000,
  );

  if (options.hasOneTimeCode) {
    return {
      urgent: true,
      reason: 'Contains a verification code',
      kind: 'code',
      needsConfirmation: false,
    };
  }
  if (SECURITY_SIGNAL.test(text)) {
    return {
      urgent: true,
      reason: 'Account security alert',
      kind: 'security',
      needsConfirmation: false,
    };
  }
  if (DEADLINE_SIGNAL.test(text)) {
    return {
      urgent: true,
      reason: 'Has a deadline today',
      kind: 'deadline',
      needsConfirmation: true,
    };
  }
  if (URGENT_LANGUAGE.test(text)) {
    return {
      urgent: true,
      reason: 'Asks for a response now',
      kind: 'language',
      needsConfirmation: true,
    };
  }
  return notUrgent;
}

/**
 * Parses the nano confirmation reply. Anything that is not an explicit,
 * confident yes reads as no — a malformed reply must not become an alert.
 */
export function parseUrgencyConfirmation(raw: string): { urgent: boolean; reason: string } {
  const unfenced = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start < 0 || end <= start) return { urgent: false, reason: '' };
  let value: any;
  try {
    value = JSON.parse(unfenced.slice(start, end + 1));
  } catch {
    return { urgent: false, reason: '' };
  }
  if (value?.urgent !== true) return { urgent: false, reason: '' };
  if (!(Number(value?.confidence) >= 0.75)) return { urgent: false, reason: '' };
  const reason = String(value?.reason || '')
    .trim()
    .slice(0, 120);
  return reason ? { urgent: true, reason } : { urgent: false, reason: '' };
}

export const URGENCY_CONFIRMATION_SYSTEM_PROMPT =
  "You decide whether an email justifies interrupting someone through a Focus mode on their phone. Say yes only when a specific person needs a specific response or action from the recipient within hours, and the recipient would be worse off learning about it later today. Say no to newsletters, marketing, automated reports, notifications, receipts, scheduling that is not for today, and anything whose urgency is the sender's framing rather than a real deadline. Return only JSON with: urgent (boolean), confidence (0-1), reason (a short phrase, at most eight words, stating what is needed).";
