import { emailFromHeader } from '../shared/format';
import type { SmartCategory, SmartCategoryId, Thread } from '../shared/types';

export const SMART_CATEGORY_IDS = [
  'main',
  'needs_reply',
  'waiting',
  'codes',
  'orders',
  'finance_admin',
  'newsletters',
  'noise',
  'review',
] as const satisfies readonly SmartCategoryId[];

export const SMART_CATEGORY_LABELS: Record<SmartCategoryId, string> = {
  main: 'Main',
  needs_reply: 'Needs Reply',
  waiting: 'Waiting',
  codes: 'Codes',
  orders: 'Orders',
  finance_admin: 'Finance/Admin',
  newsletters: 'Newsletters',
  noise: 'Noise',
  review: 'Review',
};

export const SMART_CATEGORY_GMAIL_LABELS: Record<SmartCategoryId, string> = {
  main: 'MailOS/Main',
  needs_reply: 'MailOS/Needs Reply',
  waiting: 'MailOS/Waiting',
  codes: 'MailOS/Codes',
  orders: 'MailOS/Orders',
  finance_admin: 'MailOS/Finance Admin',
  newsletters: 'MailOS/Newsletters',
  noise: 'MailOS/Noise',
  review: 'MailOS/Review',
};

const HUMAN_BLOCKLIST = [
  'no-reply',
  'noreply',
  'donotreply',
  'do-not-reply',
  'notification',
  'notifications',
  'newsletter',
  'updates',
  'support',
  'hello@',
  'team@',
  'info@',
  'billing@',
  'receipts@',
];

