import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import {
  type ClassifierSelection,
  loadClassifierSelection,
  loadSelectedClassifier,
  saveClassifierSelection,
} from '../lib/classifier/selection';
import * as hosted from '../lib/hosted/convex';

type Query = typeof hosted.convexQuery;
type Mutation = typeof hosted.convexMutation;

// The module keeps one cached selection per instance. A save always clears it,
// so every test starts and ends with a cold cache.
async function clearSelectionCache() {
  await saveClassifierSelection({ classifierId: 'jev-1.13', revision: 0, updatedBy: 'test' }, (async () => ({
    classifierId: 'jev-1.13',
    revision: 0,
    requeued: false,
  })) as unknown as Mutation);
}

function selectionQuery(...selections: ClassifierSelection[]) {
  let index = 0;
  return mock(async (_ref: unknown, _args: unknown) => selections[Math.min(index++, selections.length - 1)]);
}

const originalClassifier = process.env.LAB86_MAIL_CLASSIFIER;
beforeEach(async () => {
  delete process.env.LAB86_MAIL_CLASSIFIER;
  await clearSelectionCache();
});
afterEach(async () => {
  await clearSelectionCache();
  if (originalClassifier === undefined) delete process.env.LAB86_MAIL_CLASSIFIER;
  else process.env.LAB86_MAIL_CLASSIFIER = originalClassifier;
});

describe('classifier selection', () => {
  test('a load reads the deployment selection once and reuses it for ten seconds', async () => {
    let now = 1_000_000;
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const query = selectionQuery(
        { classifierId: 'tev1-4b', revision: 3 },
        { classifierId: 'jev-1.13', revision: 4 },
      );
      expect(await loadClassifierSelection(query as unknown as Query)).toEqual({
        classifierId: 'tev1-4b',
        revision: 3,
      });
      expect(getFunctionName(query.mock.calls[0][0] as any)).toBe('classifier:selection');
      expect(query.mock.calls[0][1]).toEqual({});

      now += 9_999;
      expect((await loadClassifierSelection(query as unknown as Query)).revision).toBe(3);
      expect(query).toHaveBeenCalledTimes(1);

      now += 1;
      expect(await loadClassifierSelection(query as unknown as Query)).toEqual({
        classifierId: 'jev-1.13',
        revision: 4,
      });
      expect(query).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });

  test('the selected classifier resolves through the catalog and falls back to Jev', async () => {
    const query = spyOn(hosted, 'convexQuery').mockResolvedValue({ classifierId: 'tev1-4b', revision: 2 });
    try {
      expect((await loadSelectedClassifier()).id).toBe('tev1-4b');
      expect(getFunctionName(query.mock.calls[0][0] as any)).toBe('classifier:selection');

      for (const classifierId of ['retired-model', null]) {
        await clearSelectionCache();
        query.mockResolvedValue({ classifierId, revision: 3 });
        expect((await loadSelectedClassifier()).id).toBe('jev-1.13');
      }
      expect(query).toHaveBeenCalledTimes(3);
    } finally {
      query.mockRestore();
    }
  });

  test('a save writes the switch and clears the cache so the next load reads it', async () => {
    const query = selectionQuery(
      { classifierId: 'jev-1.13', revision: 1 },
      { classifierId: 'tev1-4b', revision: 2 },
    );
    expect((await loadClassifierSelection(query as unknown as Query)).classifierId).toBe('jev-1.13');

    const mutate = mock(async (_ref: unknown, input: any) => ({
      classifierId: input.classifierId,
      revision: input.revision + 1,
      requeued: true,
    }));
    const input = { classifierId: 'tev1-4b', revision: 1, updatedBy: 'owner' };
    expect(await saveClassifierSelection(input, mutate as unknown as Mutation)).toEqual({
      classifierId: 'tev1-4b',
      revision: 2,
      requeued: true,
    });
    expect(getFunctionName(mutate.mock.calls[0][0] as any)).toBe('classifier:select');
    expect(mutate.mock.calls[0][1]).toEqual(input);

    expect(await loadClassifierSelection(query as unknown as Query)).toEqual({
      classifierId: 'tev1-4b',
      revision: 2,
    });
    expect(query).toHaveBeenCalledTimes(2);
  });

  test('a rejected save keeps the cached selection and passes the error to the caller', async () => {
    const query = selectionQuery({ classifierId: 'jev-1.13', revision: 1 });
    await loadClassifierSelection(query as unknown as Query);
    const conflict = mock(async () => {
      throw new Error('CLASSIFIER_SETTINGS_CONFLICT');
    });
    await expect(
      saveClassifierSelection(
        { classifierId: 'tev1-4b', revision: 0, updatedBy: 'owner' },
        conflict as unknown as Mutation,
      ),
    ).rejects.toThrow('CLASSIFIER_SETTINGS_CONFLICT');
    expect((await loadClassifierSelection(query as unknown as Query)).classifierId).toBe('jev-1.13');
    expect(query).toHaveBeenCalledTimes(1);
  });
});
