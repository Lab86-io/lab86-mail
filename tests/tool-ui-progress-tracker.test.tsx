import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProgressTracker } from '../components/tool-ui/progress-tracker';

describe('Tool UI ProgressTracker surfaces', () => {
  test('renders a receipt on a bare parent surface without nested card chrome', () => {
    const html = renderToStaticMarkup(
      <ProgressTracker
        id="release-receipt"
        steps={[{ id: 'testflight', label: 'TestFlight ready', status: 'completed' }]}
        choice={{
          outcome: 'success',
          summary: 'Release prepared',
          at: '2026-07-27T18:00:00.000Z',
        }}
        surface="bare"
      />,
    );

    expect(html).toContain('data-slot="progress-tracker"');
    expect(html).toContain('data-receipt="true"');
    expect(html).toContain('data-slot="progress-card" class="flex w-full flex-col gap-4"');
    expect(html).toContain('Release prepared');
    expect(html).toContain('TestFlight ready');
    expect(html).not.toContain('bg-card/60');
    expect(html).not.toContain('rounded-2xl border p-5 shadow-xs');
  });

  test('keeps card chrome as the default receipt surface', () => {
    const html = renderToStaticMarkup(
      <ProgressTracker
        id="release-receipt-card"
        steps={[{ id: 'archive', label: 'Archive complete', status: 'completed' }]}
        choice={{
          outcome: 'success',
          summary: 'Archive complete',
          at: '2026-07-27T18:00:00.000Z',
        }}
      />,
    );

    expect(html).toContain('bg-card/60');
    expect(html).toContain('rounded-2xl border p-5 shadow-xs');
  });
});
