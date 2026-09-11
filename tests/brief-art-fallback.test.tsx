import { describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { BriefMasthead } from '../components/report/brief-canvas/BriefMasthead';
import { briefFrameById } from '../lib/brief/frames';
import type { DailyArt } from '../lib/mail/daily-art';

describe('displayed artwork state', () => {
  test('fallback updates frame, ink and credit together; another day resets an exhausted chain', async () => {
    const previous = (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
    const art: DailyArt = {
      imageUrl: '/first.jpg',
      title: 'First',
      artist: 'Artist A',
      date: '1300',
      credit: 'First, Artist A',
      source: 'Museum A',
      style: 'gothic',
      palette: ['#b4281e'],
      fallbacks: ['/second.jpg'],
      fallbackArt: [
        {
          imageUrl: '/second.jpg',
          title: 'Second',
          artist: 'Artist B',
          date: '1920',
          credit: 'Second, Artist B',
          source: 'Museum B',
          style: 'modern',
          palette: ['#143cbe'],
        },
      ],
    };
    const render = (at: number) => (
      <QueryClientProvider client={client}>
        <BriefMasthead generatedAt={at} artwork={art} timezone="UTC" />
      </QueryClientProvider>
    );
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(render(Date.UTC(2026, 8, 10)));
      });
      const masthead = () => renderer!.root.find((node) => !!node.props['data-brief-frame']);
      const firstInk = masthead().props.style['--brief-art-ink'];
      expect(briefFrameById(masthead().props['data-brief-frame'])?.styles).toContain('gothic');
      const staleError = renderer!.root.findByType('img').props.onError;
      await act(async () => staleError());
      expect(renderer!.root.findByType('img').props.src).toBe('/second.jpg');
      expect(briefFrameById(masthead().props['data-brief-frame'])?.styles).toContain('modern');
      expect(masthead().props.style['--brief-art-ink']).not.toBe(firstInk);
      expect(JSON.stringify(renderer!.toJSON())).toContain('Second, Artist B');
      await act(async () => staleError());
      expect(renderer!.root.findByType('img').props.src).toBe('/second.jpg');
      await act(async () => renderer!.root.findByType('img').props.onError());
      expect(renderer!.root.findAllByType('img')).toHaveLength(0);
      expect(JSON.stringify(renderer!.toJSON())).not.toContain('Artist B');
      await act(async () => renderer!.update(render(Date.UTC(2026, 8, 11))));
      expect(renderer!.root.findByType('img').props.src).toBe('/first.jpg');
    } finally {
      if (renderer) await act(async () => renderer!.unmount());
      client.clear();
      (globalThis as any).IS_REACT_ACT_ENVIRONMENT = previous;
    }
  });
});
