import { describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { BriefCanvas } from '../components/report/brief-canvas/BriefCanvas';
import {
  degenerateBriefDocumentFixture,
  futureBriefDocumentFixture,
  richBriefDocumentFixture,
} from '../lib/shared/brief-document-fixtures';

function render(value: unknown, extras?: { masthead?: boolean; footer?: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <BriefCanvas value={value} masthead={extras?.masthead} footer={extras?.footer} />
    </QueryClientProvider>,
  );
}

describe('BriefCanvas degradation', () => {
  test('renders the complete native vocabulary without a full-page iframe', () => {
    const html = render(richBriefDocumentFixture);
    expect(html).toContain('Thursday Brief');
    expect(html).toContain('Product review');
    expect(html).toContain('Review prep');
    expect(html).toContain('Shape of the day');
    expect(html).not.toContain('lab86-daily-report');
  });

  test('keeps fallback copy and hides unknown actions', () => {
    const html = render(degenerateBriefDocumentFixture);
    expect(html).toContain('A future leaf becomes a readable card.');
    expect(html).toContain('Tasks');
    expect(html).not.toContain('Dead action');
  });

  test('masthead hero and footer slot render around the document', () => {
    const html = render(richBriefDocumentFixture, {
      masthead: true,
      footer: <div>Footer slot content</div>,
    });
    expect(html).toContain('The Daily Brief');
    expect(html).toContain('Footer slot content');
    // The masthead owns the title; the plain header h1 must not duplicate it.
    expect(html.split('Thursday Brief').length - 1).toBe(1);
  });

  test('typography follows the customizer display face, not a fixed serif', () => {
    const html = render(richBriefDocumentFixture);
    expect(html).toContain('font-display');
    expect(html).not.toContain('font-serif');
  });

  test('future documents reduce to an accessible title and summary', () => {
    const html = render(futureBriefDocumentFixture);
    expect(html).toContain('A future brief');
    expect(html).toContain('Update Albatross');
  });
});
