import { attentionMatches, isAttentionView } from '../jev/contract';
import { explicitReplyRequested } from '../jev/fallback';
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
  'codes',
  'orders',
  'finance_admin',
  'noise',
  'review',
] as const satisfies readonly SmartCategoryId[];

export const SMART_CATEGORY_LABELS: Record<SmartCategoryId, string> = {
  main: 'Main',
  needs_reply: 'Needs Reply',
  codes: 'Codes',
  orders: 'Orders',
  finance_admin: 'Finance/Admin',
  noise: 'Noise',
  review: 'Review',
};

// Increase this number when a change to this file or to smartCategoryFromJev
// changes a stored verdict. The backlog cron then sorts every row again that
// has an older number, so stored verdicts follow the new code without a manual
// run. Also increase it when the sort writes new derived data.
// 2: relatives and forwards from people are no longer sorted as lists.
// 3: the sort writes custom-label membership rows (CLS-13).
export const SMART_CLASSIFIER_VERSION = 3;

// Gmail labels that "Apply smart labels" writes. Labels from the old product
// name keep working: labelsForSmartCategory rewrites them to this prefix.
export const SMART_GMAIL_LABEL_PREFIX = 'Albatross/';
const LEGACY_GMAIL_LABEL_PREFIX = 'MailOS/';

export const SMART_CATEGORY_GMAIL_LABELS: Record<SmartCategoryId, string> = {
  main: `${SMART_GMAIL_LABEL_PREFIX}Main`,
  needs_reply: `${SMART_GMAIL_LABEL_PREFIX}Needs Reply`,
  codes: `${SMART_GMAIL_LABEL_PREFIX}Codes`,
  orders: `${SMART_GMAIL_LABEL_PREFIX}Orders`,
  finance_admin: `${SMART_GMAIL_LABEL_PREFIX}Finance Admin`,
  noise: `${SMART_GMAIL_LABEL_PREFIX}Noise`,
  review: `${SMART_GMAIL_LABEL_PREFIX}Review`,
};

// Sender addresses that are not a person. The test reads the address only,
// with word boundaries: a display name such as "Support" or a person such as
// betsy@ is not a match.
const BLOCKED_SENDER_ADDRESS =
  /\b(no-?reply|donotreply|do-not-reply|notifications?|newsletters?|updates|support|linkedin|etsy|wsj|dowjones)\b/i;
const ROLE_MAILBOX = /^(hello|team|info|billing|receipts)@/i;
const BLOCKED_SENDER_DOMAIN = /\b(linkedin|etsy|wsj|dowjones|nytimes|substack)\b/i;

// Personal mailbox providers. Brands and platforms do not send from these, so
// a non-role address here is a person, whatever tab Gmail filed the thread in
// (a relative's Google Docs share lands in Updates).
const PERSONAL_MAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'ymail.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'fastmail.com',
  'hey.com',
  'zoho.com',
  'gmx.com',
  'gmx.de',
  'yandex.com',
  'mail.com',
]);
// iCloud Hide My Email relays a brand as `name_at_brand_com_<id>@icloud.com`.
const RELAYED_BRAND_LOCAL_PART = /_at_[a-z0-9-]+_(com|net|org|io|co|app|ai)_/i;
// A forwarded message carries the original sender's footer. Its list markers
// say nothing about the person who forwarded it.
const FORWARDED_SUBJECT = /^\s*(fwd?|fw)\s*:/i;

// Gmail tabs that a person's direct mail does not land in.
const NON_PERSONAL_GMAIL_CATEGORIES = [
  'CATEGORY_PROMOTIONS',
  'CATEGORY_UPDATES',
  'CATEGORY_SOCIAL',
  'CATEGORY_FORUMS',
];
// Gmail tabs that hold list or campaign mail.
const BULK_GMAIL_CATEGORIES = ['CATEGORY_PROMOTIONS', 'CATEGORY_FORUMS'];

const PUBLISHER_PATTERNS =
  /\b(wsj|wall street journal|dow jones|nytimes|new york times|substack|newsletter|digest|article|opinion|briefing|the 10-point|morning brief|daily brief)\b/i;