function haystack(thread: Partial<Thread> & { from?: string; fromAddress?: string }) {
  return [
    thread.fromAddress,
    (thread as any).from,
    thread.subject,
    thread.snippet,
    (thread.labels || []).join(' '),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

export function isNoReplyLike(value: string | null | undefined) {
  const from = String(value || '').toLowerCase();
  return /(no-?reply|donotreply|do-not-reply|notification|notifications|automated|mailer-daemon)/i.test(from);
}

export function isCodeLike(text: string) {
  return /\b(verification|verify|code|otp|one[-\s]?time|2fa|mfa|login|sign[-\s]?in|security code|magic link|password reset)\b/i.test(
    text,
  );
}

export function isOrderLike(text: string) {
  return /\b(order|shipment|shipped|delivery|delivered|tracking|refund|return|receipt|invoice|purchase|subscription|renewal|booking|reservation|delayed|out for delivery)\b/i.test(
    text,
  );
}

export function isFinanceAdminLike(text: string) {
  return /\b(invoice|bill|billing|payment|paid|failed payment|renewal|subscription|tax|legal|contract|statement|bank|wire|ach|receipt|past due)\b/i.test(
    text,
  );
}

export function isNewsletterLike(text: string) {
  return /\b(newsletter|unsubscribe|digest|weekly update|monthly update|webinar|promo|promotion|sale|offer|marketing|community update)\b/i.test(
    text,
  );
}

export function isHumanLike(thread: Partial<Thread> & { from?: string; fromAddress?: string }) {
  const from = String(thread.fromAddress || (thread as any).from || '');
  const email = emailFromHeader(from);
  const lower = from.toLowerCase();
  if (!email) return false;
  if (isNoReplyLike(from)) return false;
  if (HUMAN_BLOCKLIST.some((token) => lower.includes(token))) return false;
  return !/\b(list-id|bulk|mailer|campaign|mailchimp|sendgrid|hubspot|substack)\b/i.test(haystack(thread));
}

function verdict(
  thread: Partial<Thread> & { from?: string; fromAddress?: string },
  primary: SmartCategoryId,
  reason: string,
  options: Partial<SmartCategory> = {},
): SmartCategory {
  const h = haystack(thread);
  const from = String(thread.fromAddress || (thread as any).from || '');
  const noReply = isNoReplyLike(from);
  const usefulAutomation = isCodeLike(h) || isOrderLike(h) || isFinanceAdminLike(h);
  const human = options.isHumanLike ?? isHumanLike(thread);
  const automated = options.isAutomated ?? (noReply || (!human && (isNewsletterLike(h) || usefulAutomation)));
  const needsAttention =
    options.needsAttention ??
    Boolean(
      thread.unread &&
        (human ||
          primary === 'codes' ||
          primary === 'orders' ||
          primary === 'finance_admin' ||
          primary === 'review'),
    );

  return {
    primary,
    secondary: options.secondary || [],
    confidence: options.confidence ?? 0.75,
    reason,
    needsAttention,
    suggestedAction:
      options.suggestedAction || (needsAttention && human ? 'reply' : needsAttention ? 'read' : 'none'),
    isHumanLike: human,
    isAutomated: automated,
    allowNoReplyInMain: options.allowNoReplyInMain ?? (noReply && usefulAutomation),
    signals: options.signals || [],
    classifiedAt: Date.now(),
    model: options.model || 'deterministic',
  };
}

export function classifyThreadDeterministic(
  thread: Partial<Thread> & { from?: string; fromAddress?: string },
): SmartCategory {
  const h = haystack(thread);
  const labels = thread.labels || [];
  const triage = thread.triage;
  const noReply = isNoReplyLike(thread.fromAddress || (thread as any).from);
  const human = isHumanLike(thread);
  const unread = Boolean(thread.unread);

  if (labels.includes('TRASH') || labels.includes('SPAM')) {
    return verdict(thread, 'noise', 'Trash or spam label.', { confidence: 0.95, needsAttention: false });
  }

  if (isCodeLike(h)) {
    return verdict(thread, unread ? 'main' : 'codes', 'Useful code, login, or account security message.', {
      secondary: ['codes'],
      confidence: 0.88,
      needsAttention: unread,
      suggestedAction: 'read',
      allowNoReplyInMain: true,
      signals: ['code_or_security'],
    });
  }

  if (isOrderLike(h)) {
    return verdict(
      thread,
      unread ? 'main' : 'orders',
      'Order, receipt, delivery, return, or booking update.',
      {
        secondary: ['orders'],
        confidence: 0.82,
        needsAttention:
          unread &&
          /\b(delayed|failed|refund|return|action required|problem|issue|delivered|out for delivery)\b/i.test(
            h,
          ),
        suggestedAction: 'read',
        allowNoReplyInMain: noReply,
        signals: ['order_update'],
      },
    );
  }

  if (isFinanceAdminLike(h)) {
    const important = unread || /\b(failed|past due|action required|due|contract|tax|wire)\b/i.test(h);
    return verdict(
      thread,
      important ? 'main' : 'finance_admin',
      'Finance, billing, legal, or admin message.',
      {
        secondary: ['finance_admin'],
        confidence: 0.78,
        needsAttention: important,
        suggestedAction: important ? 'read' : 'none',
        allowNoReplyInMain: noReply,
        signals: ['finance_admin'],
      },
    );
  }

  if (
    triage &&
    (triage.priority === 1 || triage.priority === 2) &&
    ['reply', 'delegate', 'wait'].includes(triage.action)
  ) {
    return verdict(thread, 'main', `AI triage says ${triage.action}: ${triage.reason}`, {
      secondary: triage.action === 'wait' ? ['waiting'] : ['needs_reply'],
      confidence: 0.86,
      needsAttention: true,
      suggestedAction: triage.action === 'wait' ? 'wait' : 'reply',
      signals: ['triage_attention'],
    });
  }

  if (human) {
    if (unread) {
      return verdict(thread, 'main', 'Unread thread from a human sender.', {
        secondary: ['needs_reply'],
        confidence: 0.82,
        needsAttention: true,
        suggestedAction: 'reply',
        signals: ['human_unread'],
      });
    }
    return verdict(thread, 'needs_reply', 'Human conversation already read.', {
      confidence: 0.62,
      needsAttention: false,
      suggestedAction: 'none',
      signals: ['human_read'],
    });
  }

  if (isNewsletterLike(h)) {
    return verdict(thread, 'newsletters', 'Newsletter, digest, or promotional update.', {
      confidence: 0.84,
      needsAttention: false,
      suggestedAction: 'archive',
      signals: ['newsletter'],
    });
  }

  if (noReply) {
    return verdict(thread, 'noise', 'Automated no-reply message without a useful exception.', {
      confidence: 0.78,
      needsAttention: false,
      suggestedAction: 'archive',
      signals: ['no_reply'],
    });
  }

  return verdict(
    thread,
    unread ? 'review' : 'noise',
    unread ? 'Unclear unread message.' : 'Read low-confidence message.',
    {
      confidence: 0.5,
      needsAttention: unread,
      suggestedAction: unread ? 'read' : 'none',
      signals: ['uncertain'],
    },
  );
}

export function includeInSmartCategory(thread: Partial<Thread>, category: SmartCategoryId) {
  const smart = thread.smartCategory || classifyThreadDeterministic(thread);
  if (category === 'main') {
    return (
      smart.primary === 'main' ||
      Boolean(
        smart.needsAttention &&
          (smart.isHumanLike || smart.allowNoReplyInMain || smart.secondary.includes('needs_reply')),
      )
    );
  }
  return smart.primary === category || smart.secondary.includes(category);
}

export function labelsForSmartCategory(smart: SmartCategory | null | undefined) {
  if (!smart) return [];
  return [
    ...new Set([
      SMART_CATEGORY_GMAIL_LABELS[smart.primary],
      ...smart.secondary.map((id) => SMART_CATEGORY_GMAIL_LABELS[id]),
    ]),
  ];
}
