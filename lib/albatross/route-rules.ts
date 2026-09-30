// The pure rules for the Ask / Hold bar. No server import lives here, so the
// browser runs the same pre-pass the server runs.
//
// `route-classifier.ts` adds one model call for the text these rules cannot
// read.

// One bar, two routes. "Ask" sends the text to chat. "Hold" keeps the text
// as Work. A deterministic pre-pass decides the clear cases without a model.
// The model decides only the unclear cases, on a short timeout. Every failure
// falls back to "ask" with confidence 0, because a wrong "hold" writes a row
// and a wrong "ask" only produces a reply.

export type BarRoute = 'ask' | 'hold';

export interface RouteVerdict {
  route: BarRoute;
  confidence: number;
  reason?: string;
}

export const ROUTE_MODEL_TIMEOUT_MS = 3_000;
export const ROUTE_MODEL_MAX_OUTPUT_TOKENS = 60;
export const ROUTE_TEXT_MAX_CHARS = 2_000;

const INTERROGATIVES = [
  'what',
  'who',
  'whom',
  'whose',
  'when',
  'where',
  'why',
  'how',
  'which',
  'did',
  'does',
  'do',
  'is',
  'are',
  'was',
  'were',
  'can',
  'could',
  'would',
  'should',
  'will',
  'has',
  'have',
  'had',
  'am',
];

// Verbs that ask the assistant for an answer or an action now.
const ASK_OPENERS = [
  'show me',
  'find',
  'search',
  'look up',
  'look for',
  'tell me',
  'summarize',
  'summarise',
  'explain',
  'pull up',
  'open',
  'draft',
  'write',
  'reply to',
  'compose',
  'translate',
  'compare',
  'check if',
  'check whether',
  'list my',
  'list the',
  'give me',
  'help me understand',
];

// Phrases anywhere in the text that ask for information.
const ASK_PHRASES = [
  'need to know',
  'want to know',
  'wondering',
  'curious',
  'what did',
  'what does',
  'what is',
  'how many',
  'how much',
  'when is',
  'when did',
  'who is',
  'where is',
];

// Explicit words for keeping something.
const HOLD_EXPLICIT = [
  'hold this',
  'hold that',
  'keep this',
  'keep that',
  'remember this',
  'remember that',
  'remember to',
  'remind me',
  'note to self',
  'add to my list',
  'put this on my list',
  'do not forget',
  "don't forget",
  'todo:',
  'to-do:',
];

// A person committing to an outcome.
const HOLD_COMMITMENT = [
  'i need to',
  'i have to',
  'i should',
  'i want to',
  'i must',
  'i plan to',
  'i am going to',
  "i'm going to",
  'we need to',
  'we should',
  'we have to',
  'need to',
  'have to',
  'got to',
  'gotta',
];

// Imperatives that name an errand or a goal, not a request to the assistant.
const HOLD_VERBS = [
  'book',
  'renew',
  'pay',
  'buy',
  'cancel',
  'sign up',
  'register',
  'submit',
  'file',
  'apply for',
  'pick up',
  'drop off',
  'order',
  'fix',
  'finish',
  'ship',
  'lose',
  'call',
  'return',
  'clean',
  'prepare',
  'get the',
  'get a',
  'start',
  'learn',
];

// Time words that place an outcome on a horizon.
const HORIZON_PHRASES = [
  'by friday',
  'by monday',
  'by tuesday',
  'by wednesday',
  'by thursday',
  'by saturday',
  'by sunday',
  'by next',
  'by the end of',
  'by spring',
  'by summer',
  'by fall',
  'by winter',
  'before the',
  'not before',
  'after the',
  'next week',
  'next month',
  'next year',
  'this weekend',
  'in two weeks',
  'in a week',
  'in a month',
  'someday',
  'no rush',
  'eventually',
  'tomorrow',
  'tonight',
];

// Verbs that name an action on the user's mail, calendar, contacts, files, or
// tasks. The verb alone is enough: "archive", "forward", "rsvp".
const APP_ACTION_VERBS = [
  'archive',
  'unarchive',
  'trash',
  'untrash',
  'forward',
  'reply',
  'rsvp',
  'unsubscribe',
  'star',
  'unstar',
  'label',
  'relabel',
  'unlabel',
];

