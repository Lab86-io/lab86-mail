import { describe, expect, test } from 'bun:test';
import { captureWork } from '../lib/albatross/capture-work';

const user = {
  userId: 'user_capture',
  email: 'owner@example.com',
  name: 'Owner',
  source: 'clerk' as const,
};

// Wednesday 2026-09-02, 09:00 local time.
const NOW = new Date(2026, 8, 2, 9, 0, 0, 0).getTime();
const localDay = (year: number, month: number, day: number) =>
  new Date(year, month, day, 0, 0, 0, 0).getTime();

const areas = [
  { _id: 'area-1', name: 'Home Care', kind: 'life', description: 'The house.' },
  { _id: 'area-2', name: 'Consulting', kind: 'work', description: 'Client work.' },
];

const facts = [
  { areaId: 'area-1', kind: 'address', value: '12 Elm Street' },
  { areaId: 'area-2', kind: 'client', value: 'Acme' },
];

interface DependencyOptions {
  areas?: any[];
  facts?: any[];
  text?: string;
  generateError?: Error;
  finishError?: Error;
  queriesFail?: boolean;
}

function makeDependencies(options: DependencyOptions = {}) {
  const mutations: Array<{ name: string; args: any }> = [];
  const generateCalls: any[] = [];
  const deps = {
    generate: async (generateOptions: any) => {
      generateCalls.push(generateOptions);
      if (options.generateError) throw options.generateError;
      return { text: options.text ?? '' };
    },
    mutate: async (_fn: unknown, args: any) => {
      if ('items' in args) {
        mutations.push({ name: 'finishCapture', args });
        if (options.finishError) throw options.finishError;
        return args.items.map((_: unknown, index: number) => `work-${index + 1}`);
      }
      if ('error' in args) {
        mutations.push({ name: 'failCapture', args });
        return null;
      }
      mutations.push({ name: 'beginCapture', args });
      return 'capture-1';
    },
    query: async (_fn: unknown, args: any) => {
      if (options.queriesFail) throw new Error('convex down');
      return 'status' in args ? (options.areas ?? []) : (options.facts ?? []);
    },
    now: () => NOW,
  } as any;
  return { deps, mutations, generateCalls };
}

