import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import UpdatesPage, { metadata } from '../app/updates/page';
import { UpdateEntry, UpdateFeed } from '../components/updates/UpdateFeed';
import type { ProductUpdate } from '../lib/updates/model';

function update(count: number): ProductUpdate {
  return {
    id: 'inbox-improvements',
    publishedAt: '2026-10-15',
    title: 'An easier inbox',
    summary:
      count > 3
        ? {
            text: 'Find the mail you need faster.',
            demo: {
              caption: 'Try the new inbox view.',
              html: '<details><summary>Show inbox</summary>New mail view</details>',
            },
          }
        : undefined,
    changes: Array.from({ length: count }, (_, index) => ({
      id: `improvement-${index}`,
      kind: 'improved',
      title: `Inbox improvement ${index + 1}`,
      description: 'Less work to find your mail.',
    })),
  };
}

describe('What’s new', () => {
  test('three changes render directly and four start in a closed native disclosure', () => {
    const small = renderToStaticMarkup(<UpdateEntry update={update(3)} />);
    expect(small).not.toContain('<details');
    expect(small).toContain('Inbox improvement 3');
    const large = renderToStaticMarkup(<UpdateEntry update={update(4)} />);
    expect(large).toContain('<details');
    expect(large).not.toMatch(/<details[^>]*\bopen/);
    expect(large).toContain('See all 4 changes');
    expect(large).toContain('Find the mail you need faster.');
    expect(large).toContain('Inbox improvement 4');
  });

  test('HTML previews have an opaque sandbox and a readable text caption', () => {
    const entry = update(1);
    entry.preview = { caption: 'Your inbox, with clearer labels.', html: '<p>Inbox</p>' };
    const html = renderToStaticMarkup(<UpdateEntry update={entry} />);
    expect(html).toContain('<iframe');
    expect(html).toContain('sandbox=""');
    expect(html).not.toContain('allow-scripts');
    expect(html).not.toContain('allow-same-origin');
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(html).toContain('title="Preview: An easier inbox"');
    expect(html).toContain('<figcaption');
    expect(html).toContain('Your inbox, with clearer labels.');
    expect(html).toContain('tabindex="-1"');
  });

  test('the working demo belongs to the visible summary while all changes stay collapsed', () => {
    const entry = update(5);
    entry.preview = {
      caption: 'Extra illustration in the full notes.',
      html: '<p>A supplementary image</p>',
    };
    const html = renderToStaticMarkup(<UpdateEntry update={entry} />);
    const summaryStart = html.indexOf('data-slot="update-summary"');
    const summaryEnd = html.indexOf('</section>', summaryStart);
    const disclosureStart = html.indexOf('<details');
    const summary = html.slice(summaryStart, summaryEnd);
    expect(summary).toContain('Find the mail you need faster.');
    expect(summary).toContain('<iframe');
    expect(summary).toContain('Try the new inbox view.');
    expect(summary).toContain('tabindex="0"');
    expect(summary).toContain('sandbox=""');
    expect(summaryEnd).toBeLessThan(disclosureStart);
    expect(summary).not.toContain('Extra illustration in the full notes.');
    expect(html.slice(disclosureStart)).toContain('Extra illustration in the full notes.');
  });

  test('interactive demos receive pointer and keyboard access without enabling scripts', () => {
    const entry = update(1);
    entry.preview = {
      caption: 'Switch views to try it.',
      html: '<input aria-label="Summary" type="radio">',
      interactive: true,
    };
    const html = renderToStaticMarkup(<UpdateEntry update={entry} />);
    expect(html).toContain('tabindex="0"');
    expect(html).not.toContain('pointer-events-none');
    expect(html).toContain('sandbox=""');
    expect(html).not.toContain('allow-scripts');
  });

  test('screenshots render as images with their original dimensions and accessible text', () => {
    const entry = update(1);
    entry.preview = {
      caption: 'The summary view.',
      image: '/updates/update-summary-demo.png',
      alt: 'A summary of five changes.',
      width: 960,
      height: 490,
    };
    const html = renderToStaticMarkup(<UpdateEntry update={entry} />);
    expect(html).toContain('<img');
    expect(html).toContain('alt="A summary of five changes."');
    expect(html).toContain('width="960"');
    expect(html).toContain('height="490"');
    expect(html).toContain('/updates/update-summary-demo.png');
    expect(html).toContain('loading="lazy"');
    expect(renderToStaticMarkup(<UpdateEntry update={entry} latest />)).toContain('loading="eager"');
    expect(html).not.toContain('<iframe');
  });

  test('previews and versions are optional, with singular counts and an empty state', () => {
    const html = renderToStaticMarkup(<UpdateEntry update={update(1)} />);
    expect(html).not.toContain('<iframe');
    expect(html).toContain('1 change</span>');
    expect(renderToStaticMarkup(<UpdateFeed updates={[]} />)).toContain('New updates will appear here.');
  });

  test('the route renders the feed and provides navigation back to the app', () => {
    const html = renderToStaticMarkup(<UpdatesPage />);
    expect(metadata.title).toBe('What’s new · Albatross');
    expect(html).toContain('href="/"');
    expect(html).toContain('Back to Albatross');
    expect(html).toContain('A clearer view of what’s new');
    expect(html).toContain('Latest');
  });
});