// Verbs that name an app action only with an app object: "cancel the
// meeting" is an action, "cancel the gym membership" is an errand.
const APP_OBJECT_VERBS = [
  'add',
  'apply',
  'attach',
  'accept',
  'block',
  'cancel',
  'change',
  'clear',
  'close',
  'complete',
  'copy',
  'create',
  'decline',
  'delete',
  'download',
  'edit',
  'file',
  'invite',
  'mark',
  'move',
  'mute',
  'pin',
  'put',
  'remove',
  'rename',
  'reschedule',
  'restore',
  'save',
  'schedule',
  'send',
  'set',
  'share',
  'snooze',
  'tag',
  'unpin',
  'unsnooze',
  'update',
  'upload',
];

// The things those verbs act on in the app.
const APP_OBJECTS = [
  'message',
  'messages',
  'email',
  'emails',
  'e-mail',
  'e-mails',
  'mail',
  'thread',
  'threads',
  'conversation',
  'conversations',
  'inbox',
  'label',
  'labels',
  'draft',
  'drafts',
  'attachment',
  'attachments',
  'sender',
  'senders',
  'newsletter',
  'newsletters',
  'subject',
  'unread',
  'event',
  'events',
  'meeting',
  'meetings',
  'invitation',
  'invitations',
  'invite',
  'invites',
  'calendar',
  'contact',
  'contacts',
  'file',
  'files',
  'folder',
  'folders',
  'document',
  'documents',
  'doc',
  'docs',
  'spreadsheet',
  'spreadsheets',
  'slides',
  'deck',
  'presentation',
  'pdf',
  'task',
  'tasks',
  'board',
  'boards',
  'column',
];

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