describe('captureWork', () => {
  test('rejects empty dumps before creating any capture row', async () => {
    const { deps, mutations } = makeDependencies();

    await expect(captureWork({ rawText: '   ', source: 'text' }, user, deps)).rejects.toThrow(
      'rawText required',
    );
    expect(mutations).toEqual([]);
  });

  test('reviewed items skip the splitter and commit exactly what the user approved', async () => {
    const { deps, mutations, generateCalls } = makeDependencies();
    const result = await captureWork(
      {
        rawText: 'the original dump',
        source: 'text',
        areaId: 'area-1',
        reviewedItems: [
          { title: '  Fix gutters  ', rawText: '  fix the gutters  ' },
          { title: '', rawText: 'send the Acme invoice' },
        ],
      },
      user,
      deps,
    );
    expect(result.status).toBe('split');
    expect(result.workIds).toHaveLength(2);
    expect(generateCalls).toEqual([]);
    const finish = mutations.find((mutation) => mutation.name === 'finishCapture');
    expect(finish!.args.items[0]).toMatchObject({
      title: 'Fix gutters',
      rawText: 'fix the gutters',
      primaryAreaId: 'area-1',
    });
    // A missing title falls back without inventing content.
    expect(finish!.args.items[1].title).toBe('Work');
  });

  test('an empty reviewed item falls back to one verbatim Work item', async () => {
    const { deps, mutations } = makeDependencies();
    const result = await captureWork(
      {
        rawText: 'keep this dump',
        source: 'text',
        reviewedItems: [{ title: 'Empty', rawText: '   ' }],
      },
      user,
      deps,
    );
    expect(result.fallback).toBe(true);
    const finish = mutations.find((mutation) => mutation.name === 'finishCapture');
    expect(finish!.args.items[0].rawText).toBe('keep this dump');
  });

  test('the splitter carries shape onto the committed items', async () => {
    const { deps, mutations, generateCalls } = makeDependencies({
      areas,
      facts,
      text: JSON.stringify({
        work: [{ title: 'Renew the passport', rawText: 'renew it', shape: 'quick' }],
      }),
    });
    await captureWork({ rawText: 'renew my passport', source: 'text' }, user, deps);
    const finish = mutations.find((mutation) => mutation.name === 'finishCapture');
    expect(finish!.args.items[0].shape).toBe('quick');
    // The prompt contract: the splitter is taught the shape taxonomy and the
    // schema names the field, so a lost import cannot fail silently.
    expect(generateCalls[0].system).toContain('Classify the shape of each outcome');
    expect(generateCalls[0].system).toContain('"shape":"quick"|"project"|"practice"');
  });

  test('the splitter horizon wins and the deterministic parse is the fallback', async () => {
    const { deps, mutations, generateCalls } = makeDependencies({
      areas,
      facts,
      text: JSON.stringify({
        work: [
          {
            title: 'Renew the passport',
            rawText: 'renew the passport, not before November',
            horizon: {
              kind: 'later',
              notBeforeIso: '2026-12-01T00:00:00.000Z',
              label: 'not before December',
            },
          },
          { title: 'Book the cabin', rawText: 'book the cabin after Thanksgiving', horizon: null },
          { title: 'Learn to sail', rawText: 'learn to sail someday', horizon: { kind: 'bogus' } },
          { title: 'Send the invoice', rawText: 'send the invoice', horizon: { kind: 'now' } },
        ],
      }),
    });
    await captureWork({ rawText: 'brain dump', source: 'text' }, user, deps);
    const items = mutations.find((mutation) => mutation.name === 'finishCapture')!.args.items;
    // The model's read is kept as given.
    expect(items[0].horizon).toEqual({
      kind: 'later',
      notBefore: Date.parse('2026-12-01T00:00:00.000Z'),
      label: 'not before December',
    });
    // A null or unusable horizon falls back to the words of the item.
    expect(items[1].horizon).toEqual({ kind: 'later', label: 'after thanksgiving' });
    expect(items[2].horizon).toEqual({ kind: 'someday', label: 'someday' });
    // "now" with no date and no label is no horizon at all.
    expect(items[3].horizon).toBeUndefined();
    expect(generateCalls[0].system).toContain('"horizon":{"kind":"now"|"later"|"someday"');
    expect(generateCalls[0].system).toContain('Today is 2026-09-02');
  });

  test('reviewed items and the verbatim fallback parse the horizon from the text', async () => {
    const reviewed = makeDependencies({});
    await captureWork(
      {
        rawText: 'dump',
        source: 'text',
        reviewedItems: [{ title: 'Budget', rawText: 'Look at the budget next month' }],
      },
      user,
      reviewed.deps,
    );
    expect(
      reviewed.mutations.find((mutation) => mutation.name === 'finishCapture')!.args.items[0].horizon,
    ).toEqual({
      kind: 'later',
      notBefore: localDay(2026, 9, 1),
      label: 'next month',
    });

    const fallback = makeDependencies({ generateError: new Error('model down') });
    const result = await captureWork(
      { rawText: 'Fix the shed door in two weeks', source: 'text' },
      user,
      fallback.deps,
    );
    expect(result.fallback).toBe(true);
    expect(
      fallback.mutations.find((mutation) => mutation.name === 'finishCapture')!.args.items[0].horizon,
    ).toEqual({
      kind: 'later',
      notBefore: localDay(2026, 8, 16),
      label: 'in two weeks',
    });
  });

  test('splits a dump into Work and resolves model area names against active Areas', async () => {
    const { deps, mutations, generateCalls } = makeDependencies({
      areas,
      facts,
      text: JSON.stringify({
        work: [
          {
            title: 'Fix gutters',
            rawText: 'fix the gutters before the rain',
            primaryAreaName: ' HOME  care ',
            relatedAreaNames: ['Consulting', 'Home Care', 'Made Up', 'Consulting'],
          },
          {
            title: 'Invoice client',
            rawText: 'send the Acme invoice',
            primaryAreaName: null,
            relatedAreaNames: [],
          },
        ],
      }),
    });

    const result = await captureWork(
      { rawText: '  fix gutters, invoice Acme  ', transcript: 'spoken', source: 'voice' },
      user,
      deps,
    );

    expect(result).toEqual({ captureId: 'capture-1', status: 'split', workIds: ['work-1', 'work-2'] });
    expect(mutations[0]).toEqual({
      name: 'beginCapture',
      args: {
        userId: user.userId,
        rawText: 'fix gutters, invoice Acme',
        transcript: 'spoken',
        source: 'voice',
      },
    });
    expect(mutations[1]).toEqual({
      name: 'finishCapture',
      args: {
        userId: user.userId,
        captureId: 'capture-1',
        items: [
          {
            title: 'Fix gutters',
            rawText: 'fix the gutters before the rain',
            primaryAreaId: 'area-1',
            relatedAreaIds: ['area-2'],
          },
          {
            title: 'Invoice client',
            rawText: 'send the Acme invoice',
            primaryAreaId: undefined,
            relatedAreaIds: [],
          },
        ],
      },
    });
    expect(generateCalls[0]).toMatchObject({
      feature: 'albatross_capture_split',
      speed: 'fast',
      userId: user.userId,
    });
    expect(generateCalls[0].prompt).toContain('address: 12 Elm Street');
    expect(generateCalls[0].prompt).toContain('fix gutters, invoice Acme');
  });

  test('a requested area pins the primary and never repeats it as related', async () => {
    const { deps, mutations } = makeDependencies({
      areas,
      facts: [],
      text: JSON.stringify({
        work: [
          {
            title: 'Prep workshop',
            rawText: 'prep the workshop deck',
            primaryAreaName: 'Home Care',
            relatedAreaNames: ['Consulting'],
          },
        ],
      }),
    });

    await captureWork({ rawText: 'prep the workshop deck', source: 'text', areaId: 'area-2' }, user, deps);

    expect(mutations[1].args.items).toEqual([
      {
        title: 'Prep workshop',
        rawText: 'prep the workshop deck',
        primaryAreaId: 'area-2',
        relatedAreaIds: [],
      },
    ]);
  });

  test('area lookup failures degrade to an area-free split instead of blocking capture', async () => {
    const { deps, mutations, generateCalls } = makeDependencies({
      queriesFail: true,
      text: JSON.stringify({
        work: [{ title: 'Call dentist', rawText: 'call the dentist', primaryAreaName: 'Home Care' }],
      }),
    });

    const result = await captureWork({ rawText: 'call the dentist', source: 'text' }, user, deps);

    expect(result.workIds).toEqual(['work-1']);
    expect(result.fallback).toBeUndefined();
    expect(generateCalls[0].prompt).toContain('Active Areas:\n[]');
    expect(mutations[1].args.items[0]).toMatchObject({ primaryAreaId: undefined, relatedAreaIds: [] });
  });

  test('unparseable model output preserves the dump verbatim as one Work item', async () => {
    const { deps, mutations } = makeDependencies({ areas, facts, text: 'Sorry, I cannot help with that.' });

    const result = await captureWork(
      { rawText: 'Renew passport before the trip', source: 'text' },
      user,
      deps,
    );

    expect(result).toEqual({ captureId: 'capture-1', status: 'split', workIds: ['work-1'] });
    expect(mutations[1].args.items).toEqual([
      {
        title: 'Renew passport before the trip',
        rawText: 'Renew passport before the trip',
        primaryAreaId: undefined,
        relatedAreaIds: [],
      },
    ]);
  });

  test('a model failure commits one verbatim fallback item so the dump is never lost', async () => {
    const { deps, mutations } = makeDependencies({ areas, generateError: new Error('model offline') });

    const result = await captureWork(
      { rawText: 'water the plants', source: 'chat', areaId: 'area-1' },
      user,
      deps,
    );

    expect(result).toEqual({ captureId: 'capture-1', status: 'split', workIds: ['work-1'], fallback: true });
    expect(mutations.map((mutation) => mutation.name)).toEqual(['beginCapture', 'finishCapture']);
    expect(mutations[1].args.items).toEqual([
      {
        title: 'water the plants',
        rawText: 'water the plants',
        relatedAreaIds: [],
        primaryAreaId: 'area-1',
      },
    ]);
  });

  test('marks the capture failed and rethrows when even the fallback commit fails', async () => {
    const { deps, mutations } = makeDependencies({
      generateError: new Error('model offline'),
      finishError: new Error('convex write refused'),
    });

    await expect(captureWork({ rawText: 'water the plants', source: 'text' }, user, deps)).rejects.toThrow(
      'model offline',
    );
    expect(mutations.map((mutation) => mutation.name)).toEqual([
      'beginCapture',
      'finishCapture',
      'failCapture',
    ]);
    expect(mutations[2].args).toEqual({
      userId: user.userId,
      captureId: 'capture-1',
      error: 'model offline',
    });
  });
});
