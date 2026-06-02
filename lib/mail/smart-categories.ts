import { emailFromHeader } from '../shared/format';
import type {
  SmartCategory,
  SmartCategoryId,
  SmartLabelDefinition,
  SmartRule,
  Thread,
} from '../shared/types';

export const DEVOPS_LABEL_ID = 'smart-label-dev-ops';

export const SMART_CATEGORY_IDS = [
  'main',
  'needs_reply',
  'waiting',
  'codes',
  'orders',
  'finance_admin',
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
  'linkedin',
  'etsy',
  'wsj',
  'dow jones',
];

const PUBLISHER_PATTERNS =
  /\b(wsj|wall street journal|dow jones|nytimes|new york times|substack|newsletter|digest|article|opinion|briefing|the 10-point|morning brief|daily brief)\b/i;
const REWARDS_PATTERNS =
  /\b(reward|rewards|loyalty|points|miles|member offer|cashback|bonus points|status miles)\b/i;
const MARKETPLACE_PROMO_PATTERNS =
  /\b(etsy|marketplace|deal|deals|gift|gifts|new arrivals|tailored to your taste|personalized|sale|offer|coupon|promo|promotion|shop now|staff picks|inspiration)\b/i;
const ORDER_PROBLEM_PATTERNS =
  /\b(delayed|failed|refund|return|action required|problem|issue|couldn't deliver|cannot deliver|delivery exception|payment failed|charge failed|requires action)\b/i;
const DEVOPS_PATTERNS =
  /\b(testflight|app store connect|github|gitlab|vercel|railway|build|deploy|deployment|pull request|issue|changelog|release notes|api|sdk|developer|docs|documentation|crash|review status)\b/i;

export interface SmartClassificationContext {
  rules?: SmartRule[];
  customLabels?: SmartLabelDefinition[];
}

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

function senderEmail(thread: Partial<Thread> & { from?: string; fromAddress?: string }) {
  return (emailFromHeader(String(thread.fromAddress || (thread as any).from || '')) || '').toLowerCase();
}

function senderDomain(thread: Partial<Thread> & { from?: string; fromAddress?: string }) {
  return senderEmail(thread).split('@')[1] || '';
}

export function isNoReplyLike(value: string | null | undefined) {
  const from = String(value || '').toLowerCase();
  return /(no-?reply|donotreply|do-not-reply|notification|notifications|automated|mailer-daemon)/i.test(from);
}

export function isCodeLike(text: string) {
  return /\b(verification|verify|code|otp|one[-\s]?time|2fa|mfa|login|sign[-\s]?in|security code|magic link|password reset|account access)\b/i.test(
    text,
  );
}

export function isOrderLike(text: string) {
  return /\b(order|shipment|shipped|delivery|delivered|tracking|refund|return|receipt|purchase|booking|reservation|out for delivery)\b/i.test(
    text,
  );
}

export function isFinanceAdminLike(text: string) {
  return /\b(invoice|bill|billing|payment|paid|failed payment|tax|legal|contract|statement|bank|wire|ach|insurance|past due|account notice)\b/i.test(
    text,
  );
}

export function isNewsletterLike(text: string) {
  return /\b(newsletter|unsubscribe|digest|weekly update|monthly update|webinar|promo|promotion|sale|offer|marketing|community update)\b/i.test(
    text,
  );
}

export function isBulkLike(thread: Partial<Thread> & { from?: string; fromAddress?: string }) {
  const h = haystack(thread);
  const signals = bulkSignals(thread);
  return (
    signals.length > 0 ||
    /\b(list-id|bulk|mailer|campaign|mailchimp|sendgrid|hubspot|constant contact)\b/i.test(h)
  );
}

export function bulkSignals(thread: Partial<Thread> & { from?: string; fromAddress?: string }) {
  const h = haystack(thread);
  const signals: string[] = [];
  if (/\bunsubscribe\b/i.test(h)) signals.push('unsubscribe');
  if (/\b(list-id|mailing list|bulk)\b/i.test(h)) signals.push('bulk_or_list');
  if (isNewsletterLike(h)) signals.push('newsletter_or_marketing');
  if (PUBLISHER_PATTERNS.test(h)) signals.push('publisher');
  if (REWARDS_PATTERNS.test(h)) signals.push('rewards');
  return [...new Set(signals)];
}

export function isHumanLike(thread: Partial<Thread> & { from?: string; fromAddress?: string }) {
  const from = String(thread.fromAddress || (thread as any).from || '');
  const email = emailFromHeader(from);
  const lower = from.toLowerCase();
  const domain = senderDomain(thread);
  const h = haystack(thread);
  if (!email) return false;
  if (isNoReplyLike(from)) return false;
  // Gmail's own Primary-tab "personal" signal beats the keyword heuristics: a
  // real person whose subject happens to contain "offer"/"sale"/"contract"
  // (e.g. a recruiter or a signed job offer) is still a person. Only hard list
  // mail and blocklisted/platform senders are excluded.
  const personalCat = (thread.labels || []).includes('CATEGORY_PERSONAL');
  const hardList =
    /\b(list-id|mailing list|bulk)\b/i.test(h) ||
    HUMAN_BLOCKLIST.some((token) => lower.includes(token)) ||
    /\b(linkedin|etsy|wsj|dowjones|nytimes|substack)\b/i.test(domain);
  if (personalCat && !hardList) return true;
  if (isBulkLike(thread)) return false;
  if (HUMAN_BLOCKLIST.some((token) => lower.includes(token))) return false;
  if (/\b(linkedin|etsy|wsj|dowjones|nytimes|substack)\b/i.test(domain)) return false;
  if (PUBLISHER_PATTERNS.test(h) || REWARDS_PATTERNS.test(h)) return false;
  return !/\b(mailer|campaign|marketing|notification|notifications)\b/i.test(h);
}

function verdict(
  thread: Partial<Thread> & { from?: string; fromAddress?: string },
  primary: SmartCategoryId,
  reason: string,
  options: Partial<SmartCategory> = {},
): SmartCategory {
  const h = haystack(thread);
  const from = String(thread.fromAddress || (thread as any).from || '');
  const labels = thread.labels || [];
  const noReply = isNoReplyLike(from);
  const urgentAutomation = isCodeLike(h) || isUrgentAdminLike(h) || isUrgentOrderLike(h);
  const human = options.isHumanLike ?? isHumanLike(thread);
  // Gmail's Updates/Promotions tabs are reliable automation signals, so a
  // demotion reason like "automated" stays accurate even when the sender
  // address looks human (e.g. billing@ rent notices).
  const isUpdatesOrPromoCat = labels.includes('CATEGORY_UPDATES') || labels.includes('CATEGORY_PROMOTIONS');
  const automated =
    options.isAutomated ?? (noReply || !human || isBulkLike(thread) || isUpdatesOrPromoCat);
  const needsAttention =
    options.needsAttention ??
    Boolean(thread.unread && (human || primary === 'codes' || primary === 'review'));

  return {
    primary,
    secondary: options.secondary || [],
    customLabels: options.customLabels || [],
    confidence: options.confidence ?? 0.75,
    reason,
    needsAttention,
    suggestedAction:
      options.suggestedAction || (needsAttention && human ? 'reply' : needsAttention ? 'read' : 'none'),
    isHumanLike: human,
    isAutomated: automated,
    allowNoReplyInMain: options.allowNoReplyInMain ?? (noReply && urgentAutomation),
    bulkSignals: options.bulkSignals || bulkSignals(thread),
    ruleHits: options.ruleHits || [],
    signals: options.signals || [],
    classifiedAt: Date.now(),
    model: options.model || 'deterministic',
  };
}

function isUrgentOrderLike(text: string) {
  return isOrderLike(text) && ORDER_PROBLEM_PATTERNS.test(text);
}

function isUrgentAdminLike(text: string) {
  return (
    isFinanceAdminLike(text) &&
    /\b(failed|past due|action required|requires action|due|locked|suspended|verify|security|breach|fraud)\b/i.test(
      text,
    )
  );
}

function isPublisherOrRewardsNoise(text: string) {
  return PUBLISHER_PATTERNS.test(text) || REWARDS_PATTERNS.test(text);
}

function isLinkedInNoise(text: string) {
  return /\blinkedin\b/i.test(text);
}

function isMarketplacePromoNoise(text: string) {
  return /\betsi\b/i.test(text) && MARKETPLACE_PROMO_PATTERNS.test(text) && !isOrderLike(text);
}

function matchRule(rule: SmartRule, thread: Partial<Thread> & { from?: string; fromAddress?: string }) {
  const match = rule.match.toLowerCase();
  const email = senderEmail(thread);
  const domain = senderDomain(thread);
  const subject = String(thread.subject || '').toLowerCase();
  const h = haystack(thread);
  if (!rule.enabled) return false;
  if (rule.scope === 'thread') return String((thread as any)._id || '').toLowerCase() === match;
  if (rule.scope === 'sender')
    return (
      email === match ||
      String(thread.fromAddress || '')
        .toLowerCase()
        .includes(match)
    );
  if (rule.scope === 'domain') return domain === match || domain.endsWith(`.${match}`);
  if (rule.scope === 'subject_pattern') return subject.includes(match) || safeRegexTest(match, subject);
  if (rule.scope === 'header') return h.includes(match);
  return false;
}

function safeRegexTest(pattern: string, value: string) {
  try {
    return new RegExp(pattern, 'i').test(value);
  } catch {
    return false;
  }
}

function devOpsMatches(thread: Partial<Thread> & { from?: string; fromAddress?: string }) {
  return DEVOPS_PATTERNS.test(haystack(thread));
}

function customLabelMatches(
  label: SmartLabelDefinition,
  thread: Partial<Thread> & { from?: string; fromAddress?: string },
) {
  if (!label.enabled) return false;
  if (label._id === DEVOPS_LABEL_ID) return devOpsMatches(thread);
  const h = haystack(thread);
  const positives = [label.name, label.description, ...label.positiveExamples].filter(Boolean);
  const negatives = label.negativeExamples.filter(Boolean);
  if (negatives.some((example) => h.includes(example.toLowerCase()))) return false;
  return positives.some((example) => example && h.includes(example.toLowerCase()));
}

function applyCustomLabels(
  smart: SmartCategory,
  thread: Partial<Thread> & { from?: string; fromAddress?: string },
  labels: SmartLabelDefinition[],
  rules: SmartRule[],
) {
  const add = new Set(smart.customLabels || []);
  const remove = new Set<string>();
  for (const label of labels) {
    if (customLabelMatches(label, thread)) add.add(label._id);
  }
  for (const rule of rules.filter((r) => matchRule(r, thread))) {
    if (rule.effect === 'always_custom_label' && rule.customLabelId) add.add(rule.customLabelId);
    if (rule.effect === 'never_custom_label' && rule.customLabelId) remove.add(rule.customLabelId);
  }
  for (const id of remove) add.delete(id);
  return { ...smart, customLabels: [...add] };
}

export function classifyThreadDeterministic(
  thread: Partial<Thread> & { from?: string; fromAddress?: string },
): SmartCategory {
  return classifyThreadWithContext(thread, {});
}

export function classifyThreadWithContext(
  thread: Partial<Thread> & { from?: string; fromAddress?: string },
  context: SmartClassificationContext = {},
): SmartCategory {
  const rules = context.rules || [];
  const customLabels = context.customLabels || [];
  const h = haystack(thread);
  const labels = thread.labels || [];
  const isPersonalCat = labels.includes('CATEGORY_PERSONAL');
  const isImportantCat = labels.includes('IMPORTANT');
  const triage = thread.triage;
  const noReply = isNoReplyLike(thread.fromAddress || (thread as any).from);
  const human = isHumanLike(thread);
  const unread = Boolean(thread.unread);
  const ruleHits = rules.filter((rule) => matchRule(rule, thread));
  const blockingRule = ruleHits.find(
    (rule) => rule.effect === 'always_noise' || rule.effect === 'never_main',
  );
  const categoryRule = ruleHits.find((rule) => rule.effect === 'always_category' && rule.category);

  if (blockingRule?.effect === 'always_noise') {
    return applyCustomLabels(
      verdict(thread, 'noise', blockingRule.reason || `User rule: ${blockingRule.name}`, {
        confidence: 1,
        needsAttention: false,
        suggestedAction: 'archive',
        ruleHits: [blockingRule._id],
        signals: ['user_rule'],
        model: 'user_rule',
      }),
      thread,
      customLabels,
      rules,
    );
  }

  if (categoryRule?.category) {
    return applyCustomLabels(
      verdict(thread, categoryRule.category, categoryRule.reason || `User rule: ${categoryRule.name}`, {
        confidence: 1,
        needsAttention: categoryRule.category === 'review' || categoryRule.category === 'main',
        ruleHits: [categoryRule._id],
        signals: ['user_rule'],
        model: 'user_rule',
      }),
      thread,
      customLabels,
      rules,
    );
  }

  if (labels.includes('TRASH') || labels.includes('SPAM')) {
    return applyCustomLabels(
      verdict(thread, 'noise', 'Trash or spam label.', { confidence: 0.95, needsAttention: false }),
      thread,
      customLabels,
      rules,
    );
  }

  // Gmail's own classification is more reliable than keyword heuristics for
  // real people. If Gmail filed this in the personal category (or flagged it
  // important) and it comes from a human, surface it in Main *before* any
  // downstream keyword-noise branch can bury it — a person who writes "offer"
  // or "opportunity" must never be dumped into Noise.
  if ((isPersonalCat || isImportantCat) && human && !blockingRule) {
    return applyCustomLabels(
      verdict(
        thread,
        'main',
        isPersonalCat
          ? 'Personal-category mail from a person.'
          : 'Gmail flagged this as important and it is from a person.',
        {
          secondary: ['needs_reply'],
          confidence: 0.82,
          needsAttention: true,
          suggestedAction: 'reply',
          signals: [isPersonalCat ? 'category_personal' : 'gmail_important', 'human'],
        },
      ),
      thread,
      customLabels,
      rules,
    );
  }

  if (isLinkedInNoise(h)) {
    return applyCustomLabels(
      verdict(thread, 'noise', 'LinkedIn is treated as platform noise by default.', {
        confidence: 0.96,
        needsAttention: false,
        suggestedAction: 'archive',
        signals: ['platform_noise'],
      }),
      thread,
      customLabels,
      rules,
    );
  }

  if (isPublisherOrRewardsNoise(h) && !human) {
    return applyCustomLabels(
      verdict(thread, 'noise', 'Publisher, newsletter, or rewards program mail defaults to Noise.', {
        confidence: 0.93,
        needsAttention: false,
        suggestedAction: 'archive',
        signals: PUBLISHER_PATTERNS.test(h) ? ['publisher_noise'] : ['rewards_noise'],
      }),
      thread,
      customLabels,
      rules,
    );
  }

  if (isMarketplacePromoNoise(h) && !human) {
    return applyCustomLabels(
      verdict(thread, 'noise', 'Marketplace promotional mail defaults to Noise.', {
        confidence: 0.91,
        needsAttention: false,
        suggestedAction: 'archive',
        signals: ['marketplace_promo'],
      }),
      thread,
      customLabels,
      rules,
    );
  }

  if (isCodeLike(h)) {
    return applyCustomLabels(
      verdict(
        thread,
        unread && !blockingRule ? 'main' : 'codes',
        'Verification, login, or account security message.',
        {
          secondary: ['codes'],
          confidence: 0.9,
          needsAttention: unread && !blockingRule,
          suggestedAction: 'read',
          allowNoReplyInMain: true,
          signals: ['code_or_security'],
        },
      ),
      thread,
      customLabels,
      rules,
    );
  }

  if (isOrderLike(h)) {
    const urgent = isUrgentOrderLike(h);
    return applyCustomLabels(
      verdict(
        thread,
        unread && urgent && !blockingRule ? 'main' : 'orders',
        urgent ? 'Order problem or required action.' : 'Order, receipt, delivery, return, or booking update.',
        {
          secondary: ['orders'],
          confidence: urgent ? 0.88 : 0.82,
          needsAttention: unread && urgent && !blockingRule,
          suggestedAction: urgent ? 'read' : 'none',
          allowNoReplyInMain: noReply && urgent,
          signals: urgent ? ['order_problem'] : ['order_update'],
        },
      ),
      thread,
      customLabels,
      rules,
    );
  }

  if (isFinanceAdminLike(h) && !PUBLISHER_PATTERNS.test(h)) {
    const urgent = isUrgentAdminLike(h);
    return applyCustomLabels(
      verdict(
        thread,
        unread && urgent && !blockingRule ? 'main' : 'finance_admin',
        urgent
          ? 'Personal finance/admin problem or required action.'
          : 'Personal finance, billing, legal, or admin message.',
        {
          secondary: ['finance_admin'],
          confidence: urgent ? 0.86 : 0.78,
          needsAttention: unread && urgent && !blockingRule,
          suggestedAction: urgent ? 'read' : 'none',
          allowNoReplyInMain: noReply && urgent,
          signals: urgent ? ['finance_admin_problem'] : ['finance_admin'],
        },
      ),
      thread,
      customLabels,
      rules,
    );
  }

  if (isBulkLike(thread) && !human) {
    return applyCustomLabels(
      verdict(thread, 'noise', 'Bulk, subscribed, list, or marketing mail defaults to Noise.', {
        confidence: 0.86,
        needsAttention: false,
        suggestedAction: 'archive',
        signals: ['bulk_noise'],
      }),
      thread,
      customLabels,
      rules,
    );
  }

  if (
    triage &&
    human &&
    !blockingRule &&
    (triage.priority === 1 || triage.priority === 2) &&
    ['reply', 'delegate', 'wait'].includes(triage.action)
  ) {
    return applyCustomLabels(
      verdict(thread, 'main', `AI triage says ${triage.action}: ${triage.reason}`, {
        secondary: triage.action === 'wait' ? ['waiting'] : ['needs_reply'],
        confidence: 0.86,
        needsAttention: true,
        suggestedAction: triage.action === 'wait' ? 'wait' : 'reply',
        signals: ['triage_attention'],
      }),
      thread,
      customLabels,
      rules,
    );
  }

  if (human) {
    if (unread && !blockingRule) {
      return applyCustomLabels(
        verdict(thread, 'main', 'Unread direct conversation from a person.', {
          secondary: ['needs_reply'],
          confidence: 0.84,
          needsAttention: true,
          suggestedAction: 'reply',
          signals: ['direct_person', 'human_unread'],
        }),
        thread,
        customLabels,
        rules,
      );
    }
    return applyCustomLabels(
      verdict(thread, 'main', 'Read direct conversation from a person.', {
        secondary: ['needs_reply'],
        confidence: 0.8,
        needsAttention: true,
        suggestedAction: 'reply',
        signals: ['direct_person', 'human_read'],
      }),
      thread,
      customLabels,
      rules,
    );
  }

  if (noReply) {
    return applyCustomLabels(
      verdict(thread, 'noise', 'Automated no-reply message without an urgent exception.', {
        confidence: 0.8,
        needsAttention: false,
        suggestedAction: 'archive',
        signals: ['no_reply'],
      }),
      thread,
      customLabels,
      rules,
    );
  }

  return applyCustomLabels(
    verdict(
      thread,
      unread ? 'review' : 'noise',
      unread ? 'Unclear unread message.' : 'Read low-confidence message.',
      {
        confidence: 0.5,
        needsAttention: unread,
        suggestedAction: unread ? 'read' : 'none',
        signals: ['uncertain'],
      },
    ),
    thread,
    customLabels,
    rules,
  );
}

export function includeInSmartCategory(thread: Partial<Thread>, category: SmartCategoryId | string) {
  const smart = thread.smartCategory || classifyThreadDeterministic(thread);
  if (category.startsWith('custom:')) {
    return (smart.customLabels || []).includes(category.slice('custom:'.length));
  }
  if (category === 'main') {
    return smart.primary === 'main';
  }
  return smart.primary === category || smart.secondary.includes(category as SmartCategoryId);
}

export function labelsForSmartCategory(
  smart: SmartCategory | null | undefined,
  customLabels: SmartLabelDefinition[] = [],
) {
  if (!smart) return [];
  const customMap = new Map(customLabels.map((label) => [label._id, label.gmailLabelName]));
  return [
    ...new Set([
      SMART_CATEGORY_GMAIL_LABELS[smart.primary],
      ...smart.secondary.map((id) => SMART_CATEGORY_GMAIL_LABELS[id]),
      ...(smart.customLabels || []).map((id) => customMap.get(id)).filter(Boolean),
    ]),
  ] as string[];
}
