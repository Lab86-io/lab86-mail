import { describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  openWorkspaceWork,
  TodayWeather,
  TodayWorkspace,
  WorkspaceThreadCard,
  weatherRequest,
  workspaceRequest,
  workspaceSourceDate,
} from '../components/narrative/TodayWorkspace';
import { persistedClientState, useClientStore } from '../lib/client-state';
import type { WorkspaceThread } from '../lib/narrative/workspace';

const thread: WorkspaceThread = {
  id: 'one',
  title: 'Atlas is ready for review',
  summary: 'The meeting left QA open.',
  nextStep: 'Review QA.',
  sources: [
    {
      id: 'one',
      title: 'Granola meeting',
      excerpt: 'QA remains open.',
      kind: 'meeting',
      occurredAt: 1000,
      trust: 'reported',
      href: '/narrative?id=one',
    },
  ],
  work: { id: 'work', title: 'Atlas QA', state: 'active', guided: true, nextStep: 'Review checklist' },
};
function render(node: ReactNode, key?: unknown[], data?: unknown) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (key) client.setQueryData(key, data);
  const html = renderToStaticMarkup(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
  client.clear();
  return html;
}
describe('Today working surface', () => {
  test('weather validates nested data and rejects malformed successful responses', async () => {
    const original = globalThis.fetch;
    try {
      for (const data of [{}, { asOf: 1, weather: {} }, { asOf: 1, weather: { current: null } }]) {
        globalThis.fetch = (async () => Response.json(data)) as typeof fetch;
        await expect(weatherRequest()).rejects.toThrow('Weather unavailable');
      }
      globalThis.fetch = (async () => new Response('<html>proxy</html>')) as typeof fetch;
      await expect(weatherRequest()).rejects.toThrow('Weather unavailable');
      const data = {
        asOf: 1,
        weather: {
          location: 'Rochester',
          unit: '°F',
          current: { temp: 72, condition: 'Clear', high: 77, low: 58 },
          daily: [{ precipChance: 20 }],
        },
      };
      globalThis.fetch = (async () => Response.json(data)) as typeof fetch;
      expect(await weatherRequest()).toEqual(data);
      globalThis.fetch = (async () => Response.json({ asOf: 1, weather: null })) as typeof fetch;
      expect(await weatherRequest()).toEqual({ asOf: 1, weather: null });
    } finally {
      globalThis.fetch = original;
    }
  });
  test('source dates respect the reader’s timezone and reject invalid instants', () => {
    const evening = Date.UTC(2026, 8, 9, 1);
    expect(workspaceSourceDate(evening, 'America/Los_Angeles')).toBe('2026-09-08');
    expect(workspaceSourceDate(evening, 'UTC')).toBe('2026-09-09');
    expect(workspaceSourceDate(Infinity)).toBeNull();
    expect(workspaceSourceDate(Number.MAX_VALUE)).toBeNull();
  });
  test('non-JSON failures and malformed success payloads show a safe retry message', async () => {
    const original = globalThis.fetch;
    try {
      for (const status of [502, 200]) {
        globalThis.fetch = (async () => new Response('<html>proxy error</html>', { status })) as typeof fetch;
        await expect(workspaceRequest({ action: 'generate', at: 1 })).rejects.toThrow(
          'Could not update Today. Please try again.',
        );
      }
      globalThis.fetch = (async () =>
        Response.json({ error: 'Context changed.' }, { status: 409 })) as typeof fetch;
      await expect(workspaceRequest({ action: 'generate', at: 1 })).rejects.toThrow('Context changed.');
      globalThis.fetch = (async () => Response.json({})) as typeof fetch;
      await expect(workspaceRequest({ action: 'generate', at: 1 })).rejects.toThrow(
        'Could not update Today. Please try again.',
      );
      await expect(workspaceRequest({ action: 'defer', at: 1 })).rejects.toThrow(
        'Could not update Today. Please try again.',
      );
    } finally {
      globalThis.fetch = original;
    }
  });
  test('source cards show dates and trust, work is distinct from suggestions', () => {
    const html = render(<WorkspaceThreadCard thread={thread} at={100} stamp="s" />);
    expect(html).toContain('Open guided work');
    expect(html).toContain('Mark work done');
    expect(html).toContain('Existing work');
    expect(html).toContain('User-reported');
    expect(html).toContain('1970-01-01');
    expect(html).toContain('/narrative?id=one');
    expect(html).toContain('Not today');
    expect(html).toContain('That’s wrong');
    const suggestion = render(
      <WorkspaceThreadCard thread={{ ...thread, work: undefined }} at={100} stamp="s" />,
    );
    expect(suggestion).toContain('not a task yet');
    expect(suggestion).toContain('Review &amp; create work');
    expect(suggestion).not.toContain('Mark work done');
  });
  test('paused work is not presented as an executable next step', () => {
    const html = render(
      <WorkspaceThreadCard
        thread={{ ...thread, work: { ...thread.work!, state: 'paused' } }}
        at={100}
        stamp="s"
      />,
    );
    expect(html).toContain('Open work');
    expect(html).not.toContain('Open guided work');
    expect(html).not.toContain('Mark work done');
  });
  test('generated workspace can be quiet and disappears when disabled', () => {
    const key = ['narrative', 'workspace', 100, 1];
    expect(
      render(<TodayWorkspace at={100} revision={1} />, key, {
        enabled: true,
        stamp: 's',
        mode: 'empty',
        threads: [],
      }),
    ).toContain('No extra threads');
    expect(
      render(<TodayWorkspace at={100} revision={1} />, key, { enabled: false, threads: [] }),
    ).not.toContain('data-today-workspace');
  });
  test('ongoing shapes have a response handoff without a false completion action', () => {
    for (const shape of ['practice', 'monitor', 'list'] as const) {
      const html = render(
        <WorkspaceThreadCard
          at={1000}
          stamp={'a'.repeat(64)}
          thread={{ ...thread, work: { ...thread.work!, shape } }}
        />,
      );
      expect(html).not.toContain('Mark work done');
      expect(html).toContain('Respond &amp; act');
    }
    expect(render(<WorkspaceThreadCard at={1000} stamp={'a'.repeat(64)} thread={thread} />)).toContain(
      'Mark work done',
    );
  });
  test('guided navigation is transient and does not execute work', () => {
    openWorkspaceWork('work', true);
    expect(useClientStore.getState()).toMatchObject({
      selectedWorkId: 'work',
      guidedWorkId: 'work',
      primaryView: 'albatrosses',
    });
    expect(persistedClientState(useClientStore.getState())).not.toHaveProperty('guidedWorkId');
    useClientStore.getState().setSelectedWorkId('different-work');
    expect(useClientStore.getState().guidedWorkId).toBeNull();
    openWorkspaceWork('other', false);
    expect(useClientStore.getState().guidedWorkId).toBeNull();
  });
  test('weather shows explicit place, units, high/low and attribution, never invented zeroes', () => {
    const data = {
      weather: {
        location: 'Rochester',
        unit: '°F',
        current: { temp: 72, condition: 'Clear', high: 77, low: 58 },
        daily: [{ precipChance: 20 }],
        source: 'Open-Meteo',
        attributionURL: 'https://open-meteo.com/',
      },
    };
    const html = render(<TodayWeather />, ['brief', 'weather'], data);
    expect(html).toContain('72');
    expect(html).toContain('Rochester');
    expect(html).toContain('Rain 20%');
    expect(html).toContain('Open-Meteo');
    const missing = render(<TodayWeather />, ['brief', 'weather'], { weather: null });
    expect(missing).toContain('Weather unavailable');
    expect(missing).not.toContain('0°');
  });
  test('masthead weather includes current conditions and a truthful precipitation probability', () => {
    const weather = {
      location: 'Rochester',
      unit: '°F',
      current: { temp: 72, condition: 'Clear', high: 77, low: 58 },
      source: 'Open-Meteo',
      attributionURL: 'https://open-meteo.com/',
    };
    for (const chance of [0, 15, 100]) {
      const html = render(<TodayWeather variant="masthead" />, ['brief', 'weather'], {
        weather: { ...weather, daily: [{ precipChance: chance }] },
      });
      expect(html).toContain('data-brief-header-weather');
      expect(html).toContain(`Precip. ${chance}%`);
      expect(html).toContain('72');
      expect(html).toContain('°F');
      expect(html).toContain('High ');
      expect(html).toContain('Low ');
      expect(html).toContain('Rochester');
      expect(html).toContain('https://open-meteo.com/');
      expect(html).not.toContain('data-slot="weather-widget"');
    }
    for (const chance of [null, undefined, -1, 101]) {
      const html = render(<TodayWeather variant="masthead" />, ['brief', 'weather'], {
        weather: { ...weather, daily: [{ precipChance: chance }] },
      });
      expect(html).toContain('Precip. unavailable');
      expect(html).not.toContain('Precip. 0%');
    }
    const missing = render(<TodayWeather variant="masthead" />, ['brief', 'weather'], { weather: null });
    expect(missing).toContain('Weather unavailable');
    expect(missing).toContain('Retry');
    expect(missing).not.toContain('0°');
  });
});

// Weather uses the place's time, including daylight-saving transitions.
test('weather local time follows the forecast location, with safe fallback for invalid zones', async () => {
  const { weatherLocalTime } = await import('../components/narrative/TodayWorkspace');
  expect(weatherLocalTime(Date.parse('2026-09-10T16:00:00Z'), 'America/New_York')).toBe(0.5);
  expect(weatherLocalTime(Date.parse('2026-01-10T17:00:00Z'), 'America/New_York')).toBe(0.5);
  expect(weatherLocalTime(Date.now(), 'invalid/zone')).toBeUndefined();
});
