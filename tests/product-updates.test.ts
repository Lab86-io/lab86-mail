import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { PRODUCT_UPDATES } from '../lib/updates/feed';
import {
  formatUpdateDate,
  type ProductUpdate,
  parseProductUpdates,
  shouldSummarizeUpdate,
} from '../lib/updates/model';
import { buildUpdatePreview } from '../lib/updates/preview';

function updateFixture(count: number, overrides: Partial<ProductUpdate> = {}): ProductUpdate {
  return {
    id: 'test-update',
    publishedAt: '2026-10-15',
    title: 'A calmer inbox',
    summary:
      count > 3
        ? {
            text: 'Mail is easier to sort and catch up on.',
            demo: {
              caption: 'Try the inbox change.',
              html: '<details><summary>Show mail</summary>New inbox view</details>',
            },
          }
        : undefined,
    changes: Array.from({ length: count }, (_, index) => ({
      id: `change-${index}`,
      kind: 'improved',
      title: `Improvement ${index + 1}`,
      description: `Details for improvement ${index + 1}.`,
    })),
    ...overrides,
  };
}

describe('product update batches', () => {
  test('keeps one through three changes visible and summarizes four or more', () => {
    for (const count of [1, 2, 3]) expect(shouldSummarizeUpdate(updateFixture(count))).toBe(false);
    for (const count of [4, 5, 20]) expect(shouldSummarizeUpdate(updateFixture(count))).toBe(true);
  });

  test('requires a useful summary only for batches over three', () => {
    expect(parseProductUpdates([updateFixture(3, { summary: undefined })])).toHaveLength(1);
    expect(() => parseProductUpdates([updateFixture(4, { summary: undefined })])).toThrow('need a summary');
    expect(() =>
      parseProductUpdates([
        updateFixture(4, { summary: { text: '  ', demo: { caption: 'Demo', html: '<p>Inbox</p>' } } }),
      ]),
    ).toThrow();
  });

  test('each summary owns a required HTML demonstration of its changes', () => {
    const entry = updateFixture(4);
    expect(parseProductUpdates([entry])[0].summary?.demo.html).toContain('New inbox view');
    for (const summary of [
      'A plain-text summary without a demo.',
      { text: 'Mail is easier to sort.' },
      {
        text: 'Mail is easier to sort.',
        demo: { caption: 'Demo', image: '/updates/update-summary-demo.png' },
      },
      { text: 'Mail is easier to sort.', demo: { caption: 'Demo', html: '' } },
      { text: 'Mail is easier to sort.', demo: { caption: '', html: '<p>Inbox</p>' } },
    ])
      expect(() => parseProductUpdates([{ ...entry, summary }])).toThrow();
  });

  test('sorts batches newest first without changing the input', () => {
    const input = [
      updateFixture(1, { id: 'older', publishedAt: '2026-09-30' }),
      updateFixture(1, { id: 'newer', publishedAt: '2026-10-15' }),
    ];
    expect(parseProductUpdates(input).map((update) => update.id)).toEqual(['newer', 'older']);
    expect(input[0].id).toBe('older');
  });

  test('rejects duplicate batch and change IDs, invalid dates, and empty batches', () => {
    expect(() => parseProductUpdates([updateFixture(1), updateFixture(1)])).toThrow('Update IDs');
    const update = updateFixture(2);
    update.changes[1].id = update.changes[0].id;
    expect(() => parseProductUpdates([update])).toThrow('Change IDs');
    expect(() => parseProductUpdates([updateFixture(1, { publishedAt: '2026-02-30' })])).toThrow();
    expect(() => parseProductUpdates([updateFixture(0)])).toThrow();
    expect(parseProductUpdates([])).toEqual([]);
  });

  test('a preview needs a caption and a bounded HTML fragment', () => {
    expect(() =>
      parseProductUpdates([updateFixture(1, { preview: { caption: '', html: '<p>Inbox</p>' } })]),
    ).toThrow();
    expect(() =>
      parseProductUpdates([updateFixture(1, { preview: { caption: 'Inbox', html: 'x'.repeat(40_001) } })]),
    ).toThrow();
  });

  test('screenshots need an accessible description, dimensions, and a local update asset', () => {
    const screenshot = {
      caption: 'The summary view.',
      image: '/updates/update-summary-demo.png',
      alt: 'An update summary with controls to show the full details.',
      width: 960,
      height: 490,
    };
    expect(parseProductUpdates([updateFixture(1, { preview: screenshot })])[0].preview).toEqual(screenshot);
    for (const invalid of [
      { ...screenshot, alt: '' },
      { ...screenshot, width: 0 },
      { ...screenshot, image: 'https://example.test/private.png' },
      { ...screenshot, image: '/updates/../secret.png' },
      { ...screenshot, html: '<p>Ambiguous preview</p>' },
    ])
      expect(() => parseProductUpdates([updateFixture(1, { preview: invalid })])).toThrow();
  });

  test('interactive HTML is an explicit opt-in; every shipped screenshot exists', () => {
    expect(
      parseProductUpdates([
        updateFixture(1, {
          preview: {
            caption: 'Try the view switch.',
            html: '<details><summary>Show</summary>Details</details>',
            interactive: true,
          },
        }),
      ])[0].preview,
    ).toHaveProperty('interactive', true);
    for (const note of PRODUCT_UPDATES) {
      if (note.preview && 'image' in note.preview)
        expect(existsSync(new URL(`../public${note.preview.image}`, import.meta.url))).toBe(true);
    }
  });

  test('the checked-in feed is valid and latest-first', () => {
    expect(PRODUCT_UPDATES.length).toBeGreaterThan(0);
    expect(parseProductUpdates(PRODUCT_UPDATES)).toEqual(PRODUCT_UPDATES);
  });

  test('release dates do not shift to the previous day in western time zones', () => {
    expect(formatUpdateDate('2026-10-15')).toBe('October 15, 2026');
  });
});

describe('HTML update previews', () => {
  test('an explicit app theme overrides the operating system appearance', () => {
    expect(buildUpdatePreview('<p>Inbox</p>', 'Inbox', 'dark')).toContain('data-theme="dark"');
    expect(buildUpdatePreview('<p>Inbox</p>', 'Inbox', 'light')).toContain('data-theme="light"');
    expect(buildUpdatePreview('<p>Inbox</p>', 'Inbox')).toContain('data-theme="system"');
  });
  test('blocks external resources, script execution, and form submissions', () => {
    const html = buildUpdatePreview('<p>A new inbox</p>', 'Inbox');
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("form-action 'none'");
    expect(html).toContain("base-uri 'none'");
    expect(html).toContain('<body><p>A new inbox</p></body>');
    expect(html).toContain('prefers-color-scheme:dark');
  });

  test('escapes the title so it cannot break out of the document head', () => {
    const html = buildUpdatePreview('<p>Preview</p>', '</title><script>alert("x")</script>');
    expect(html).toContain('&lt;/title&gt;');
    expect(html).not.toContain('<script>');
  });
});
