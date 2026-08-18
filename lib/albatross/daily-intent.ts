import type { TriageHandoffV1 } from '../shared/triage-handoff';

const INTENT_STOP_WORDS = new Set([
  'and',
  'about',
  'after',
  'again',
  'also',
  'before',
  'done',
  'for',
  'from',
  'gonna',
  'going',
  'have',
  'into',
  'just',
  'need',
  'one',
  'spend',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'this',
  'today',
  'tomorrow',
  'want',
  'will',
  'with',
  'work',
  'task',
  'tasks',
]);

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
};

export interface DailyIntentPolicy {
  text: string;
  mode: 'normal' | 'focused' | 'light';
  requestedItems?: number;
  requestedMinutes?: number;
  matchingHandoffIds: string[];
  suppressUnrelated: boolean;
  suppressedCount: number;
}

export interface ReflectionCandidate {
  kind: string;
  id: string;
  title: string;
}

export function dailyIntentBudget(text: string | null | undefined): {
  mode: 'normal' | 'light';
  requestedItems?: number;
  requestedMinutes?: number;
} {
  const value = text?.trim() || '';
  const items = requestedItemCount(value);
  const minutes = requestedMinutes(value);
  return {
    mode: isLightDay(value) ? 'light' : 'normal',
    ...(items !== undefined ? { requestedItems: items } : {}),
    ...(minutes !== undefined ? { requestedMinutes: minutes } : {}),
  };
}

function normalizeToken(token: string): string {
  const lower = token.toLocaleLowerCase();
  if (lower.length > 5 && lower.endsWith('ied')) return `${lower.slice(0, -3)}y`;
  if (lower.length > 5 && lower.endsWith('ed')) {
    let stem = lower.slice(0, -2);
    if (stem.length > 3 && stem.at(-1) === stem.at(-2)) stem = stem.slice(0, -1);
    return stem;
  }
  if (lower.length > 6 && lower.endsWith('ing')) {
    let stem = lower.slice(0, -3);
    if (stem.length > 3 && stem.at(-1) === stem.at(-2)) stem = stem.slice(0, -1);
    return stem;
  }
  if (lower.length > 4 && lower.endsWith('ies')) return `${lower.slice(0, -3)}y`;
  if (lower.length > 4 && lower.endsWith('s') && !lower.endsWith('ss')) return lower.slice(0, -1);
  return lower;
}

export function intentTerms(text: string): Set<string> {
  return new Set(
    text
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}]+/gu)
      ?.filter((term) => !INTENT_STOP_WORDS.has(term))
      .map(normalizeToken)
      .filter((term) => term.length > 2 && !INTENT_STOP_WORDS.has(term)) ?? [],
  );
}

function normalizedPhrase(text: string): string {
  return (
    text
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}]+/gu)
      ?.map(normalizeToken)
      .join(' ') ?? ''
  );
}

const UNFINISHED_REFLECTION_CUE =
  /\b(?:still\s+(?:need|have)\s+to|still\s+(?:working|work)\s+on|need(?:s)?\s+to|have\s+to|has\s+to|haven['’]?t|hasn['’]?t|didn['’]?t|don['’]?t|doesn['’]?t|did\s+not|do\s+not|does\s+not|not\s+yet|won['’]?t|will\s+not|not\s+(?:done|finished|complete)|unfinished|incomplete)\b/i;

function reflectionSaysCandidateIsUnfinished(reflection: string, titleTerms: Set<string>): boolean {
  const clauses = reflection
    .split(/[.!?;,\n]+|\b(?:and|but|however|though)\b/gi)
    .map((clause) => clause.trim())
    .filter(Boolean);
  return clauses.some((clause) => {
    if (!UNFINISHED_REFLECTION_CUE.test(clause)) return false;
    const clauseTerms = intentTerms(clause);
    const overlap = [...titleTerms].filter((term) => clauseTerms.has(term)).length;
    return overlap >= Math.min(2, titleTerms.size);
  });
}

function requestedItemCount(text: string): number | undefined {
  const match = text
    .toLocaleLowerCase()
    .match(/\b(one|two|three|four|five|six|\d{1,2}|a single)\s+(?:[\p{L}\p{N}-]+\s+){0,2}tasks?\b/u);
  if (!match) return undefined;
  if (match[1] === 'a single') return 1;
  const parsed = NUMBER_WORDS[match[1]] ?? Number(match[1]);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(12, parsed)) : undefined;
}

