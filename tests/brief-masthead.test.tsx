import { describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { BriefMasthead } from '../components/report/brief-canvas/BriefMasthead';
import { briefFrameForDay } from '../lib/brief/frames';

function render(node: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

describe('brief masthead picture frame', () => {
  const at = Date.UTC(2026, 8, 10, 14, 0);

  test('hangs the day frame around the painting with its slice and credit', () => {
    const html = render(<BriefMasthead generatedAt={at} timezone="UTC" />);
    const frame = briefFrameForDay(at, 'UTC');
    expect(html).toContain(`data-brief-frame="${frame.id}"`);
    expect(html).toContain('brief-masthead--canvas');
    expect(html).toContain('brief-masthead__moulding');
    expect(html).toContain('brief-masthead__rabbet');
    expect(html).toContain(`--brief-frame-slice:${frame.slice.join(' ')}`);
    expect(html).toContain(frame.src);
    expect(html).toContain('Frame: ');
    expect(html).toContain(frame.credit);
    expect(html).toContain('--brief-art-ink:#');
    expect(html).toContain('brief-masthead__ink');
    expect(html).not.toContain('--accent-2-hue');
  });

  test('a pinned frame wins over the day, and Today gets the page inset', () => {
    const html = render(
      <BriefMasthead generatedAt={at} timezone="UTC" bleed={false} frameId="robert-gilt" />,
    );
    expect(html).toContain('data-brief-frame="robert-gilt"');
    expect(html).toContain('brief-masthead--page');
    expect(html).not.toContain('brief-masthead--canvas');
    expect(html).toContain('--brief-frame-scale:0.95');
  });

  test('an unknown pin falls back to the day frame', () => {
    const html = render(<BriefMasthead generatedAt={at} timezone="UTC" frameId="nope" />);
    expect(html).toContain(`data-brief-frame="${briefFrameForDay(at, 'UTC').id}"`);
  });
});
