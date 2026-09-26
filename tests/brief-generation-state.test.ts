import { expect, test } from 'bun:test';
import { isBriefEditionGenerating, isBriefEditionRetrying } from '../lib/brief/generation';
import { migrateDailyReport } from '../lib/store/daily-reports';

test('one generating rule: partial, composing, and enriching generate; a retrying ready edition does not', () => {
  expect(isBriefEditionGenerating(null)).toBe(false);
  expect(isBriefEditionGenerating({ status: 'partial' })).toBe(true);
  expect(isBriefEditionGenerating({ status: 'ready', artifactStatus: 'composing' })).toBe(true);
  expect(isBriefEditionGenerating({ status: 'ready', artifactStatus: 'enriching' })).toBe(true);
  expect(isBriefEditionGenerating({ status: 'ready', artifactStatus: 'rendered', retrying: true })).toBe(
    false,
  );
  expect(isBriefEditionRetrying({ status: 'ready', retrying: true })).toBe(true);
  expect(isBriefEditionRetrying({ status: 'partial', retrying: true })).toBe(false);
  expect(isBriefEditionRetrying({ status: 'ready' })).toBe(false);
});

test('the read path keeps the retrying flag so readers can show the note', () => {
  const base = {
    _id: 'r',
    kind: 'morning',
    generatedAt: 1,
    title: 'Brief',
    narrative: '',
    sections: {},
  } as any;
  expect(migrateDailyReport({ ...base, status: 'ready', retrying: true }).retrying).toBe(true);
  expect(migrateDailyReport({ ...base, status: 'ready' }).retrying).toBeUndefined();
});
