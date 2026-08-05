import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { CADENCE_LABEL, importantMailToday, practiceLine, type TodayPractice } from '../lib/albatross/today';

const read = (path: string) => readFileSync(path, 'utf8');

describe('first run asks for the burden before the infrastructure', () => {
  const welcome = read('components/hosted/FirstBurden.tsx');
  const page = read('app/welcome/page.tsx');

  test('/welcome renders the burden-first flow', () => {
    expect(page).toContain('FirstBurden');
    expect(page).not.toContain('WelcomeFlow');
  });

  test('the first question is about the person, not their accounts', () => {
    expect(welcome).toContain('What is one thing you keep meaning to handle?');
    expect(welcome).toContain('You do not need to organize it first');
  });

  test('it captures before it asks for anything', () => {
    // The capture POST must come before the connect offer in the flow: the
    // whole point is that the request afterwards can say what it is for.
    expect(welcome.indexOf("'/api/albatross/capture'")).toBeLessThan(welcome.indexOf('/api/nylas/connect'));
  });

  test('the connection request explains what it is for', () => {
    expect(welcome).toContain('Most of what you are carrying arrives by email');
    expect(welcome).toContain('it can tell when the thing is actually done');
  });

  test('no model, provider or token price appears in first run', () => {
    // Comments explain what the flow used to be; only what renders counts.
    const lowered = welcome
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .toLowerCase();
    for (const banned of ['openrouter', 'anthropic', 'gpt-', 'api key', 'per-token', '/m in', 'model']) {
      expect(lowered).not.toContain(banned);
    }
  });

  test('a mailbox is still optional', () => {
    expect(welcome).toContain('Skip for now');
    expect(welcome).toContain('Albatross keeps working either way');
  });
});

describe('practices are never scored', () => {
  const practice = (over: Partial<TodayPractice>): TodayPractice => ({
    _id: 'r',
    title: 'Gym',
    cadence: over.cadence ?? 'weekly',
    nextRunAt: 'nextRunAt' in over ? (over.nextRunAt ?? null) : null,
    areaName: over.areaName ?? null,
  });
  const now = new Date(2026, 7, 2, 12, 0).getTime();

  test('every cadence reads as a rhythm, not a quota', () => {
    for (const cadence of Object.keys(CADENCE_LABEL)) {
      const line = practiceLine(practice({ cadence }), now).toLowerCase();
      expect(line).not.toContain('streak');
      expect(line).not.toContain('%');
      expect(line).not.toMatch(/\d+\s*\/\s*\d+/);
      expect(line).not.toContain('missed');
    }
  });

  test('a practice that is due says there is room, not that you are late', () => {
    const line = practiceLine(practice({ nextRunAt: now - 3_600_000 }), now);
    expect(line).toContain('there is room for it today');
    expect(line.toLowerCase()).not.toContain('overdue');
  });

  test('an unknown cadence still reads as something a person would say', () => {
    expect(practiceLine(practice({ cadence: 'fortnightly' }), now)).toContain('On your own rhythm');
  });
});

describe('important mail on Today', () => {
  const items = Array.from({ length: 9 }, (_, index) => ({
    id: `m${index}`,
    subject: `Subject ${index}`,
    from: 'someone@example.com',
  }));

  test('stays short — it is not an inbox digest', () => {
    expect(importantMailToday(items)).toHaveLength(4);
  });

  test('shows everything when there is little', () => {
    expect(importantMailToday(items.slice(0, 2))).toHaveLength(2);
  });
});

describe('the bird appears only where it belongs', () => {
  test('it is in first run, empty states and Activity — never on a row', () => {
    expect(read('components/hosted/FirstBurden.tsx')).toContain('AlbatrossMark');
    expect(read('components/albatross/AlbatrossesSurface.tsx')).toContain('AlbatrossMark');
    expect(read('components/albatross/ActivitySurface.tsx')).toContain('AlbatrossMark');
    // Rows, cards and buttons stay plain.
    expect(read('components/albatross/primitives.tsx')).not.toContain('AlbatrossMark');
  });
});

describe('a plan reads as a guess', () => {
  test('the detail page says the plan can be wrong', () => {
    const detail = read('components/albatross/WorkDetail.tsx');
    expect(detail).toContain('best guess at the way through');
    expect(detail).toContain('will find another one');
  });
});

describe('capture has more than one door', () => {
  test('a keyboard shortcut, a thread, and a selection all reach it', () => {
    const shortcuts = read('components/shell/ShortcutsBinding.tsx');
    expect(shortcuts).toContain("case 'n'");
    expect(shortcuts).toContain('window.getSelection()');
    expect(read('components/thread/ThreadView.tsx')).toContain('openCaptureWith');
    expect(read('components/shell/ShortcutsSheet.tsx')).toContain('Get this off my mind');
  });
});
