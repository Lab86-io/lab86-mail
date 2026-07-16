import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { __setMailClassifierLoadersForTest, kickMailClassifiers } from '../lib/mail/corpus-sync';

describe('mail corpus classifier kicks', () => {
  afterEach(() => __setMailClassifierLoadersForTest());

  test('a Smart import failure does not suppress the Area classifier', async () => {
    const areaUsers: string[] = [];
    const warning = spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      __setMailClassifierLoadersForTest({
        smart: async () => {
          throw new Error('Smart chunk unavailable');
        },
        areas: async () => ({
          kickAreaClassification: (userId: string) => areaUsers.push(userId),
        }),
      } as any);

      await kickMailClassifiers('user_1');

      expect(areaUsers).toEqual(['user_1']);
      expect(warning).toHaveBeenCalledTimes(1);
    } finally {
      warning.mockRestore();
    }
  });

  test('an Area import failure does not suppress the Smart classifier', async () => {
    const smartUsers: string[] = [];
    const warning = spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      __setMailClassifierLoadersForTest({
        smart: async () => ({
          kickLlmClassification: (userId: string) => smartUsers.push(userId),
        }),
        areas: async () => {
          throw new Error('Area chunk unavailable');
        },
      } as any);

      await kickMailClassifiers('user_2');

      expect(smartUsers).toEqual(['user_2']);
      expect(warning).toHaveBeenCalledTimes(1);
    } finally {
      warning.mockRestore();
    }
  });

  test('awaits both successful classifier kicks', async () => {
    const completed: string[] = [];
    const warning = spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      __setMailClassifierLoadersForTest({
        smart: async () => ({
          kickLlmClassification: async (userId: string) => {
            await Promise.resolve();
            completed.push(`smart:${userId}`);
          },
        }),
        areas: async () => ({
          kickAreaClassification: async (userId: string) => {
            await Promise.resolve();
            completed.push(`areas:${userId}`);
          },
        }),
      } as any);

      await kickMailClassifiers('user_3');

      expect(completed.sort()).toEqual(['areas:user_3', 'smart:user_3']);
      expect(warning).toHaveBeenCalledTimes(0);
    } finally {
      warning.mockRestore();
    }
  });
});
