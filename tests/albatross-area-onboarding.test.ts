import { describe, expect, test } from 'bun:test';
import {
  AREA_KIND_OPTIONS,
  type AreaFactLike,
  areaKeyFor,
  factKindForEntry,
  factSourceLinks,
  groupAreaFacts,
  hostnameForUrl,
  initialWizardState,
  SUGGESTED_AREAS,
  savedAreas,
  type WizardState,
  wizardCounts,
  wizardReducer,
} from '../components/albatross/AreaOnboarding';

describe('AREA_KIND_OPTIONS and SUGGESTED_AREAS', () => {
  test('kinds cover the contract set', () => {
    expect(AREA_KIND_OPTIONS.map((option) => option.value)).toEqual([
      'job',
      'work',
      'personal',
      'admin',
      'learning',
      'habit',
      'other',
    ]);
  });

  test('suggestions are tappable chips with valid kinds, not pre-seeded data', () => {
    const kinds = new Set<string>(AREA_KIND_OPTIONS.map((option) => option.value));
    expect(SUGGESTED_AREAS.length).toBeGreaterThanOrEqual(5);
    for (const suggestion of SUGGESTED_AREAS) {
      expect(suggestion.name.trim().length).toBeGreaterThan(0);
      expect(kinds.has(suggestion.kind)).toBe(true);
    }
    expect(SUGGESTED_AREAS.map((s) => s.name)).toContain('Money');
  });
});

describe('factKindForEntry', () => {
  test('classifies emails', () => {
    expect(factKindForEntry('andrew@cardhunt.com')).toBe('email');
  });

  test('classifies URLs as website', () => {
    expect(factKindForEntry('https://cardhunt.com/pricing')).toBe('website');
    expect(factKindForEntry('www.statpearls.com')).toBe('website');
  });

  test('classifies bare domains', () => {
    expect(factKindForEntry('cardhunt.com')).toBe('domain');
    expect(factKindForEntry('sub.example.co.uk')).toBe('domain');
  });

  test('classifies "person: role" entries', () => {
    expect(factKindForEntry('Andrew: boss')).toBe('person');
    expect(factKindForEntry('Dr. Chen: dentist')).toBe('person');
  });

  test('falls back to note for prose and empty input', () => {
    expect(factKindForEntry('Rent is due on the 1st')).toBe('note');
    expect(factKindForEntry('')).toBe('note');
    expect(factKindForEntry('   ')).toBe('note');
  });
});

describe('hostnameForUrl', () => {
  test('extracts hostname and strips www', () => {
    expect(hostnameForUrl('https://www.yelp.com/biz/joes-coffee')).toBe('yelp.com');
    expect(hostnameForUrl('cardhunt.com/about')).toBe('cardhunt.com');
  });

  test('returns input when unparseable', () => {
    expect(hostnameForUrl('not a url')).toBe('not a url');
  });
});

describe('groupAreaFacts and factSourceLinks', () => {
  const facts: AreaFactLike[] = [
    { _id: 'f1', kind: 'person', value: 'Andrew: boss', status: 'verified' },
    {
      _id: 'f2',
      kind: 'hours',
      value: 'Mon-Fri 8-5',
      status: 'candidate',
      sourceRefs: [
        { kind: 'web_page', id: 'w1', url: 'https://joes.example.com', label: 'Joes' },
        { kind: 'web_page', id: 'w2', url: 'https://joes.example.com' },
        { kind: 'search', id: 's1' },
      ],
    },
    { _id: 'f3', kind: 'note', value: 'old', status: 'rejected' },
    { _id: 'f4', kind: 'note', value: 'older', status: 'superseded' },
  ];

  test('splits candidates from verified and drops rejected/superseded', () => {
    const grouped = groupAreaFacts(facts);
    expect(grouped.candidates.map((f) => f._id)).toEqual(['f2']);
    expect(grouped.verified.map((f) => f._id)).toEqual(['f1']);
    expect(groupAreaFacts(undefined)).toEqual({ candidates: [], verified: [] });
  });

  test('dedupes source links by url and skips refs without urls', () => {
    expect(factSourceLinks(facts[1])).toEqual([{ url: 'https://joes.example.com', label: 'Joes' }]);
    expect(factSourceLinks(facts[0])).toEqual([]);
  });
});

function addAndSave(state: WizardState, name: string, areaId: string, kind?: string): WizardState {
  let next = wizardReducer(state, { type: 'add_area', name, kind });
  const key = areaKeyFor(name);
  next = wizardReducer(next, { type: 'area_saving', key });
  return wizardReducer(next, { type: 'area_saved', key, areaId });
}

