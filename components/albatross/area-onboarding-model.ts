// Pure model for the Albatross area onboarding wizard: suggestion chips, entry
// classification, and the wizard state machine. No React, no DOM - exercised
// directly by tests/albatross-area-onboarding.test.ts via AreaOnboarding.tsx.

export const AREA_KIND_OPTIONS = [
  { value: 'job', label: 'Job' },
  { value: 'work', label: 'Work' },
  { value: 'personal', label: 'Personal' },
  { value: 'admin', label: 'Admin' },
  { value: 'learning', label: 'Learning' },
  { value: 'habit', label: 'Habit' },
  { value: 'other', label: 'Other' },
] as const;

// Suggestions to tap, never pre-seeded data: nothing exists until the user says so.
export const SUGGESTED_AREAS: { name: string; kind: string }[] = [
  { name: 'Job', kind: 'job' },
  { name: 'Side projects', kind: 'work' },
  { name: 'Money', kind: 'admin' },
  { name: 'Home', kind: 'personal' },
  { name: 'Health', kind: 'habit' },
  { name: 'Music', kind: 'learning' },
  { name: 'Trips', kind: 'personal' },
];

export type FactEntryKind = 'domain' | 'email' | 'website' | 'person' | 'note';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const URL_RE = /^(https?:\/\/|www\.)\S+$/i;
const DOMAIN_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/i;

/** Classify a free-typed entry: domain, email, URL, "person: role", else note. */
export function factKindForEntry(entry: string): FactEntryKind {
  const text = entry.trim();
  if (!text) return 'note';
  if (EMAIL_RE.test(text)) return 'email';
  if (URL_RE.test(text)) return 'website';
  if (DOMAIN_RE.test(text)) return 'domain';
  if (/^[^:/@\d][^:/@]{0,59}:\s*\S/.test(text)) return 'person';
  return 'note';
}

export function hostnameForUrl(url: string): string {
  try {
    return new URL(url.startsWith('http') ? url : `https://${url}`).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export interface AreaFactLike {
  _id: string;
  kind: string;
  value: string;
  status: 'candidate' | 'verified' | 'rejected' | 'superseded';
  sourceRefs?: { kind: string; id: string; url?: string; label?: string }[];
}

export function groupAreaFacts(facts: AreaFactLike[] | undefined): {
  candidates: AreaFactLike[];
  verified: AreaFactLike[];
} {
  const candidates: AreaFactLike[] = [];
  const verified: AreaFactLike[] = [];
  for (const fact of facts ?? []) {
    if (fact.status === 'candidate') candidates.push(fact);
    else if (fact.status === 'verified') verified.push(fact);
  }
  return { candidates, verified };
}

export function factSourceLinks(fact: AreaFactLike): { url: string; label: string }[] {
  const seen = new Set<string>();
  const links: { url: string; label: string }[] = [];
  for (const ref of fact.sourceRefs ?? []) {
    if (!ref.url || seen.has(ref.url)) continue;
    seen.add(ref.url);
    links.push({ url: ref.url, label: ref.label || hostnameForUrl(ref.url) });
  }
  return links;
}

export type WizardStep = 'areas' | 'facts' | 'done';

export interface DraftArea {
  key: string;
  name: string;
  kind: string;
  description: string;
  save: 'draft' | 'saving' | 'saved' | 'failed';
  areaId?: string;
  existing?: boolean;
  error?: string;
  factCount: number;
}

export interface WizardState {
  step: WizardStep;
  drafts: DraftArea[];
  factIndex: number;
  rerun: boolean;
}

export type WizardEvent =
  | { type: 'hydrate'; existing: { areaId: string; name: string; kind?: string; description?: string }[] }
  | { type: 'add_area'; name: string; kind?: string }
  | { type: 'remove_area'; key: string }
  | { type: 'edit_area'; key: string; patch: Partial<Pick<DraftArea, 'name' | 'kind' | 'description'>> }
  | { type: 'area_saving'; key: string }
  | { type: 'area_saved'; key: string; areaId: string }
  | { type: 'area_failed'; key: string; error: string }
  | { type: 'begin_facts' }
  | { type: 'jump_to_area'; areaId: string }
  | { type: 'fact_added'; count?: number }
  | { type: 'next_area' }
  | { type: 'skip_facts' }
  | { type: 'back_to_areas' };

export function areaKeyFor(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-');
}

export function initialWizardState(): WizardState {
  return { step: 'areas', drafts: [], factIndex: 0, rerun: false };
}

export function savedAreas(state: WizardState): DraftArea[] {
  return state.drafts.filter((draft) => draft.save === 'saved');
}

export function wizardCounts(state: WizardState): { areasCreated: number; factsAdded: number } {
  return {
    areasCreated: state.drafts.filter((draft) => draft.save === 'saved' && !draft.existing).length,
    factsAdded: state.drafts.reduce((sum, draft) => sum + draft.factCount, 0),
  };
}

function patchDraft(state: WizardState, key: string, patch: Partial<DraftArea>): WizardState {
  return {
    ...state,
    drafts: state.drafts.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)),
  };
}

