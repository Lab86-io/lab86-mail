import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// The taste rules in docs/albatross-voice-and-style.md are not advisory. Before
// this round the tree carried 54 upper-case micro-labels across 19 files, three
// different formats for machine confidence, and words like "classifier" in a
// primary empty state. These tests are the enforcement.

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

const FILES = [...walk('components'), ...walk('app')];
const read = (path: string) => readFileSync(path, 'utf8');

describe('no upper-case micro-labels', () => {
  test('the components tree carries none', () => {
    const offenders = FILES.filter((path) => {
      const source = read(path);
      // Avatar initials are legitimately upper case; the micro-label system is
      // `uppercase` paired with letterspacing on a small label.
      return /uppercase tracking-/.test(source);
    });
    expect(offenders).toEqual([]);
  });
});

describe('no machine confidence on screen', () => {
  test('no surface renders a confidence score or a confidence word', () => {
    const offenders = FILES.filter((path) => {
      const source = read(path);
      return (
        /confidence \|\| 0\) \* 100/.test(source) ||
        /\{profile\.confidence\} confidence/.test(source) ||
        /'(High|Medium|Low) confidence'/.test(source)
      );
    });
    expect(offenders).toEqual([]);
  });
});

describe('no internal machinery in user copy', () => {
  const BANNED: Array<[RegExp, string]> = [
    [/the classifier starts/i, 'classifier'],
    [/\{[^}]*factCounts\.verified\}\s*verified/i, 'a count of internal fact rows'],
    [/\}\s*artifacts</i, 'artifacts'],
  ];

  test('the words that name the mechanism do not reach the screen', () => {
    const offenders: string[] = [];
    for (const path of FILES) {
      const source = read(path);
      for (const [pattern, word] of BANNED) {
        if (pattern.test(source)) offenders.push(`${path}: ${word}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the product names itself', () => {
  test('the rail says Albatross, by Lab86 — not Lab86 Mail', () => {
    const rail = read('components/shell/Rail.tsx');
    expect(rail).toContain('Albatross');
    expect(rail).toContain('by Lab86');
    expect(rail).not.toContain('Lab86</span> Mail');
  });

  test('the primary action is capture, not compose', () => {
    const rail = read('components/shell/Rail.tsx');
    // The label lives in CAPTURE_BUTTON_LABEL (IntentCapture); the rail must
    // use the constant in both JSX slots, not restate the words.
    expect(rail).toContain("import { CAPTURE_BUTTON_LABEL } from '@/components/albatross/IntentCapture'");
    expect(rail).toContain('tooltip={CAPTURE_BUTTON_LABEL}');
    expect(rail).toContain('<span>{CAPTURE_BUTTON_LABEL}</span>');
    const capture = read('components/albatross/IntentCapture.tsx');
    expect(capture).toContain("CAPTURE_BUTTON_LABEL = 'Get this off my mind'");
    // Compose moved into the Mail surface; the rail must not offer it.
    expect(rail).not.toContain('openComposeNew');
  });

  test('one capture door per screen: the pill yields to the expanded rail', () => {
    const capture = read('components/albatross/IntentCapture.tsx');
    // Expanded desktop rail shows its own capture button, so the pill hides;
    // a collapsed rail or the mobile off-canvas drawer brings the pill back.
    expect(capture).toContain('useSidebar');
    expect(capture).toContain('capturePillHidden(aiBarOpen, railOpen, isMobile)');
  });

  test('the rail offers Today and Albatrosses as real destinations', () => {
    const rail = read('components/shell/Rail.tsx');
    expect(rail).toContain("view: 'today', label: 'Today'");
    expect(rail).toContain("view: 'albatrosses', label: 'Albatrosses'");
  });

  test('the rail badge is words, never a number', () => {
    const rail = read('components/shell/Rail.tsx');
    expect(rail).toContain('railWorkBadge');
    expect(rail).not.toMatch(/SidebarMenuBadge[\s\S]*\{\s*pending\s*\}/);
  });
});

describe('Mail tells the truth when nothing is connected', () => {
  test('a disconnected mailbox shows a state, not endless skeleton rows', () => {
    const inbox = read('components/inbox/Inbox.tsx');
    expect(inbox).toContain('NoMailboxState');
    // The no-mailbox branch must come before the loading branch, or the
    // skeletons win and the surface looks like it is still loading forever.
    expect(inbox.indexOf('<NoMailboxState />')).toBeLessThan(inbox.indexOf('<SkeletonRows />'));
  });
});

describe('Today puts responsibility above decoration', () => {
  test('the surface leads with what needs the user, not with the weather', () => {
    const today = read('components/report/TodaySurface.tsx');
    expect(today.indexOf('Needs you')).toBeLessThan(today.indexOf('Your day'));
    expect(today).not.toContain('weather');
  });

  test('the brief is a section of Today, not the whole of it', () => {
    const shell = read('components/shell/AppShell.tsx');
    expect(shell).toContain('<Today />');
    expect(shell).not.toContain('<DailyReport />');
  });

  test('no surface claims a generated brief is Live', () => {
    const report = read('components/report/DailyReport.tsx');
    expect(report).not.toContain('Live · updates without regenerating');
  });
});

describe('no surface tallies open work', () => {
  test('the Albatrosses groups do not count what you are carrying', () => {
    // A number beside "Needs you" is a tally of weights, which is the exact
    // thing the rail badge was changed to avoid.
    const list = read('components/albatross/AlbatrossesSurface.tsx');
    expect(list).not.toContain('{group.items.length}');
  });
});

describe('the questions are answerable where they are shown', () => {
  test('the Albatross page renders every waiting question', () => {
    const detail = read('components/albatross/WorkDetail.tsx');
    expect(detail).toContain('pendingQuestions.map');
    expect(detail).not.toContain('const pendingQuestion =');
  });

  test('the truncated floating copy of the question is gone', () => {
    const companion = read('components/albatross/AlbatrossCompanion.tsx');
    expect(companion).not.toContain('fixed bottom-20 right-6');
  });
});

describe('no star or sparkle marks', () => {
  test('the tree carries none, as glyphs or as icons', () => {
    // The rule is absolute. A ✦ dinkus sat in the brief for months and only
    // became visible once the brief moved onto Today.
    const offenders: string[] = [];
    for (const file of FILES) {
      const source = read(file);
      if (/[✦✧✨⭐★☆]/.test(source)) offenders.push(`${file}: star glyph`);
      if (/\bSparkles?\b|\bWandSparkles\b/.test(source)) offenders.push(`${file}: sparkle icon`);
    }
    expect(offenders).toEqual([]);
  });
});