const REWARDS_PATTERNS =
  /\b(reward|rewards|loyalty|points|miles|member offer|cashback|bonus points|status miles)\b/i;
// Promo terms only. The marketplace itself is tested separately in
// isMarketplacePromoNoise, so a seller message with no promo term stays out.
const MARKETPLACE_PROMO_PATTERNS =
  /\b(marketplace|deal|deals|gift|gifts|new arrivals|tailored to your taste|personalized|sale|offer|coupon|promo|promotion|shop now|staff picks|inspiration)\b/i;
// "Return" and "refund" are not problems: nearly every shipping notice has a
// returns footer.
const ORDER_PROBLEM_PATTERNS =
  /\b(delayed|failed|action required|problem|issue|couldn't deliver|cannot deliver|delivery exception|payment failed|charge failed|requires action)\b/i;
// The fixed Dev/Ops match reads platform names in the sender and subject only.
// Generic words such as "build" or "docs" occur in the body of most mail.
const DEVOPS_PLATFORM_PATTERNS =
  /\b(testflight|app store connect|xcode cloud|github|gitlab|vercel|railway)\b/i;
// Words that make a "code" a sales code, not a sign-in code.
const PROMO_CODE_PATTERNS =
  /\b(promo|promotion|promotional|discount|coupon|voucher|sale|deal|deals|offer|offers)\b|\d+\s?%/i;

export interface SmartClassificationContext {
  rules?: SmartRule[];
  customLabels?: SmartLabelDefinition[];
}

// The fields the classifier reads. `listId` and `listUnsubscribe` are the
// latest message's list headers, when the caller has them.
export type ClassifierThread = Partial<Thread> & {
  from?: string;
  fromAddress?: string;
  bodyText?: string;
  listId?: string;
  listUnsubscribe?: string;
};

// How much of the latest message body participates in classification: the
// start for the real content, and the end for the footer ("unsubscribe", list
// boilerplate), which long marketing mail puts far down. The bound keeps one
// giant email from dominating regex time.
const BODY_HEAD_CHARS = 2500;
const BODY_TAIL_CHARS = 1500;

export function clipClassifierBody(text: string | null | undefined) {
  const body = String(text || '');
  if (body.length <= BODY_HEAD_CHARS + BODY_TAIL_CHARS) return body;
  return `${body.slice(0, BODY_HEAD_CHARS)} … ${body.slice(-BODY_TAIL_CHARS)}`;
}

export function bodyExcerpt(thread: { bodyText?: string }) {
  return clipClassifierBody(String(thread.bodyText || '').replace(/\s+/g, ' ')).toLowerCase();
}

// Subject and preview only. Urgency tests read this text, because a body
// footer ("Problem with your order?") is not an urgent problem.
function subjectSnippet(thread: ClassifierThread) {
  return [thread.subject, thread.snippet].filter(Boolean).join(' ').toLowerCase();
}

function haystack(thread: ClassifierThread) {
  return [
    thread.fromAddress,
    (thread as any).from,
    thread.subject,
    thread.snippet,
    (thread.labels || []).join(' '),
    bodyExcerpt(thread),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

// Header-level haystack (no body). Keyword branches that route mail TOWARD
// the user's attention (codes/orders/finance) gate on this: nearly every
// marketing body contains "sign in" / "view your order" / "billing" somewhere,
// and matching those against the body would promote noise wholesale.
function metaHaystack(thread: ClassifierThread) {
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

function senderEmail(thread: ClassifierThread) {
  return (emailFromHeader(String(thread.fromAddress || (thread as any).from || '')) || '').toLowerCase();
}

function senderDomain(thread: ClassifierThread) {
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

// Body-safe code detection. The loose isCodeLike terms ("login", "sign in")
// appear in virtually every marketing footer, so matching them against body
// text would promote noise into Codes/Main. Only unambiguous phrasings count
// when the evidence comes from the body.
export function isStrongCodeLike(text: string) {
  return /\b(verification code|security code|one[-\s]?time (?:code|passcode|password)|otp|2fa|two[-\s]?factor|magic link|password reset|sign[-\s]?in code|login code)\b/i.test(
    text,
  );
}

// Code detection for sender, subject, and preview text. A clear phrase always
// counts. A loose term ("code", "login") counts only when no sales term is
// near it: "Extra 30% off with code SAVE30" is a promotion.
export function isHeaderCodeLike(text: string) {
  return isStrongCodeLike(text) || (isCodeLike(text) && !PROMO_CODE_PATTERNS.test(text));
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

export function isBulkLike(thread: ClassifierThread) {
  const h = haystack(thread);
  const signals = bulkSignals(thread);
  return (
    signals.length > 0 ||
    /\b(list-id|bulk|mailer|campaign|mailchimp|sendgrid|hubspot|constant contact)\b/i.test(h)
  );
}

export function bulkSignals(thread: ClassifierThread) {
  const h = haystack(thread);
  const labels = thread.labels || [];
  const signals: string[] = [];
  if (/\bunsubscribe\b/i.test(h) || thread.listUnsubscribe) signals.push('unsubscribe');
  if (/\b(list-id|mailing list|bulk)\b/i.test(h) || thread.listId) signals.push('bulk_or_list');
  if (BULK_GMAIL_CATEGORIES.some((label) => labels.includes(label))) signals.push('gmail_bulk_category');
  if (isNewsletterLike(h)) signals.push('newsletter_or_marketing');
  if (PUBLISHER_PATTERNS.test(h)) signals.push('publisher');
  if (REWARDS_PATTERNS.test(h)) signals.push('rewards');
  return [...new Set(signals)];
}

export function isHumanLike(thread: ClassifierThread) {
  const from = String(thread.fromAddress || (thread as any).from || '');
  const email = emailFromHeader(from);
  const address = senderEmail(thread);
  const domain = senderDomain(thread);
  const labels = thread.labels || [];
  if (!email) return false;
  if (isNoReplyLike(from)) return false;
  const [localPart = ''] = address.split('@');
  const blockedAddress =
    BLOCKED_SENDER_ADDRESS.test(address) ||
    ROLE_MAILBOX.test(address) ||
    RELAYED_BRAND_LOCAL_PART.test(localPart);
  if (PERSONAL_MAIL_DOMAINS.has(domain) && !blockedAddress) return true;
  // For forwarded mail, judge the sender on the headers only.
  if (FORWARDED_SUBJECT.test(String(thread.subject || ''))) {
    thread = { ...thread, bodyText: undefined, listId: undefined, listUnsubscribe: undefined };
  }
  // Gmail's own Primary-tab "personal" signal beats the keyword heuristics: a
  // real person whose subject happens to contain "offer"/"sale"/"contract"
  // (e.g. a recruiter or a signed job offer) is still a person. Only hard list
  // mail and blocklisted/platform senders are excluded.
  const h = haystack(thread);
  const personalCat = labels.includes('CATEGORY_PERSONAL');
  // Gmail files campaign and notification mail in the other tabs. That mail
  // is not a person unless Gmail also calls the thread personal.
  if (!personalCat && NON_PERSONAL_GMAIL_CATEGORIES.some((label) => labels.includes(label))) return false;
  const blockedSender =
    BLOCKED_SENDER_ADDRESS.test(address) || ROLE_MAILBOX.test(address) || BLOCKED_SENDER_DOMAIN.test(domain);
  const hardList =
    /\b(list-id|mailing list|bulk|unsubscribe)\b/i.test(h) ||
    Boolean(thread.listId || thread.listUnsubscribe) ||
    blockedSender;
  if (personalCat && !hardList) return true;
  if (isBulkLike(thread)) return false;
  if (blockedSender) return false;
  if (PUBLISHER_PATTERNS.test(h) || REWARDS_PATTERNS.test(h)) return false;
  return !/\b(mailer|campaign|marketing|notification|notifications)\b/i.test(h);
}

function verdict(
  thread: ClassifierThread,
  primary: SmartCategoryId,
  reason: string,
  options: Partial<SmartCategory> = {},
): SmartCategory {
  const from = String(thread.fromAddress || (thread as any).from || '');
  const labels = thread.labels || [];
  const noReply = isNoReplyLike(from);
  const urgent = subjectSnippet(thread);
  const urgentAutomation =
    isHeaderCodeLike(metaHaystack(thread)) ||
    isStrongCodeLike(bodyExcerpt(thread)) ||
    isUrgentAdminLike(urgent) ||
    isUrgentOrderLike(urgent);
  const human = options.isHumanLike ?? isHumanLike(thread);
  // Gmail's Updates/Promotions tabs are reliable automation signals, so a
  // demotion reason like "automated" stays accurate even when the sender
  // address looks human (e.g. billing@ rent notices).
  const isUpdatesOrPromoCat = labels.includes('CATEGORY_UPDATES') || labels.includes('CATEGORY_PROMOTIONS');
  const automated = options.isAutomated ?? (noReply || !human || isBulkLike(thread) || isUpdatesOrPromoCat);
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
    // A bare "due" is an ordinary bill ("Amount due $54"), not a problem.
    /\b(failed|past due|overdue|action required|requires action|locked|suspended|verify|security|breach|fraud)\b/i.test(
      text,
    )
  );
}

function isPublisherOrRewardsNoise(text: string) {
  return PUBLISHER_PATTERNS.test(text) || REWARDS_PATTERNS.test(text);
}

// LinkedIn mail comes from a LinkedIn address. A person with a LinkedIn link in
// the signature is still a person.
function isLinkedInNoise(thread: ClassifierThread) {
  return /\blinkedin\b/i.test(senderDomain(thread));
}

function isMarketplacePromoNoise(text: string) {
  return /\betsy\b/i.test(text) && MARKETPLACE_PROMO_PATTERNS.test(text) && !isOrderLike(text);
}

export function smartRuleMatches(
  rule: Pick<SmartRule, 'enabled' | 'scope' | 'match'>,
  thread: ClassifierThread,
) {
  return matchRule(rule as SmartRule, thread);
}

function matchRule(rule: SmartRule, thread: ClassifierThread) {
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

// Custom labels match keywords, not meaning. A label name or an example
// matches when each of its words (less small filler words) is a whole word in
// the sender, subject, preview, Gmail labels, or body. "HR" does not match
// "https", and "Car" does not match "card". The description is for people and
// is not matched.
const LABEL_FILLER_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'fw',
  'fwd',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  're',
  'the',
  'this',
  'to',
  'with',
  'you',
  'your',
]);

export function labelTerms(text: string) {
  return [
    ...new Set(
      (
        String(text || '')
          .toLowerCase()
          .match(/[\p{L}\p{N}]+/gu) || []
      ).filter((word) => !LABEL_FILLER_WORDS.has(word)),
    ),
  ];
}

function exampleMatches(example: string, words: Set<string>) {
  const terms = labelTerms(example);
  return terms.length > 0 && terms.every((term) => words.has(term));
}

function customLabelMatches(label: SmartLabelDefinition, thread: ClassifierThread, words: Set<string>) {
  if (!label.enabled) return false;
  // The user's negative examples come first, also for the built-in Dev/Ops label.
  if ((label.negativeExamples || []).some((example) => exampleMatches(example, words))) return false;
  if (
    label._id === DEVOPS_LABEL_ID &&
    DEVOPS_PLATFORM_PATTERNS.test([thread.fromAddress, (thread as any).from, thread.subject].join(' '))
  )
    return true;
  return [label.name, ...(label.positiveExamples || [])].some((example) => exampleMatches(example, words));
}

function applyCustomLabels(
  smart: SmartCategory,
  thread: ClassifierThread,
  labels: SmartLabelDefinition[],
  rules: SmartRule[],
) {
  const add = new Set(smart.customLabels || []);
  const remove = new Set<string>();
  const words = labels.length ? new Set(labelTerms(haystack(thread))) : new Set<string>();
  for (const label of labels) {
    if (customLabelMatches(label, thread, words)) add.add(label._id);
  }
  for (const rule of rules.filter((r) => matchRule(r, thread))) {
    if (rule.effect === 'always_custom_label' && rule.customLabelId) add.add(rule.customLabelId);
    if (rule.effect === 'never_custom_label' && rule.customLabelId) remove.add(rule.customLabelId);
  }
  for (const id of remove) add.delete(id);
  return { ...smart, customLabels: [...add] };
}

export function classifyThreadDeterministic(thread: ClassifierThread): SmartCategory {
  return classifyThreadWithContext(thread, {});
}

// Rules that decide WHERE mail lives. A user who changes their mind adds a
// new rule instead of editing the old one, so the newest matching placement
// rule wins over every older one.
const PLACEMENT_EFFECTS = new Set<SmartRule['effect']>([
  'always_noise',
  'always_category',
  'always_custom_label',
  'never_main',
]);

// A label move whose label is disabled or deleted is skipped, so an older
// valid rule still decides. Mail is never filed under a label that no view
// shows.
function newestPlacementRule(hits: SmartRule[], customLabels: SmartLabelDefinition[]) {
  let newest: SmartRule | undefined;
  for (const rule of hits) {
    if (!PLACEMENT_EFFECTS.has(rule.effect)) continue;
    if (rule.effect === 'always_category' && !rule.category) continue;
    if (
      rule.effect === 'always_custom_label' &&
      !customLabels.some((label) => label._id === rule.customLabelId && label.enabled !== false)
    )
      continue;
    if (!newest || Number(rule.createdAt || 0) >= Number(newest.createdAt || 0)) newest = rule;
  }
  return newest;
}

// Index key for the stored verdict (mailCorpusThreads.smartPrimary). Filed
// mail keys on its label so no built-in category range read returns it.
export function smartIndexKey(smart: Pick<SmartCategory, 'primary' | 'filedUnder'>) {
  return smart.filedUnder ? `custom:${smart.filedUnder}` : smart.primary;
}

// Applies the user's placement rules on top of ANY verdict — deterministic,
// the lightweight model, or Jev. The model paths only defer to a verdict whose
// model is 'user_rule', so without this pass a label move or a Never Main
// rule changed nothing once a model had judged the thread. `fallback` is the
// primary to use when a Never Main rule removes a verdict from Main.
export function applyUserRuleOverrides(
  smart: SmartCategory,
  thread: ClassifierThread,
  context: SmartClassificationContext = {},
  fallback?: SmartCategoryId,
): SmartCategory {
  const { filedUnder: _stale, ...base } = smart;
  const placement = newestPlacementRule(
    (context.rules || []).filter((rule) => matchRule(rule, thread)),
    context.customLabels || [],
  );
  if (!placement) return base;
  const marked = {
    ruleHits: [...new Set([...(base.ruleHits || []), placement._id])],
    signals: [...new Set([...(base.signals || []), 'user_rule'])],
  };
  if (placement.effect === 'always_custom_label') {
    const labelId = placement.customLabelId as string;
    if (!(base.customLabels || []).includes(labelId)) return base;
    return { ...base, ...marked, filedUnder: labelId };
  }
  if (placement.effect === 'never_main' && base.primary === 'main') {
    return {
      ...base,
      ...marked,
      primary: fallback && fallback !== 'main' ? fallback : 'noise',
      needsAttention: false,
      reason: placement.reason || `User rule: ${placement.name}`,
    };
  }
  return base;
}

export function classifyThreadWithContext(
  thread: ClassifierThread,
  context: SmartClassificationContext = {},
): SmartCategory {
  return applyUserRuleOverrides(classifyBaseline(thread, context), thread, context);
}

function classifyBaseline(thread: ClassifierThread, context: SmartClassificationContext): SmartCategory {
  const rules = context.rules || [];
  const customLabels = context.customLabels || [];
  const h = haystack(thread);
  const hMeta = metaHaystack(thread);
  const body = bodyExcerpt(thread);
  const bulky = isBulkLike(thread);
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
  const placement = newestPlacementRule(ruleHits, customLabels);
  const categoryRule = placement?.effect === 'always_category' ? placement : undefined;

  if (placement?.effect === 'always_noise') {
    return applyCustomLabels(
      verdict(thread, 'noise', placement.reason || `User rule: ${placement.name}`, {
        confidence: 1,
        needsAttention: false,
        suggestedAction: 'archive',
        ruleHits: [placement._id],
        signals: ['user_rule'],
        model: 'user_rule',
      }),
      thread,
      customLabels,
      rules,
    );
  }

  if (categoryRule?.category) {
    // Needs Reply is a view over reply obligations, not a place that lists a
    // primary. A move to Needs Reply puts the mail in Main, marked for a reply.
    const toReply = categoryRule.category === 'needs_reply';
    return applyCustomLabels(
      verdict(
        thread,
        toReply ? 'main' : categoryRule.category,
        categoryRule.reason || `User rule: ${categoryRule.name}`,
        {
          secondary: toReply ? ['needs_reply'] : [],
          confidence: 1,
          needsAttention: toReply || categoryRule.category === 'review' || categoryRule.category === 'main',
          suggestedAction: toReply ? 'reply' : undefined,
          ruleHits: [categoryRule._id],
          signals: ['user_rule'],
          model: 'user_rule',
        },
      ),
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
    const replyText = String(thread.bodyText || thread.snippet || '');
    const needsReply = explicitReplyRequested(replyText);
    return applyCustomLabels(
      verdict(
        thread,
        'main',
        isPersonalCat
          ? 'Personal-category mail from a person.'
          : 'Gmail flagged this as important and it is from a person.',
        {
          secondary: needsReply ? ['needs_reply'] : [],
          confidence: 0.82,
          needsAttention: true,
          suggestedAction: needsReply ? 'reply' : 'read',
          signals: [isPersonalCat ? 'category_personal' : 'gmail_important', 'human'],
        },
      ),
      thread,
      customLabels,
      rules,
    );
  }

  if (isLinkedInNoise(thread)) {
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

  if (isHeaderCodeLike(hMeta) || isStrongCodeLike(body)) {
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

  if (isOrderLike(hMeta) || (!bulky && isOrderLike(h))) {
    const urgent = isUrgentOrderLike(subjectSnippet(thread));
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

  if ((isFinanceAdminLike(hMeta) || (!bulky && isFinanceAdminLike(h))) && !PUBLISHER_PATTERNS.test(h)) {
    const urgent = isUrgentAdminLike(subjectSnippet(thread));
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

  if (bulky && !human) {
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
      verdict(thread, 'main', `Triage marked this to ${triage.action}: ${triage.reason}`, {
        secondary: ['needs_reply'],
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
  if (isAttentionView(category) && thread.jev)
    return smart.model === 'user_rule' && smart.primary === 'noise'
      ? false
      : attentionMatches(thread.jev, category);
  if (category.startsWith('custom:')) {
    return (smart.customLabels || []).includes(category.slice('custom:'.length));
  }
  // Attention views are lenses over obligations, not places, so they still
  // include filed mail. Every built-in category leaves it out.
  if (smart.filedUnder && !isAttentionView(category)) return false;
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
  const customMap = new Map(
    customLabels.map((label) => [label._id, currentGmailLabelName(label.gmailLabelName)]),
  );
  return [
    ...new Set([
      // Mail filed under a custom label is out of its built-in category, so it
      // gets no primary category label.
      smart.filedUnder ? undefined : SMART_CATEGORY_GMAIL_LABELS[smart.primary],
      ...(smart.secondary || []).map((id) => SMART_CATEGORY_GMAIL_LABELS[id]),
      ...(smart.customLabels || []).map((id) => customMap.get(id)),
    ]),
  ].filter(Boolean) as string[];
}

// Custom labels saved before the rename keep the old prefix in storage.
export function currentGmailLabelName(name: string) {
  return name.startsWith(LEGACY_GMAIL_LABEL_PREFIX)
    ? `${SMART_GMAIL_LABEL_PREFIX}${name.slice(LEGACY_GMAIL_LABEL_PREFIX.length)}`
    : name;
}
