import { describe, expect, mock, test } from 'bun:test';
import {
  parseTomorrowSplit,
  splitTomorrowWork,
  tomorrowExternalId,
  tomorrowExternalPrefix,
} from '../lib/albatross/tomorrow-split';

const NO_IDS = new Set<string>();

describe('parseTomorrowSplit', () => {
  test('keeps every independent outcome from the reply', () => {
    const raw = JSON.stringify({
      work: [
        { title: 'Book a massage for Tree', rawText: 'Book a massage for Tree.', existingWorkId: null },
        { title: 'Order new sheets for Tree', rawText: 'Get her new sheets.', existingWorkId: null },
        { title: 'Reserve dinner for Tree', rawText: 'Reserve her something for dinner.' },
      ],
    });
    const result = parseTomorrowSplit(raw, 'the whole dump', NO_IDS);
    expect(result.fallback).toBe(false);
    expect(result.items.map((item) => item.title)).toEqual([
      'Book a massage for Tree',
      'Order new sheets for Tree',
      'Reserve dinner for Tree',
    ]);
  });

  test('a parse failure never loses the raw answer', () => {
    const result = parseTomorrowSplit('not json at all', 'Call the DMV and renew the plates.', NO_IDS);
    expect(result.fallback).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].rawText).toBe('Call the DMV and renew the plates.');
  });

  test('drops an existingWorkId outside the valid set', () => {
    const raw = JSON.stringify({
      work: [{ title: 'Order sheets', rawText: 'Order sheets.', existingWorkId: 'work-hallucinated' }],
    });
    const result = parseTomorrowSplit(raw, 'Order sheets.', new Set(['work-real']));
    expect(result.items[0].existingWorkId).toBeNull();
  });

  test('keeps an existingWorkId inside the valid set', () => {
    const raw = JSON.stringify({
      work: [{ title: 'Order sheets', rawText: 'Order sheets.', existingWorkId: 'work-real' }],
    });
    const result = parseTomorrowSplit(raw, 'Order sheets.', new Set(['work-real']));
    expect(result.items[0].existingWorkId).toBe('work-real');
  });

  test('strips a code fence before the parse', () => {
    const raw = '```json\n{"work":[{"title":"One","rawText":"One."}]}\n```';
    const result = parseTomorrowSplit(raw, 'One.', NO_IDS);
    expect(result.fallback).toBe(false);
    expect(result.items[0].title).toBe('One');
  });
});

describe('splitTomorrowWork', () => {
  test('a generation failure falls back to one Work with the raw text', async () => {
    const result = await splitTomorrowWork(
      { userId: 'user-1', tomorrowIntentText: 'Do the thing.', existing: [] },
      { generate: mock(async () => Promise.reject(new Error('offline'))) as any },
    );
    expect(result.fallback).toBe(true);
    expect(result.items[0].rawText).toBe('Do the thing.');
  });

  test('passes the existing siblings to the model for reconciliation', async () => {
    const generate = mock(async (options: any) => {
      expect(options.prompt).toContain('work-existing');
      expect(options.prompt).toContain('Order new sheets for Tree');
      return { text: JSON.stringify({ work: [{ title: 'New thing', rawText: 'New thing.' }] }) };
    });
    const result = await splitTomorrowWork(
      {
        userId: 'user-1',
        tomorrowIntentText: 'New thing.',
        existing: [{ workId: 'work-existing', title: 'Order new sheets for Tree', started: true }],
      },
      { generate: generate as any },
    );
    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.items[0].title).toBe('New thing');
  });
});

describe('tomorrow external ids', () => {
  test('the prefix matches the legacy single-work id', () => {
    expect(tomorrowExternalPrefix('c-1')).toBe('checkin:c-1:tomorrow');
  });

  test('ids key on content and stay unique', () => {
    const taken = new Set<string>();
    const first = tomorrowExternalId('c-1', 'Order new sheets for Tree', taken);
    expect(first).toBe('checkin:c-1:tomorrow:order-new-sheets-for-tree');
    taken.add(first);
    const second = tomorrowExternalId('c-1', 'Order new sheets for Tree', taken);
    expect(second).toBe('checkin:c-1:tomorrow:order-new-sheets-for-tree-2');
    expect(second).not.toBe(first);
  });

  test('a title with no usable characters still forms an id', () => {
    expect(tomorrowExternalId('c-1', '!!!', new Set())).toBe('checkin:c-1:tomorrow:work');
  });
});

describe('external id exhaustion and empty splits', () => {
  test('an exhausted suffix range still returns a unique id', () => {
    const taken = new Set<string>(['checkin:c-1:tomorrow:work']);
    for (let suffix = 2; suffix < 20; suffix += 1) {
      taken.add(`checkin:c-1:tomorrow:work-${suffix}`);
    }
    const id = tomorrowExternalId('c-1', '!!!', taken);
    expect(id).toBe(`checkin:c-1:tomorrow:work-${taken.size + 1}`);
    expect(taken.has(id)).toBe(false);
  });

  test('a reply whose items all filter out falls back to the raw answer', () => {
    const raw = JSON.stringify({ work: [{ title: '   ', rawText: 'x' }] });
    const result = parseTomorrowSplit(raw, 'The real answer.', NO_IDS);
    expect(result.fallback).toBe(true);
    expect(result.items[0].rawText).toBe('The real answer.');
  });
});
