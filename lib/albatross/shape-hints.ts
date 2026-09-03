// Deterministic shape hints.
//
// The capture split asks the model for a shape, a list of items, and a
// metric. These parsers are the fallback when the model gives none, and the
// oracle the tests hold the model to. They are narrow on purpose: a hit must
// be plain ("Movie list: Heat, Alien", "Lose fifteen pounds by spring"). Text
// that does not match stays plain Work.

import { parseHorizonHint, type WorkHorizon } from '@/lib/albatross/horizon';
import type { MetricLike } from '@/lib/albatross/practice-review';

export interface ListHint {
  title: string;
  items: string[];
}

export interface MetricHint {
  metric: MetricLike;
  /** A relative amount ("lose fifteen pounds"). Not a target; the target is absolute. */
  delta?: number;
  horizon?: WorkHorizon;
}

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  hundred: 100,
};

/** "fifteen", "twenty five", "twenty-five", "1,500", "2.5" → a number, or null. */
export function parseCount(token: string): number | null {
  const clean = String(token || '')
    .trim()
    .toLowerCase()
    .replace(/,/g, '');
  if (!clean) return null;
  if (/^\d+(\.\d+)?$/.test(clean)) return Number(clean);
  const words = clean.split(/[\s-]+/);
  let total = 0;
  for (const word of words) {
    const value = NUMBER_WORDS[word];
    if (value === undefined) return null;
    if (value === 100 && total > 0) total *= 100;
    else total += value;
  }
  return total > 0 ? total : null;
}

const NUMBER_PATTERN = '(\\d[\\d,]*(?:\\.\\d+)?|(?:[a-z]+(?:[\\s-][a-z]+)?))';