export function wizardReducer(state: WizardState, event: WizardEvent): WizardState {
  switch (event.type) {
    case 'hydrate':
      return {
        step: 'areas',
        factIndex: 0,
        rerun: event.existing.length > 0,
        drafts: event.existing.map((area) => ({
          key: areaKeyFor(area.name) || area.areaId,
          name: area.name,
          kind: area.kind || 'other',
          description: area.description || '',
          save: 'saved',
          areaId: area.areaId,
          existing: true,
          factCount: 0,
        })),
      };
    case 'add_area': {
      const name = event.name.trim();
      const key = areaKeyFor(name);
      if (!name || state.drafts.some((draft) => draft.key === key)) return state;
      return {
        ...state,
        drafts: [
          ...state.drafts,
          { key, name, kind: event.kind || 'other', description: '', save: 'draft', factCount: 0 },
        ],
      };
    }
    case 'remove_area':
      // Saved areas are real server rows now; only unsaved drafts can be plucked out.
      return {
        ...state,
        drafts: state.drafts.filter((draft) => draft.key !== event.key || draft.save === 'saved'),
      };
    case 'edit_area': {
      const target = state.drafts.find((draft) => draft.key === event.key);
      if (!target || target.save === 'saved' || target.save === 'saving') return state;
      return patchDraft(state, event.key, event.patch);
    }
    case 'area_saving':
      return patchDraft(state, event.key, { save: 'saving', error: undefined });
    case 'area_saved':
      return patchDraft(state, event.key, { save: 'saved', areaId: event.areaId, error: undefined });
    case 'area_failed':
      return patchDraft(state, event.key, { save: 'failed', error: event.error });
    case 'begin_facts': {
      // Only advance once every row settled and at least one area is real;
      // failed rows keep the user here with inline retry.
      const settled = state.drafts.every((draft) => draft.save === 'saved');
      if (!settled || savedAreas(state).length === 0) return state;
      return { ...state, step: 'facts', factIndex: 0 };
    }
    case 'jump_to_area': {
      const index = savedAreas(state).findIndex((draft) => draft.areaId === event.areaId);
      if (index === -1) return state;
      return { ...state, step: 'facts', factIndex: index };
    }
    case 'fact_added': {
      const area = savedAreas(state)[state.factIndex];
      if (!area || state.step !== 'facts') return state;
      return patchDraft(state, area.key, { factCount: area.factCount + (event.count ?? 1) });
    }
    case 'next_area': {
      if (state.step !== 'facts') return state;
      const next = state.factIndex + 1;
      if (next >= savedAreas(state).length) return { ...state, step: 'done' };
      return { ...state, factIndex: next };
    }
    case 'skip_facts':
      return { ...state, step: 'done' };
    case 'back_to_areas':
      return { ...state, step: 'areas' };
    default:
      return state;
  }
}
