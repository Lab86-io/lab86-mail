import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// The taste rules in docs/albatross-voice-and-style.md are not advisory. Before
// this round the tree carried 54 upper-case micro-labels across 19 files, three
// different formats for machine confidence, and words like "classifier" in a
// primary empty state. These tests are the enforcement.

function walk(dir: string, extension = '.tsx'): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, extension));
    else if (full.endsWith(extension)) out.push(full);
  }
  return out;
}

const FILES = [...walk('components'), ...walk('app')];
const STYLESHEETS = [...walk('components', '.css'), ...walk('app', '.css')];
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

  test('nor do the stylesheets, where the same label would be text-transform plus tracking', () => {
    const offenders = STYLESHEETS.filter((path) => {
      const source = read(path);
      // Each rule block is checked on its own: an upper-case transform and a
      // positive letter-spacing together are the micro-label, whatever the
      // class name says.
      return source
        .split('}')
        .some(
          (block) => /text-transform:\s*uppercase/.test(block) && /letter-spacing:\s*0?\.\d+em/.test(block),
        );
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

  test('capture lives in the floating assistant, not a second rail button', () => {
    const rail = read('components/shell/Rail.tsx');
    expect(rail).not.toContain('captureLabel={');
    const actions = read('components/shell/ShellActions.tsx');
    expect(actions).toContain("import { CAPTURE_BUTTON_LABEL } from '@/components/albatross/IntentCapture'");
    expect(actions).toMatch(/ASSISTANT_LAUNCHER_PHRASES[^=]*=\s*\[\s*CAPTURE_BUTTON_LABEL/);
    expect(actions).toContain('aria-label={ASSISTANT_LAUNCHER_NAME}');
    const capture = read('components/albatross/IntentCapture.tsx');
    expect(capture).toContain("CAPTURE_BUTTON_LABEL = 'Get this off my mind'");
    // Compose moved into the Mail surface; the rail must not offer it.
    expect(rail).not.toContain('openComposeNew');
  });

  test('contextual capture opens the same assistant with the chip on Hold', () => {
    // Existing capture entry points raise captureOpen; the same assistant
    // answers with a Hold preset, without creating a second floating control.
    const capture = read('components/albatross/IntentCapture.tsx');
    expect(capture).not.toContain('capturePillHidden');
    expect(capture).not.toContain('IntentCaptureLauncher');
    const bar = read('components/shell/AIBar.tsx');
    expect(bar).toContain('useClientStore((s) => s.captureOpen)');
    expect(bar).toMatch(
      /setDoor\(\(current\) => \(\{ seed: captureSeed, nonce: \(current\?\.nonce \?\? 0\) \+ 1 \}\)\);\s*setAiBarOpen\(true\);\s*setCaptureOpen\(false\);/,
    );
    const composer = read('components/shell/AskHoldComposer.tsx');
    expect(composer).toContain("prediction.preset('hold')");
    // The bar is the one bottom-right control; no second capture pill.
    expect(bar).toContain('capturePillVisible: false');
  });

  test('the rail marks the Work row the Hold card moves toward', () => {
    const rail = read('components/shell/Rail.tsx');
    expect(rail).toContain('data-rail-target={view}');
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
  test('the surface leads with the next move, and carries no stack of Work', () => {
    const today = read('components/report/TodaySurface.tsx');
    expect(today.indexOf('Do this next')).toBeLessThan(today.indexOf('Your day'));
    expect(today).not.toContain('Needs you');
    expect(today).not.toContain('Waiting, not forgotten');
    expect(today).not.toContain('Ongoing practices');
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

describe('the questions use the main attached conversation', () => {
  test('the Albatross page routes waiting questions to chat', () => {
    const detail = read('components/albatross/WorkDetail.tsx');
    expect(detail).toContain('Answer in chat');
    expect(detail).toMatch(/setChatScope\(\{\s*kind: 'work',\s*workId,/);
    expect(detail).not.toContain('WorkQuestionCard');
    expect(detail).not.toContain('hasFrontierGate');
  });

  test('attached Work cannot be detached while its request is active', () => {
    const chat = read('components/shell/AIBar.tsx');
    expect(chat).toMatch(/title=\{`Detach \$\{chatScopeKind\}`\}[\s\S]*?disabled=\{busy\}/);
    expect(chat).toMatch(/aria-label=\{`Detach \$\{chatScopeKind\}`\}[\s\S]*?disabled:cursor-not-allowed/);
    expect(chat).toMatch(
      /title=\{[\s\S]*?'Return to global conversation'[\s\S]*?disabled=\{busy \|\| chatScopeKind === 'global'\}/,
    );
  });

  test('active requests cannot replace the conversation from history controls', () => {
    const chat = read('components/shell/AIBar.tsx');
    expect(chat).toMatch(/const loadSession = useCallback\([\s\S]*?if \(busy\) return false;/);
    expect(chat).toMatch(/const startNewChat = useCallback\(\(\) => \{\s*if \(busy\) return;/);
    expect(chat).toMatch(/onClick=\{startNewChat\}\s*disabled=\{busy\}\s*title="New chat"/);
    expect(chat).toMatch(/onSelect=\{\(\) => void loadSession\(session\._id\)\}\s*disabled=\{busy\}/);
  });

  test('a delayed history response cannot overwrite a changed conversation', () => {
    const chat = read('components/shell/AIBar.tsx');
    expect(chat).toMatch(/const generation = \+\+sessionLoadGenerationRef\.current;/);
    expect(chat).toMatch(/generation !== sessionLoadGenerationRef\.current/);
    expect(chat).toMatch(/loadScopeKey !== activeScopeKeyRef\.current/);
    expect(chat).toMatch(
      /if \(priorScopeRef\.current === scopeKey\) return;[\s\S]*?sessionLoadGenerationRef\.current \+= 1;/,
    );
    expect(chat).toMatch(
      /const startNewChat = useCallback\([\s\S]*?sessionLoadGenerationRef\.current \+= 1;/,
    );
    expect(chat).toMatch(/const send = async[\s\S]*?sessionLoadGenerationRef\.current \+= 1;/);
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
