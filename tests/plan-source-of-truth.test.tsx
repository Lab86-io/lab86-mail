import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { renderToStaticMarkup } from 'react-dom/server';
import PricingPage from '../app/pricing/page';
import PrivacyPage from '../app/privacy/page';
import SupportPage from '../app/support/page';
import TermsPage from '../app/terms/page';
import {
  B2C_ANNUAL_PRICE_USD,
  B2C_BYOK_ANNUAL_PRICE_USD,
  B2C_BYOK_MONTHLY_PRICE_USD,
  B2C_MONTHLY_PRICE_USD,
} from '../lib/ai/budget';
import {
  DAY_MS,
  formatUsd,
  PAID_PLANS,
  PRODUCT_NAME,
  planPriceLine,
  planPriceShort,
  planTableRows,
  pricingFaq,
  TRIAL_DAYS,
  trialNoteText,
  trialState,
} from '../lib/hosted/plans';

const ROOT = path.join(import.meta.dir, '..');

function files(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) files(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

describe('one price and one name', () => {
  test('the plans match what Clerk Billing charges in production', () => {
    expect(PAID_PLANS.pro).toMatchObject({ name: 'Pro', monthlyUsd: 29, annualUsd: 288 });
    expect(PAID_PLANS.byok).toMatchObject({ name: 'Own key', monthlyUsd: 12, annualUsd: 120 });
    expect(planPriceLine('pro')).toBe('$29/month or $288/year');
    expect(planPriceShort('pro')).toBe('$29/mo or $288/yr');
    expect(planPriceLine('byok')).toBe('$12/month or $120/year');
    expect(planPriceShort('byok')).toBe('$12/mo or $120/yr');
    expect(formatUsd(7)).toBe('$7');
    expect(formatUsd(4.2)).toBe('$4.20');
    // The budget module re-exports the same numbers for server callers.
    expect([B2C_MONTHLY_PRICE_USD, B2C_ANNUAL_PRICE_USD]).toEqual([29, 288]);
    expect([B2C_BYOK_MONTHLY_PRICE_USD, B2C_BYOK_ANNUAL_PRICE_USD]).toEqual([12, 120]);
  });

  test('Terms, Support, and Pricing state the same prices and the product name', () => {
    for (const Page of [TermsPage, SupportPage, PricingPage]) {
      const html = renderToStaticMarkup(<Page />);
      expect(html).toContain(PRODUCT_NAME);
      expect(html).toContain('$29/month or $288/year');
      expect(html).not.toContain('$15/month');
      expect(html).toContain('$12/month or $120/year');
      expect(html).not.toContain('$50.40');
      expect(html).not.toContain('Lab86 Mail');
      expect(html).not.toMatch(/\bAI\b/);
    }
    const terms = renderToStaticMarkup(<TermsPage />);
    expect(terms).toContain(`${TRIAL_DAYS} days of Pro with no card`);
    // Pro has no usage limit. The Terms keep the right to limit abuse.
    expect(terms).toContain('Pro includes hosted model use with no usage limit.');
    expect(terms).not.toMatch(/budget|pause chat|lower-cost/);
    expect(terms).toContain('The service may be suspended or limited to protect users');
  });

  test('the privacy policy names the product the same way', () => {
    // Google checks that the policy names the app on the consent screen, so the name must match.
    const html = renderToStaticMarkup(<PrivacyPage />);
    expect(html).toContain(
      `${PRODUCT_NAME} connects to your mail provider only with the access you authorize`,
    );
    expect(html).toContain(
      `${PRODUCT_NAME}&#x27;s use and transfer of information received from Google APIs`,
    );
    expect(html).not.toMatch(/Lab86 (?:Mail|AI)/);
    expect(html).toContain('mailto:support@lab86.io');
  });

  test('the privacy policy covers what Google checks before it shows the branding', () => {
    const html = renderToStaticMarkup(<PrivacyPage />);
    for (const heading of [
      'Data we collect',
      'How we use data',
      'Google user data',
      'How we share data',
      'Security',
      'Retention and deletion',
      'Your choices',
      'Contact',
    ])
      expect(html).toContain(`>${heading}</h2>`);
    expect(html).toContain('Limited Use requirements');
    expect(html).toContain('https://myaccount.google.com/permissions');
  });

  test('no surface hard-codes a plan price or the old product name', () => {
    const offenders: string[] = [];
    const skip = ['lib/hosted/plans.ts', 'lib/documents/', 'components/albatross/GuidedStep'];
    for (const dir of ['app', 'components', 'lib']) {
      for (const file of files(path.join(ROOT, dir))) {
        const rel = path.relative(ROOT, file).split(path.sep).join('/');
        if (skip.some((prefix) => rel.startsWith(prefix))) continue;
        const source = readFileSync(file, 'utf8');
        if (/\$(?:5|12|15|29|50|120|150|288|290)(?:\.\d\d)?\s*\/\s*(?:mo|month|yr|year)\b/.test(source))
          offenders.push(`${rel}: price`);
        if (/['"`>][^'"`<\n]*\b(?:Lab86 Mail|Lab86 AI)\b/.test(source)) offenders.push(`${rel}: name`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the pricing page', () => {
  test('it leads with the outcome, then the plans, the budget, the data promise, and questions', () => {
    const html = renderToStaticMarkup(<PricingPage />);
    const order = [
      'Start each morning knowing what needs you.',
      'Try Pro free for 14 days. No card.',
      '>Plans<',
      'What Pro pays for',
      'Your data stays yours',
      'does not train models on your mail',
      '>Questions<',
      'Choose a plan',
    ].map((text) => html.indexOf(text));
    for (const index of order) expect(index).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const row of planTableRows()) expect(html).toContain(row.feature);
    for (const entry of pricingFaq()) expect(html).toContain(entry.question.replace(/'/g, '&#x27;'));
    // Pro has no usage limit, and the page says so in plain words.
    expect(html).toContain('Pro has no usage limit.');
    expect(html).toContain('Chat has no usage limit.');
    expect(html).not.toMatch(/monthly (?:model )?budget|used up|credits a month|of model use/);
    expect(html).not.toMatch(/\bAI\b/);
  });

  test('the table and the questions read the plan constants', () => {
    const rows = planTableRows();
    expect(rows[0]).toEqual({
      feature: 'Price',
      free: '$0',
      pro: '$29/month or $288/year',
      byok: '$12/month or $120/year',
    });
    expect(new Set(rows.map((row) => row.feature)).size).toBe(rows.length);
    const faq = pricingFaq();
    expect(faq.find((entry) => entry.question === 'What is Own key?')?.answer).toContain('$12/month');
    expect(faq[0].answer).toContain('14 days of Pro with no card');
    expect(rows.find((row) => row.feature === 'Chat and Albatrosses')?.pro).toBe(
      'Included, with no usage limit',
    );
    const limit = faq.find((entry) => entry.question === 'Does Pro have a usage limit?');
    expect(limit?.answer).toStartWith('No.');
    expect(limit?.answer).toContain('lower-cost model');
    expect(PAID_PLANS.pro.summary).not.toMatch(/budget/);
    for (const entry of faq) expect(`${entry.question} ${entry.answer}`).not.toMatch(/\bAI\b/);
  });
});

describe('the plans on a phone', () => {
  const page = () => new JSDOM(renderToStaticMarkup(<PricingPage />)).window.document;

  test('below sm, each plan is one card with every row of the table', () => {
    const doc = page();
    const cards = [...doc.querySelectorAll('[data-plan-card]')];
    expect(cards.map((card) => card.getAttribute('data-plan-card'))).toEqual(['free', 'pro', 'byok']);
    expect(cards.map((card) => card.querySelector('h3')?.textContent)).toEqual(['Free', 'Pro', 'Own key']);
    // The cards show only on a phone.
    expect(cards[0].parentElement?.className.split(' ')).toContain('sm:hidden');
    const rows = planTableRows();
    for (const card of cards) {
      const plan = card.getAttribute('data-plan-card') as 'free' | 'pro' | 'byok';
      const terms = [...card.querySelectorAll('dt')].map((node) => node.textContent);
      const values = [...card.querySelectorAll('dd')].map((node) => node.textContent);
      expect(terms).toEqual(rows.map((row) => row.feature));
      expect(values).toEqual(rows.map((row) => row[plan]));
    }
  });

  test('the table shows from sm up and has no fixed width that scrolls sideways', () => {
    const doc = page();
    const table = doc.querySelector('table');
    expect(table).not.toBeNull();
    const wrapper = table?.parentElement;
    expect(wrapper?.className.split(' ')).toEqual(expect.arrayContaining(['hidden', 'sm:block']));
    expect(table?.className).not.toMatch(/min-w-/);
    expect([...doc.querySelectorAll('thead th')].map((cell) => cell.textContent)).toEqual([
      'Feature',
      'Free',
      'Pro',
      'Own key',
    ]);
  });
});

describe('trial state', () => {
  const NOW = 1_800_000_000_000;

  test('an active trial counts whole days left and notes the last five', () => {
    expect(trialState(null, NOW)).toEqual({ active: false, endsAt: null, daysLeft: 0, showNote: false });
    expect(trialState(NOW + 14 * DAY_MS, NOW)).toMatchObject({ active: true, daysLeft: 14, showNote: false });
    expect(trialState(NOW + 5 * DAY_MS, NOW)).toMatchObject({ active: true, daysLeft: 5, showNote: true });
    expect(trialState(NOW + 1, NOW)).toMatchObject({ active: true, daysLeft: 1, showNote: true });
    expect(trialState(NOW, NOW)).toMatchObject({ active: false, daysLeft: 0, showNote: false });
    expect(trialState(Number.NaN, NOW).endsAt).toBeNull();
  });

  test('the note is plain and names what happens next', () => {
    expect(trialNoteText(1)).toBe('1 day left in your Pro trial. After that, your account moves to Free.');
    expect(trialNoteText(3)).toContain('3 days left');
    expect(trialNoteText(3)).not.toMatch(/\bAI\b/);
  });
});
