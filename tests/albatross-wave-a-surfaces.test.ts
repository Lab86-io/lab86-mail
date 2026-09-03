import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { awakeWork, shelfWork, type WorkListItem } from '../components/albatross/AlbatrossesSurface';
import { sameHorizon, visibleHorizon } from '../components/albatross/WorkDetail';
import { IMPORTANT_MAIL_MAX, nextMoveWhen, TODAY_EMPTY_LINE } from '../components/report/TodaySurface';

const repoRoot = join(import.meta.dir, '..');
const read = (relative: string) => readFileSync(join(repoRoot, relative), 'utf8');

const NOW = new Date(2026, 8, 3, 10, 0, 0, 0).getTime();
const DAY = 24 * 60 * 60_000;

const row = (over: Partial<WorkListItem>): WorkListItem => ({
  _id: over._id || 'w',
  title: over.title ?? 'Something',
  rawText: 'raw',
  status: 'ready',
  workState: 'active',
  agentState: null,
  primaryAreaId: 'primaryAreaId' in over ? (over.primaryAreaId ?? null) : 'area_1',
  areaName: 'Money',
  openQuestions: over.openQuestions ?? 0,
  updatedAt: 1,
  createdAt: 1,
  ...over,
});

describe('Today keeps four regions and nothing else', () => {
  test('the source holds the plate, the capacity line, the next move, the mail, and the day', () => {
    const today = read('components/report/TodaySurface.tsx');
    const order = [
      '<BriefMasthead',
      'My day changed',
      'title="Do this next"',
      'title="Important mail"',
      'title="Your day"',
      '{brief}',
    ];
    const positions = order.map((marker) => today.indexOf(marker));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    for (const gone of [
      'ReEntry',
      'ReviewBatch',
      'MissedMovesRecoverySection',
      'Needs you',
      'Ongoing practices',
      'Waiting, not forgotten',
      'Get this off my mind',
      'Evening check-in',
      'DailyCheckin',
    ]) {
      expect(today).not.toContain(gone);
    }
  });

  test('the empty column reads one line, and the mail stops at four', () => {
    expect(TODAY_EMPTY_LINE).toBe('Nothing is scheduled. The day is yours.');
    expect(IMPORTANT_MAIL_MAX).toBe(4);
    expect(read('components/report/TodaySurface.tsx')).toContain('.slice(0, IMPORTANT_MAIL_MAX)');
  });

  test('the next move line says when', () => {
    expect(nextMoveWhen({ phase: 'active', scheduledStartAt: NOW })).toBe('Now');
    expect(nextMoveWhen({ phase: 'unscheduled', scheduledStartAt: null })).toBeNull();
    expect(nextMoveWhen({ phase: 'upcoming', scheduledStartAt: null })).toBeNull();
    expect(nextMoveWhen({ phase: 'upcoming', scheduledStartAt: NOW + 3_600_000 })).toMatch(/\d/);
  });

  test('Today passes its own clock to the dormant checks', () => {
    const today = read('components/report/TodaySurface.tsx');
    expect(today).toContain('needsYouToday(rows, approvals || [], nowMs)');
    expect(today).toContain('openWork(rows, nowMs)');
  });
});

describe('the Work page splits awake and dormant Work', () => {
  const rows = [
    row({ _id: 'awake' }),
    row({ _id: 'sleeping', horizon: { kind: 'later', notBefore: NOW + 10 * DAY } }),
    row({ _id: 'someday', horizon: { kind: 'someday' }, openQuestions: 1 }),
    row({ _id: 'woke', horizon: { kind: 'now', notBefore: NOW - DAY, wokeAt: NOW - DAY } }),
    row({ _id: 'elsewhere', primaryAreaId: 'area_2', horizon: { kind: 'someday' } }),
  ];

  test('dormant Work leaves the groups and the woken one stays', () => {
    expect(awakeWork(rows, NOW).map((item) => item._id)).toEqual(['awake', 'woke']);
  });

  test('the shelf follows the area filter and never the Needs you filter', () => {
    expect(shelfWork(rows, 'all', null, NOW).map((item) => item._id)).toEqual([
      'sleeping',
      'someday',
      'elsewhere',
    ]);
    expect(shelfWork(rows, 'all', 'area_1', NOW).map((item) => item._id)).toEqual(['sleeping', 'someday']);
    expect(shelfWork(rows, 'needs_you', null, NOW)).toEqual([]);
  });

  test('the page mounts the shelf under the groups and the review above them', () => {
    const list = read('components/albatross/AlbatrossesSurface.tsx');
    expect(list.indexOf('<ReviewBatch')).toBeLessThan(list.indexOf('visibleGroups.map'));
    expect(list.indexOf('visibleGroups.map')).toBeLessThan(list.indexOf('<LaterShelf'));
    expect(list).toContain('Kept, not carried.');
  });
});

describe('the Work detail owns the horizon control', () => {
  test('the optimistic value shows until the server row agrees', () => {
    const later = { kind: 'later' as const, notBefore: NOW + DAY, label: 'tomorrow' };
    expect(visibleHorizon(null, { value: later })).toEqual(later);
    expect(visibleHorizon({ ...later, wokeAt: undefined }, { value: later })).toEqual(later);
    expect(visibleHorizon(later, { value: null })).toBeNull();
    expect(visibleHorizon(later, null)).toEqual(later);
    expect(visibleHorizon(null, null)).toBeNull();
  });

  test('two horizons compare by kind, dates, and words, not by the wake stamp', () => {
    expect(sameHorizon(null, undefined)).toBe(true);
    expect(sameHorizon({ kind: 'someday' }, { kind: 'someday', wokeAt: 5 })).toBe(true);
    expect(sameHorizon({ kind: 'later', notBefore: 1 }, { kind: 'later', notBefore: 2 })).toBe(false);
    expect(sameHorizon({ kind: 'later', label: 'a' }, { kind: 'later', label: 'b' })).toBe(false);
    expect(sameHorizon({ kind: 'now' }, null)).toBe(false);
  });

  test('the control sits in the actions cluster and saves through setHorizon', () => {
    const detail = read('components/albatross/WorkDetail.tsx');
    expect(detail).toContain('<HorizonControl');
    expect(detail).toContain('api.albatrossWorkV2.setHorizon');
    expect(detail.indexOf('Put it down')).toBeLessThan(detail.indexOf('<HorizonControl'));
    expect(detail.indexOf('<HorizonControl')).toBeLessThan(detail.indexOf('<WorkDetailRecovery'));
  });

  test('the shell mounts the wake nudge once per layout, and the bell stays quiet', () => {
    const shell = read('components/shell/AppShell.tsx');
    expect(shell.split('<WakeNudgeHost />')).toHaveLength(3);
    const bell = read('components/shell/NotificationCenter.tsx');
    expect(bell).toContain("row.type !== 'work_wake'");
  });
});