// The head of a list phrase: "Movie list", "list of books", "gift ideas",
// "books to read", "things to try".
const LIST_HEAD =
  /^(?<title>(?:[\w'’ ]{1,60}?\blist(?:\s+of\s+[\w' ]{1,30})?|[\w' ]{1,40}?\b(?:ideas|to read|to watch|to try|to buy|to see|to visit))\s*)[:\-–—]\s*(?<tail>.+)$/i;

function splitItems(tail: string): string[] {
  return tail
    .split(/\s*(?:,|;|\n|\band\b)\s*/i)
    .map((item) => item.replace(/[.!?]+$/, '').trim())
    .filter(Boolean);
}

function sentenceCase(value: string) {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean ? clean[0].toUpperCase() + clean.slice(1) : clean;
}

/**
 * Read a list from plain text. Two forms hit:
 * - one line: "Movie list: Heat, Alien, Dune part two"
 * - a head line, then one item per line.
 * Anything else is null.
 */
export function parseListHint(text: string): ListHint | null {
  const clean = String(text || '').trim();
  if (!clean) return null;
  const lines = clean
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean);
  if (!lines.length) return null;

  const inline = lines[0].match(LIST_HEAD);
  if (inline?.groups) {
    const items = [...splitItems(inline.groups.tail), ...lines.slice(1)];
    if (items.length >= 2) return { title: sentenceCase(inline.groups.title), items };
  }
  const headOnly = lines[0].replace(/[:\-–—]\s*$/, '').trim();
  if (
    lines.length >= 3 &&
    /\b(list|ideas|to read|to watch|to try|to buy|to see|to visit)\b/i.test(headOnly)
  ) {
    return { title: sentenceCase(headOnly), items: lines.slice(1) };
  }
  return null;
}

const WEIGHT_UNIT = '(pounds?|lbs?|kilos?|kilograms?|kgs?)';
const DISTANCE_UNIT = '(kilomet(?:er|re)s?|km|k|miles?|mi)';

function weightUnit(token: string): 'lb' | 'kg' {
  return /^(k|kilo)/i.test(token) ? 'kg' : 'lb';
}

function distanceUnit(token: string): 'km' | 'mi' {
  return /^(k|kilo)/i.test(token) ? 'km' : 'mi';
}

const SEASONS: Record<string, [number, number]> = {
  spring: [2, 20],
  summer: [5, 21],
  fall: [8, 22],
  autumn: [8, 22],
  winter: [11, 21],
};

/** "by spring" → the next start of that season, at local midnight. */
export function parseSeasonHorizon(text: string, nowMs: number): WorkHorizon | null {
  const match = String(text || '')
    .toLowerCase()
    .match(/\b(?:by|before|for)\s+(?:the\s+|this\s+|next\s+)?(spring|summer|fall|autumn|winter)\b/);
  if (!match) return null;
  const [month, day] = SEASONS[match[1]];
  const now = new Date(nowMs);
  let target = new Date(now.getFullYear(), month, day);
  if (target.getTime() <= nowMs) target = new Date(now.getFullYear() + 1, month, day);
  return { kind: 'now', by: target.getTime(), label: `by ${match[1]}` };
}

/**
 * Read a metric goal from plain text. Hits:
 * - "Lose fifteen pounds by spring" → weight, lb, down, delta 15, by spring.
 * - "Get down to 170 lb" → weight, lb, down, target 170.
 * - "Run a 10k" / "Run 5 miles" → distance, km or mi, up, target.
 * - "Walk 10,000 steps a day" → steps, up, target.
 * - "Read twelve books this year" → books, up, target.
 * - "Save $5,000" → savings, usd, up, target.
 * Anything else is null.
 */
export function parseMetricHint(text: string, nowMs: number): MetricHint | null {
  const clean = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return null;
  const lower = clean.toLowerCase();
  const horizon = parseSeasonHorizon(lower, nowMs) ?? parseHorizonHint(lower, nowMs) ?? undefined;
  const withHorizon = (metric: MetricLike, delta?: number): MetricHint => ({
    metric,
    ...(delta !== undefined ? { delta } : {}),
    ...(horizon ? { horizon } : {}),
  });

  const weightTo = lower.match(
    new RegExp(
      `\\b(?:get|be|weigh|come)\\s+(?:back\\s+)?(?:down|up)?\\s*to\\s+${NUMBER_PATTERN}\\s*${WEIGHT_UNIT}\\b`,
    ),
  );
  if (weightTo) {
    const target = parseCount(weightTo[1]);
    if (target !== null) {
      const direction = /\bup\s+to\b/.test(weightTo[0]) ? 'up' : 'down';
      return withHorizon({ name: 'weight', unit: weightUnit(weightTo[2]), target, direction });
    }
  }
  const weightDelta = lower.match(
    new RegExp(`\\b(lose|drop|shed|gain|put on|add)\\s+${NUMBER_PATTERN}\\s*${WEIGHT_UNIT}\\b`),
  );
  if (weightDelta) {
    const delta = parseCount(weightDelta[2]);
    if (delta !== null) {
      const direction = ['gain', 'put on', 'add'].includes(weightDelta[1]) ? 'up' : 'down';
      return withHorizon({ name: 'weight', unit: weightUnit(weightDelta[3]), direction }, delta);
    }
  }
  const distance = lower.match(
    new RegExp(
      `\\b(?:run|walk|ride|bike|cycle|swim|jog)\\s+(?:a\\s+|an\\s+)?${NUMBER_PATTERN}\\s*${DISTANCE_UNIT}\\b`,
    ),
  );
  if (distance) {
    const target = parseCount(distance[1]);
    if (target !== null) {
      return withHorizon({ name: 'distance', unit: distanceUnit(distance[2]), target, direction: 'up' });
    }
  }
  const steps = lower.match(new RegExp(`\\b${NUMBER_PATTERN}\\s*steps\\b`));
  if (steps) {
    const target = parseCount(steps[1]);
    if (target !== null) return withHorizon({ name: 'steps', unit: 'steps', target, direction: 'up' });
  }
  const books = lower.match(new RegExp(`\\bread\\s+${NUMBER_PATTERN}\\s+books?\\b`));
  if (books) {
    const target = parseCount(books[1]);
    if (target !== null) return withHorizon({ name: 'books', unit: 'books', target, direction: 'up' });
  }
  const savings = lower.match(/\b(?:save|put away|set aside)\s+\$?(\d[\d,]*(?:\.\d+)?)\s*(k|thousand)?\b/);
  if (savings) {
    const base = parseCount(savings[1]);
    if (base !== null) {
      const target = savings[2] ? base * 1000 : base;
      return withHorizon({ name: 'savings', unit: 'usd', target, direction: 'up' });
    }
  }
  return null;
}
