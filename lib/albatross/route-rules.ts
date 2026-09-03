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

function normalize(text: string) {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
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

function mentionsMonth(text: string) {
  return MONTHS.some((month) => new RegExp(`\\b${month}\\b`).test(text));
}

/**
 * Deterministic pre-pass. Returns a verdict for the clear cases and `null`
 * when the text is unclear. A question mark always wins for "ask". Explicit
 * hold words always win for "hold". Mixed signals return `null`.
 */
export function routeHeuristic(text: string): RouteVerdict | null {
  const normalized = normalize(text);
  if (!normalized) return { route: 'ask', confidence: 0, reason: 'empty' };
  if (normalized.includes('?')) return { route: 'ask', confidence: 0.95, reason: 'question mark' };
  if (includesAny(normalized, HOLD_EXPLICIT))
    return { route: 'hold', confidence: 0.95, reason: 'explicit hold' };

  const interrogative = INTERROGATIVES.includes(firstWord(normalized));
  const askOpener = startsWithAny(normalized, ASK_OPENERS);
  const askPhrase = includesAny(normalized, ASK_PHRASES);
  const commitment = includesAny(normalized, HOLD_COMMITMENT);
  const holdVerb = startsWithAny(normalized, HOLD_VERBS);
  const horizon = includesAny(normalized, HORIZON_PHRASES) || mentionsMonth(normalized);
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
