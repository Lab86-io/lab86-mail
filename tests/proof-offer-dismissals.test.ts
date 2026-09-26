import { expect, test } from 'bun:test';
import {
  dismissProofMatches,
  PROOF_DISMISSALS_KEY,
  withoutDismissedProofMatches,
} from '../lib/shell/proof-dismissals';

function memory() {
  const saved = new Map<string, string>();
  return {
    saved,
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => void saved.set(key, value),
  };
}

test('Not related is remembered for the Work and thread pair only', () => {
  const store = memory();
  const matches = [{ workId: 'passport' }, { workId: 'refund' }];
  dismissProofMatches('acc', 'thread-1', ['passport'], store);
  dismissProofMatches('acc', 'thread-1', ['passport'], store);
  expect(JSON.parse(store.saved.get(PROOF_DISMISSALS_KEY) || '[]')).toHaveLength(1);
  expect(withoutDismissedProofMatches('acc', 'thread-1', matches, store)).toEqual([{ workId: 'refund' }]);
  expect(withoutDismissedProofMatches('acc', 'thread-2', matches, store)).toEqual(matches);
  expect(withoutDismissedProofMatches('other', 'thread-1', matches, store)).toEqual(matches);
});

test('bad or blocked storage never hides an offer or throws', () => {
  const bad = { getItem: () => '{nope', setItem: () => {} };
  expect(withoutDismissedProofMatches('a', 't', [{ workId: 'w' }], bad)).toHaveLength(1);
  const blocked = {
    getItem: () => null,
    setItem: () => {
      throw new Error('full');
    },
  };
  expect(() => dismissProofMatches('a', 't', ['w'], blocked)).not.toThrow();
  expect(withoutDismissedProofMatches('a', 't', [{ workId: 'w' }], null)).toHaveLength(1);
});

test('the store keeps only the newest pairs', () => {
  const store = memory();
  dismissProofMatches(
    'a',
    't',
    Array.from({ length: 510 }, (_, i) => `w${i}`),
    store,
  );
  const saved = JSON.parse(store.saved.get(PROOF_DISMISSALS_KEY) || '[]');
  expect(saved).toHaveLength(500);
  expect(withoutDismissedProofMatches('a', 't', [{ workId: 'w0' }, { workId: 'w509' }], store)).toEqual([
    { workId: 'w0' },
  ]);
});
