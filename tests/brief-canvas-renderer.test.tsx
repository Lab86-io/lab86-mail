import { describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { BriefCanvas } from '../components/report/brief-canvas/BriefCanvas';
import {
  degenerateBriefDocumentFixture,
  futureBriefDocumentFixture,
  richBriefDocumentFixture,
} from '../lib/shared/brief-document-fixtures';

function render(value: unknown) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <BriefCanvas value={value} />
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

  test('future documents reduce to an accessible title and summary', () => {
    const html = render(futureBriefDocumentFixture);
    expect(html).toContain('A future brief');
    expect(html).toContain('Update Albatross');
  });
});
