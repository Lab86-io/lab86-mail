import { describe, expect, test } from 'bun:test';
import { captureWork } from '../lib/albatross/capture-work';

const user = {
  userId: 'user_capture',
  email: 'owner@example.com',
  name: 'Owner',
  source: 'clerk' as const,
};

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