function requestedMinutes(text: string): number | undefined {
  const match = text
    .toLocaleLowerCase()
    .match(/\b(\d+(?:\.\d+)?|one|two|three|four|five|six|an?|half an?)\s*(hours?|hrs?|minutes?|mins?)\b/);
  if (!match) return undefined;
  const amount = match[1].startsWith('half')
    ? 0.5
    : match[1] === 'a' || match[1] === 'an'
      ? 1
      : (NUMBER_WORDS[match[1]] ?? Number.parseFloat(match[1]));
  if (!Number.isFinite(amount)) return undefined;
  const minutes = match[2].startsWith('h') ? amount * 60 : amount;
  return Math.max(15, Math.min(12 * 60, Math.round(minutes)));
}

function isLightDay(text: string): boolean {
  return [
    /\bnot (?:going|gonna) to do much\b/i,
    /\brest of (?:the )?day\b/i,
    /\bday off\b/i,
    /\btake it easy\b/i,
    /\brelax(?:ing|ed)?\b/i,
    /\benjoy(?:ing)?\b/i,
    /\bvacation\b/i,
  ].some((pattern) => pattern.test(text));
}

function handoffText(handoff: TriageHandoffV1): string {
  return [
    handoff.situation,
    handoff.assessment,
    handoff.recommendation,
    ...handoff.background,
    ...handoff.evidence.map((item) => item.label),
    handoff.primaryRef?.label,
    ...(handoff.relatedRefs ?? []).map((ref) => ref.label),
    ...(handoff.items ?? []).flatMap((item) => [
      item.ref.label,
      item.situation,
      item.assessment,
      item.recommendation,
    ]),
  ]
    .filter(Boolean)
    .join(' ');
}

function matchScore(desired: Set<string>, availableText: string): number {
  const available = intentTerms(availableText);
  return [...desired].filter((term) => available.has(term)).length;
}

/**
 * Stable ordering overlay retained for callers that need the complete index.
 * Protected records keep safety precedence; matching records lead within a
 * protection tier.
 */
export function prioritizeHandoffsForIntent(
  handoffs: TriageHandoffV1[],
  tomorrowIntent?: string | null,
): TriageHandoffV1[] {
  const desired = intentTerms(tomorrowIntent?.trim() || '');
  if (!desired.size) return [...handoffs];
  return handoffs
    .map((handoff, index) => ({
      handoff,
      index,
      matches: matchScore(desired, handoffText(handoff)),
      protected: handoff.protected === true,
    }))
    .sort((a, b) => Number(b.protected) - Number(a.protected) || b.matches - a.matches || a.index - b.index)
    .map(({ handoff }) => handoff);
}

/**
 * Applies next-day intent as an attention budget. Protected records always
 * survive. Once a concrete focus matches the canonical index, unrelated
 * optional records are suppressed instead of merely shuffled lower.
 */
export function selectHandoffsForIntent(
  handoffs: TriageHandoffV1[],
  tomorrowIntent?: string | null,
): { handoffs: TriageHandoffV1[]; policy: DailyIntentPolicy } {
  const text = tomorrowIntent?.trim() || '';
  const budget = dailyIntentBudget(text);
  const requestedItems = budget.requestedItems;
  const minutes = budget.requestedMinutes;
  const light = budget.mode === 'light';
  const desired = intentTerms(text);
  const scored = handoffs.map((handoff, index) => ({
    handoff,
    index,
    matches: desired.size ? matchScore(desired, handoffText(handoff)) : 0,
  }));
  const matching = scored.filter((item) => item.matches > 0);
  const hasFocus = matching.length > 0;
  const suppressUnrelated = Boolean(text && (hasFocus || light));
  const optionalCap =
    requestedItems ??
    (minutes !== undefined ? Math.max(1, Math.ceil(minutes / 60)) : light ? 1 : Number.POSITIVE_INFINITY);

  const ordered = scored.sort(
    (a, b) =>
      Number(Boolean(b.handoff.protected)) - Number(Boolean(a.handoff.protected)) ||
      b.matches - a.matches ||
      a.index - b.index,
  );
  let optionalUsed = 0;
  const selected = ordered.flatMap(({ handoff, matches }) => {
    if (handoff.protected) return [handoff];
    if (!suppressUnrelated) return [handoff];
    if (!matches || optionalUsed >= optionalCap) return [];
    optionalUsed += 1;
    return [handoff];
  });
  const selectedIds = new Set(selected.map((handoff) => handoff.id));
  return {
    handoffs: selected,
    policy: {
      text,
      mode: light ? 'light' : hasFocus ? 'focused' : 'normal',
      ...(requestedItems !== undefined ? { requestedItems } : {}),
      ...(minutes !== undefined ? { requestedMinutes: minutes } : {}),
      matchingHandoffIds: ordered.filter((item) => item.matches > 0).map((item) => item.handoff.id),
      suppressUnrelated,
      suppressedCount: handoffs.filter((handoff) => !selectedIds.has(handoff.id)).length,
    },
  };
}