describe('wizardReducer - areas step', () => {
  test('add_area trims, defaults kind, and dedupes by normalized name', () => {
    let state = wizardReducer(initialWizardState(), { type: 'add_area', name: '  Side projects ' });
    state = wizardReducer(state, { type: 'add_area', name: 'side  projects' });
    state = wizardReducer(state, { type: 'add_area', name: '' });
    expect(state.drafts).toHaveLength(1);
    expect(state.drafts[0]).toMatchObject({
      key: 'side-projects',
      name: 'Side projects',
      kind: 'other',
      save: 'draft',
      factCount: 0,
    });
  });

  test('edit and remove only touch unsaved drafts', () => {
    let state = wizardReducer(initialWizardState(), { type: 'add_area', name: 'Money', kind: 'admin' });
    state = wizardReducer(state, {
      type: 'edit_area',
      key: 'money',
      patch: { description: 'Bills and taxes' },
    });
    expect(state.drafts[0].description).toBe('Bills and taxes');

    state = wizardReducer(state, { type: 'area_saved', key: 'money', areaId: 'a1' });
    state = wizardReducer(state, { type: 'edit_area', key: 'money', patch: { kind: 'habit' } });
    expect(state.drafts[0].kind).toBe('admin');
    state = wizardReducer(state, { type: 'remove_area', key: 'money' });
    expect(state.drafts).toHaveLength(1);
  });

  test('save lifecycle: saving -> failed keeps the row with its error, retry can recover', () => {
    let state = wizardReducer(initialWizardState(), { type: 'add_area', name: 'Trips' });
    state = wizardReducer(state, { type: 'area_saving', key: 'trips' });
    expect(state.drafts[0].save).toBe('saving');
    state = wizardReducer(state, { type: 'area_failed', key: 'trips', error: 'boom' });
    expect(state.drafts[0]).toMatchObject({ save: 'failed', error: 'boom' });
    state = wizardReducer(state, { type: 'area_saved', key: 'trips', areaId: 'a9' });
    expect(state.drafts[0]).toMatchObject({ save: 'saved', areaId: 'a9', error: undefined });
  });

  test('begin_facts refuses to advance while rows are unsettled or failed', () => {
    let state = wizardReducer(initialWizardState(), { type: 'add_area', name: 'Job', kind: 'job' });
    expect(wizardReducer(state, { type: 'begin_facts' }).step).toBe('areas');

    state = wizardReducer(state, { type: 'area_failed', key: 'job', error: 'nope' });
    expect(wizardReducer(state, { type: 'begin_facts' }).step).toBe('areas');

    state = wizardReducer(state, { type: 'area_saved', key: 'job', areaId: 'a1' });
    expect(wizardReducer(state, { type: 'begin_facts' }).step).toBe('facts');
  });

  test('begin_facts needs at least one real area', () => {
    expect(wizardReducer(initialWizardState(), { type: 'begin_facts' }).step).toBe('areas');
  });
});

describe('wizardReducer - facts and done', () => {
  function twoAreaFactsState(): WizardState {
    let state = addAndSave(initialWizardState(), 'Job', 'a1', 'job');
    state = addAndSave(state, 'Music', 'a2', 'learning');
    return wizardReducer(state, { type: 'begin_facts' });
  }

  test('fact_added counts against the current area, with multi-fact place lookups', () => {
    let state = twoAreaFactsState();
    state = wizardReducer(state, { type: 'fact_added' });
    state = wizardReducer(state, { type: 'fact_added', count: 4 });
    expect(savedAreas(state)[0].factCount).toBe(5);
    expect(savedAreas(state)[1].factCount).toBe(0);
    expect(wizardCounts(state)).toEqual({ areasCreated: 2, factsAdded: 5 });
  });

  test('next_area walks each area then lands on done', () => {
    let state = twoAreaFactsState();
    state = wizardReducer(state, { type: 'next_area' });
    expect(state).toMatchObject({ step: 'facts', factIndex: 1 });
    state = wizardReducer(state, { type: 'next_area' });
    expect(state.step).toBe('done');
  });

  test('skip_facts jumps straight to done and back_to_areas returns', () => {
    let state = twoAreaFactsState();
    state = wizardReducer(state, { type: 'skip_facts' });
    expect(state.step).toBe('done');
    expect(wizardReducer(state, { type: 'back_to_areas' }).step).toBe('areas');
  });

  test('fact_added outside the facts step is ignored', () => {
    const state = addAndSave(initialWizardState(), 'Job', 'a1');
    const next = wizardReducer(state, { type: 'fact_added' });
    expect(savedAreas(next)[0].factCount).toBe(0);
  });
});

describe('wizardReducer - re-run mode', () => {
  const existing = [
    { areaId: 'a1', name: 'CardHunt', kind: 'job', description: 'Main gig' },
    { areaId: 'a2', name: 'StatPearls', kind: 'work' },
  ];

  test('hydrate marks existing areas saved and flags rerun', () => {
    const state = wizardReducer(initialWizardState(), { type: 'hydrate', existing });
    expect(state.rerun).toBe(true);
    expect(state.step).toBe('areas');
    expect(state.drafts).toHaveLength(2);
    expect(state.drafts[0]).toMatchObject({ save: 'saved', areaId: 'a1', existing: true, kind: 'job' });
    expect(state.drafts[1].description).toBe('');
  });

  test('hydrate with no areas is a fresh run', () => {
    const state = wizardReducer(initialWizardState(), { type: 'hydrate', existing: [] });
    expect(state.rerun).toBe(false);
    expect(state.drafts).toHaveLength(0);
  });

  test('jump_to_area targets an existing area for fact entry', () => {
    let state = wizardReducer(initialWizardState(), { type: 'hydrate', existing });
    state = wizardReducer(state, { type: 'jump_to_area', areaId: 'a2' });
    expect(state).toMatchObject({ step: 'facts', factIndex: 1 });
    expect(wizardReducer(state, { type: 'jump_to_area', areaId: 'missing' })).toEqual(state);
  });

  test('new areas mix with hydrated ones and only new ones count as created', () => {
    let state = wizardReducer(initialWizardState(), { type: 'hydrate', existing });
    state = addAndSave(state, 'Habits', 'a3', 'habit');
    expect(savedAreas(state)).toHaveLength(3);
    expect(wizardCounts(state).areasCreated).toBe(1);
  });

  test('existing areas cannot be removed from the drafts list', () => {
    let state = wizardReducer(initialWizardState(), { type: 'hydrate', existing });
    state = wizardReducer(state, { type: 'remove_area', key: 'cardhunt' });
    expect(state.drafts).toHaveLength(2);
  });
});
