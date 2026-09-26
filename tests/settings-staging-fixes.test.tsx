import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { JSDOM } from 'jsdom';
import { renderToStaticMarkup } from 'react-dom/server';
import { StandingOrdersSection } from '../components/settings/StandingOrdersSection';
import type { StandingOrder } from '../lib/hosted/standing-orders';

const ROOT = path.join(import.meta.dir, '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

function files(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) files(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

const order = (over: Partial<StandingOrder>): StandingOrder => ({
  id: 'brief',
  group: 'schedule',
  title: 'Daily Brief',
  detail: 'Writes your Brief each morning in your time zone.',
  mode: 'runs_alone',
  paused: false,
  locked: false,
  items: [],
  ...over,
});

describe('Standing orders', () => {
  test('each group title is a sibling of the card above it, so its top margin holds', () => {
    const query = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    query.setQueryData(
      ['standing-orders'],
      [
        order({}),
        order({ id: 'sorting', group: 'mail', title: 'Sorting' }),
        order({ id: 'risk:read', group: 'assistant', title: 'Look things up', locked: true }),
      ],
    );
    const doc = new JSDOM(
      renderToStaticMarkup(
        <QueryClientProvider client={query}>
          <StandingOrdersSection />
        </QueryClientProvider>,
      ),
    ).window.document;
    const titles = [...doc.querySelectorAll('h3')];
    expect(titles.map((title) => title.textContent)).toEqual([
      'On a schedule',
      'In your mail',
      'What the assistant may do in chat',
    ]);
    for (const title of titles) {
      // first:mt-0 must never apply: no title is the first child of its parent.
      expect(title.parentElement?.tagName).toBe('SECTION');
      expect(title.previousElementSibling).not.toBeNull();
      expect(title.className).toContain('mt-6');
    }
  });
});

describe('Settings on a phone', () => {
  const page = read('app/settings/page.tsx');

  test('the tab bar brings the active tab into view on load and on each change', () => {
    expect(page).toContain('ref={navRef}');
    expect(page).toContain('data-settings-tab={item.id}');
    expect(page).toMatch(
      /settingsTabScrollLeft\(\{[\s\S]*?\}\);[\s\S]*?nav\.scrollTo\([\s\S]*?\}, \[tab\]\);/,
    );
  });

  test('the check-in time field is wide enough for "07:00 PM"', () => {
    const field = page.slice(page.indexOf('id="checkin-time"\n'), page.indexOf('type="time"'));
    expect(field).toContain('className="w-36"');
    expect(page).not.toMatch(/className="w-32"\s+type="time"/);
  });
});

describe('Example names in the product', () => {
  test('placeholders use a neutral example name, not a real person', () => {
    const offenders: string[] = [];
    for (const dir of ['components', 'app']) {
      for (const file of files(path.join(ROOT, dir))) {
        const text = readFileSync(file, 'utf8');
        if (/\bJakob\b|\bLangtry\b/.test(text)) offenders.push(path.relative(ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
    expect(read('components/settings/VoiceProfileSettings.tsx')).toContain("placeholder={'Best,\\nAnn'}");
  });
});