/**
 * Repeated plan writes leave near-identical task handoffs in the index. The
 * duplicates merge into the first copy: their items and refs travel with the
 * keeper (inside the schema caps), so identity and actions survive while the
 * brief stops rendering the same outcome three times.
 */
export function mergeDuplicateTaskHandoffs(handoffs: TriageHandoffV1[]): TriageHandoffV1[] {
  const kept: Array<{ handoff: TriageHandoffV1; terms: Set<string> }> = [];
  for (const handoff of handoffs) {
    const terms =
      handoff.kind === 'task'
        ? intentTerms(handoff.primaryRef?.label || handoff.situation)
        : new Set<string>();
    const keeper =
      handoff.kind === 'task' && terms.size
        ? kept.find(({ handoff: other, terms: otherTerms }) => {
            if (other.kind !== 'task') return false;
            const overlap = [...terms].filter((term) => otherTerms.has(term)).length;
            const union = new Set([...terms, ...otherTerms]).size;
            return union > 0 && overlap / union >= 0.6;
          })
        : undefined;
    if (!keeper) {
      kept.push({ handoff: { ...handoff }, terms });
      continue;
    }
    const target = keeper.handoff;
    const knownItems = new Set(target.items.map((item) => item.sourceKey));
    for (const item of handoff.items) {
      if (target.items.length >= 8 || knownItems.has(item.sourceKey)) continue;
      knownItems.add(item.sourceKey);
      target.items = [...target.items, item];
    }
    const knownRefs = new Set(
      [target.primaryRef, ...target.relatedRefs].map((ref) => `${ref.kind}:${ref.id}`),
    );
    for (const ref of [handoff.primaryRef, ...handoff.relatedRefs]) {
      const key = `${ref.kind}:${ref.id}`;
      if (target.relatedRefs.length >= 8 || knownRefs.has(key)) continue;
      knownRefs.add(key);
      target.relatedRefs = [...target.relatedRefs, ref];
    }
    target.protected = target.protected || handoff.protected;
  }
  return kept.map(({ handoff }) => handoff);
}

export function intentAppliesToScope(intent: string | null | undefined, labels: string[]): boolean {
  const desired = intentTerms(intent?.trim() || '');
  if (!desired.size) return false;
  return labels.some((label) => matchScore(desired, label) > 0);
}

/**
 * Conservative free-text reconciliation. Exact normalized titles qualify;
 * otherwise at least two meaningful title terms and 75% coverage are needed.
 * Candidates with near-identical title vocabularies are treated as ambiguous
 * and left for explicit confirmation.
 */
export function matchReflectionCandidates(
  reflection: string,
  candidates: ReflectionCandidate[],
): ReflectionCandidate[] {
  const phrase = normalizedPhrase(reflection);
  if (!phrase || /^(?:nothing|none|nope|did not|didn t|not much|nothing today)$/.test(phrase)) {
    return [];
  }
  const reflectionTerms = intentTerms(reflection);
  const scored = candidates.flatMap((candidate) => {
    const titlePhrase = normalizedPhrase(candidate.title);
    const titleTerms = intentTerms(candidate.title);
    if (!titlePhrase || !titleTerms.size) return [];
    const exact = titlePhrase.length >= 5 && phrase.includes(titlePhrase);
    const matched = [...titleTerms].filter((term) => reflectionTerms.has(term)).length;
    const coverage = matched / titleTerms.size;
    if (!exact && (matched < 2 || coverage < 0.75)) return [];
    if (reflectionSaysCandidateIsUnfinished(reflection, titleTerms)) return [];
    return [{ candidate, titleTerms, score: (exact ? 100 : 0) + matched * 10 + coverage }];
  });
  return scored.flatMap((entry, index) => {
    const ambiguous = scored.some((other, otherIndex) => {
      if (index === otherIndex) return false;
      const overlap = [...entry.titleTerms].filter((term) => other.titleTerms.has(term)).length;
      const union = new Set([...entry.titleTerms, ...other.titleTerms]).size;
      return union > 0 && overlap / union >= 0.75 && Math.abs(entry.score - other.score) < 15;
    });
    return ambiguous ? [] : [entry.candidate];
  });
}