// Contractions the rules read as two words. "what's" must count as the
// interrogative "what" (WRK-6).
const CONTRACTIONS: Array<[RegExp, string]> = [
  [/\b(what|who|where|when|how|why|which|that|there|it|here)'s\b/g, '$1 is'],
  [/\bcan't\b/g, 'can not'],
  [/\bwon't\b/g, 'will not'],
  [/\b(\w+)n't\b/g, '$1 not'],
  [/\bi'm\b/g, 'i am'],
  [/\b(\w+)'re\b/g, '$1 are'],
  [/\b(\w+)'ll\b/g, '$1 will'],
  [/\b(\w+)'ve\b/g, '$1 have'],
  [/\b(i|you|we|they|he|she)'d\b/g, '$1 would'],
];

function normalize(text: string) {
  let normalized = text
    .trim()
    .toLowerCase()
    // Curly and modifier apostrophes from phone keyboards.
    .replace(/[\u2018\u2019\u02bc\u2032]/g, "'")
    .replace(/\s+/g, ' ');
  for (const [pattern, replacement] of CONTRACTIONS) normalized = normalized.replace(pattern, replacement);
  return normalized;
}

function startsWithAny(text: string, phrases: string[]) {
  return phrases.some((phrase) => text === phrase || text.startsWith(`${phrase} `));
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-word match, so "i have to" does not match "i have tomorrow". */
function includesAny(text: string, phrases: string[]) {
  return phrases.some((phrase) => new RegExp(`(^|[^a-z])${escapeRegExp(phrase)}($|[^a-z])`).test(text));
}

function firstWord(text: string) {
  return text.split(' ')[0]?.replace(/[^a-z']/g, '') || '';
}

// Text in double quotes names a thing (a subject, a title, a file name). A
// date or a hold word inside it says nothing about when to act. Straight,
// curly, low-high, and angle quotes count; an apostrophe does not.
const QUOTED_SOURCE = String.raw`"[^"]*"|\u201c[^\u201d]*\u201d|\u201e[^\u201c\u201d]*[\u201c\u201d]|\u00ab[^\u00bb]*\u00bb`;

function hasQuoted(text: string) {
  return new RegExp(QUOTED_SOURCE).test(text);
}

/** The normalized text without its quoted parts. The full text when nothing stays. */
function withoutQuotes(normalized: string) {
  const stripped = normalized.replace(new RegExp(QUOTED_SOURCE, 'g'), ' ').replace(/\s+/g, ' ').trim();
  return stripped || normalized;
}

/**
 * An imperative that acts on mail, events, contacts, files, or tasks now:
 * "label the message …", "mark it as unread", "accept the invitation …".
 * A date in such a request is an argument of the action, not a deferral.
 */
function isAppAction(normalized: string, unquoted: string) {
  const text = normalized.replace(/^(please|pls|now|also|and) /, '');
  const verb = firstWord(text);
  if (APP_ACTION_VERBS.includes(verb)) return true;
  if (!APP_OBJECT_VERBS.includes(verb)) return false;
  // A quoted title names the thing the action works on.
  if (hasQuoted(text)) return true;
  // The object comes after the verb: "file the taxes" has no app object.
  const rest = unquoted.replace(/^(please|pls|now|also|and) /, '').slice(verb.length);
  if (/\bas (not )?(read|unread|important|spam|done|complete|completed)\b/.test(rest)) return true;
  return includesAny(rest, APP_OBJECTS);
}

/** Two or more items separated by commas, numbers, or line bullets. */
export function looksEnumerated(text: string) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const bulletLines = lines.filter((line) => /^([-*•]|\d+[.)])\s+/.test(line)).length;
  if (bulletLines >= 2) return true;
  const afterColon = text.includes(':') ? text.slice(text.indexOf(':') + 1) : '';
  if (afterColon && afterColon.split(',').filter((part) => part.trim()).length >= 2) return true;
  return false;
}

// "May" is also a modal verb ("may i see the invoice"). It counts as a
// month only next to a date word or a day number (WRK-6).
const MAY_AS_MONTH =
  /\b(in|by|before|after|until|since|from|of|early|mid|late|next|this|last) may\b|\bmay \d{1,2}(st|nd|rd|th)?\b|\b\d{1,2}(st|nd|rd|th)? (of )?may\b/;

function mentionsMonth(text: string) {
  return MONTHS.some((month) =>
    month === 'may' ? MAY_AS_MONTH.test(text) : new RegExp(`\\b${month}\\b`).test(text),
  );
}

/**
 * Deterministic pre-pass. Returns a verdict for the clear cases and `null`
 * when the text is unclear. A question mark always wins for "ask". Explicit
 * hold words always win for "hold". An imperative that acts on mail, events,
 * contacts, files, or tasks is "ask", also with a date in it. Mixed signals
 * return `null`. Quoted text (a subject, a title) gives no signal.
 */
export function routeHeuristic(text: string): RouteVerdict | null {
  const normalized = normalize(text);
  if (!normalized) return { route: 'ask', confidence: 0, reason: 'empty' };
  const unquoted = withoutQuotes(normalized);
  if (unquoted.includes('?')) return { route: 'ask', confidence: 0.95, reason: 'question mark' };
  if (includesAny(unquoted, HOLD_EXPLICIT))
    return { route: 'hold', confidence: 0.95, reason: 'explicit hold' };
  // "Add the label Offsite to the message "Board meeting materials for
  // October 9"" acts now. The date names the message; it does not defer.
  if (isAppAction(normalized, unquoted)) return { route: 'ask', confidence: 0.85, reason: 'app action' };

  const opener = firstWord(unquoted);
  const interrogative =
    INTERROGATIVES.includes(opener) || (opener === 'may' && /^may (i|we|you)\b/.test(unquoted));
  const askOpener = startsWithAny(unquoted, ASK_OPENERS);
  const askPhrase = includesAny(unquoted, ASK_PHRASES);
  const commitment = includesAny(unquoted, HOLD_COMMITMENT);
  const holdVerb = startsWithAny(unquoted, HOLD_VERBS);
  const horizon = includesAny(unquoted, HORIZON_PHRASES) || mentionsMonth(unquoted);
  const enumerated = looksEnumerated(text);

  const askSignals = Number(interrogative) + Number(askOpener) + Number(askPhrase);
  // A time word is weak on its own. A question about tomorrow is a question.
  const strongHoldSignals = Number(commitment) + Number(holdVerb) + Number(enumerated);
  const holdSignals = strongHoldSignals + Number(horizon);

  if (askSignals > 0 && strongHoldSignals === 0) {
    return interrogative
      ? { route: 'ask', confidence: 0.85, reason: 'interrogative' }
      : { route: 'ask', confidence: 0.8, reason: 'ask verb' };
  }
  if (holdSignals > 0 && askSignals === 0) {
    if (commitment) return { route: 'hold', confidence: 0.85, reason: 'commitment' };
    if (holdVerb) return { route: 'hold', confidence: 0.8, reason: 'errand verb' };
    if (enumerated) return { route: 'hold', confidence: 0.8, reason: 'enumerated list' };
    return { route: 'hold', confidence: 0.7, reason: 'horizon phrase' };
  }
  // A commitment with a question opener ("could you make sure I renew the
  // passport before the trip") still asks the assistant to keep the outcome.
  if (interrogative && !askOpener && !askPhrase && commitment && holdSignals >= 2) {
    return { route: 'hold', confidence: 0.7, reason: 'commitment under a question opener' };
  }
  return null;
}

export const ASK_FALLBACK: RouteVerdict = { route: 'ask', confidence: 0, reason: 'fallback' };

/**
 * Classify one bar text. Deterministic first. One fast model call when unsure.
 * Any model failure returns "ask" with confidence 0.
 */
