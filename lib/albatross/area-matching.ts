// Pure, conservative-but-proactive matching for Area context. Exact sender
// identity remains the strongest signal elsewhere; this layer catches the
// indirect evidence users reasonably expect (GitHub notification subjects,
// repository names, project codenames, and descriptive Area facts).

const STOP_WORDS = new Set([
  'about',
  'area',
  'business',
  'company',
  'general',
  'home',
  'mail',
  'notification',
  'personal',
  'project',
  'team',
  'the',
  'this',
  'work',
]);

export interface AreaMatchFact {
  _id?: string;
  areaId: string;
  kind: string;
  value: string;
  status: 'candidate' | 'verified' | 'rejected' | 'superseded';
}

export interface AreaMatchArea {
  _id: string;
  name: string;
  kind?: string;
  description?: string;
  primaryDomain?: string;
}

export interface AreaContextMatch {
  areaId: string;
  areaName: string;
  confidence: number;
  reason: string;
  signals: string[];
  score: number;
}

function words(value: string): string[] {
  return String(value || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((word) => word.length >= 4 && !STOP_WORDS.has(word));
}

function domainStem(value: string): string[] {
  const hostname = String(value || '')
    .toLowerCase()
    .replace(/^https?:\/\//u, '')
    .replace(/^www\./u, '')
    .split(/[/?#]/u, 1)[0];
  return words(hostname.split('.').slice(0, -1).join(' '));
}

function addSignal(
  weights: Map<string, { weight: number; labels: Set<string> }>,
  value: string,
  weight: number,
  label: string,
) {
  for (const word of words(value)) {
    const current = weights.get(word) || { weight: 0, labels: new Set<string>() };
    current.weight = Math.max(current.weight, weight);
    current.labels.add(label);
    weights.set(word, current);
  }
}

/** Pick the single strongest Area hypothesis from descriptive text. */
export function matchAreaContext(input: {
  text: string;
  areas: AreaMatchArea[];
  facts: AreaMatchFact[];
}): AreaContextMatch | null {
  const haystack = new Set(words(input.text));
  if (!haystack.size) return null;
  const factsByArea = new Map<string, AreaMatchFact[]>();
  for (const fact of input.facts) {
    if (fact.status !== 'verified' && fact.status !== 'candidate') continue;
    factsByArea.set(fact.areaId, [...(factsByArea.get(fact.areaId) || []), fact]);
  }

  const ranked: AreaContextMatch[] = [];
  for (const area of input.areas) {
    const signals = new Map<string, { weight: number; labels: Set<string> }>();
    addSignal(signals, area.name, 6, `Area name “${area.name}”`);
    addSignal(signals, area.description || '', 2, 'Area description');
    for (const stem of domainStem(area.primaryDomain || '')) {
      addSignal(signals, stem, 5, `Area domain ${area.primaryDomain}`);
    }
    for (const fact of factsByArea.get(String(area._id)) || []) {
      const identityLike = /^(domain|repository|repo|organization|product|project|website|url)$/iu.test(
        fact.kind,
      );
      addSignal(
        signals,
        fact.value,
        identityLike ? (fact.status === 'verified' ? 5 : 4) : fact.status === 'verified' ? 3 : 2,
        `${fact.kind}: ${fact.value}`,
      );
    }

    let score = 0;
    const labels = new Set<string>();
    for (const [word, signal] of signals) {
      if (!haystack.has(word)) continue;
      score += signal.weight;
      for (const label of signal.labels) labels.add(label);
    }
    // One distinctive Area name/domain/repository term is enough to create a
    // candidate. Description-only prose needs corroboration from several terms.
    if (score < 5) continue;
    const matched = [...labels].slice(0, 3);
    ranked.push({
      areaId: String(area._id),
      areaName: area.name,
      score,
      confidence: Math.min(0.88, Number((0.52 + score * 0.035).toFixed(2))),
      reason: `context match to ${area.name}: ${matched.join('; ')}`,
      signals: matched,
    });
  }

  ranked.sort((left, right) => right.score - left.score || left.areaName.localeCompare(right.areaName));
  const best = ranked[0];
  if (!best) return null;
  // Do not guess between equally described Areas. A later LLM pass can use the
  // full context, and user corrections remain authoritative.
  if (ranked[1] && ranked[1].score === best.score) return null;
  return best;
}
