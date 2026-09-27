import { describe, expect, test } from 'bun:test';
import { navigateBriefAction } from '../components/report/brief-canvas/BriefCanvas';

function harness() {
  const opened: Array<[string, string, string]> = [];
  return {
    opened,
    navigation: {
      setSelectedThread: () => {},
      setThreadAccount: () => {},
      setPrimaryView: () => {},
      setSelectedAreaId: () => {},
      setSelectedWorkId: () => {},
      setPendingReplyBody: () => {},
      setChatScope: () => {},
      setAiBarOpen: () => {},
      openExternal: (url: string, target: '_blank', features: 'noopener,noreferrer') =>
        opened.push([url, target, features]),
    },
  };
}

describe('BriefCanvas navigation', () => {
  test('open_url uses the shared HTTPS-and-host gate before opening a new tab', () => {
    const target = harness();

    navigateBriefAction('open_url', { url: 'https://example.com/action' }, target.navigation);
    expect(target.opened).toEqual([['https://example.com/action', '_blank', 'noopener,noreferrer']]);

    for (const url of ['http://example.com/action', 'javascript:alert(1)', 'not a url', 'https:///']) {
      navigateBriefAction('open_url', { url }, target.navigation);
    }
    expect(target.opened).toHaveLength(1);
  });
});

describe('BriefCanvas action guard', () => {
  test('an action the executor does not know fails with the visible copy', async () => {
    const { BRIEF_UNKNOWN_ACTION_COPY, executeBriefAction } = await import(
      '../components/report/brief-canvas/BriefCanvas'
    );
    expect(BRIEF_UNKNOWN_ACTION_COPY).toBe('The brief cannot run this action yet.');
    await expect(executeBriefAction('summon_dragon', {}, () => {})).rejects.toThrow(
      BRIEF_UNKNOWN_ACTION_COPY,
    );
  });
});

describe('BriefCanvas calendar and undo actions', () => {
  test('create_event sends ISO start and end times to the calendar tool', async () => {
    const { executeBriefAction } = await import('../components/report/brief-canvas/BriefCanvas');
    const original = globalThis.fetch;
    const requests: Array<{ url: string; body: any }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ ok: true, result: { ok: true } }));
    }) as typeof fetch;
    try {
      const start = Date.UTC(2026, 8, 28, 15);
      await executeBriefAction(
        'create_event',
        { account: 'a@example.com', title: 'Review', startAt: start, endAt: '2026-09-28T16:00:00.000Z' },
        () => {},
      );
      expect(requests[0].url).toBe('/api/tools/calendar_create_event');
      expect(requests[0].body).toMatchObject({
        account: 'a@example.com',
        title: 'Review',
        startIso: '2026-09-28T15:00:00.000Z',
        endIso: '2026-09-28T16:00:00.000Z',
      });
      expect(requests[0].body.startAt).toBeUndefined();
      await expect(
        executeBriefAction(
          'create_event',
          { account: 'a', title: 'x', startAt: start, endAt: start },
          () => {},
        ),
      ).rejects.toThrow('valid start and end');
      expect(requests).toHaveLength(1);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('a failed Undo reports the failure', async () => {
    const { BRIEF_UNDO_FAILED_COPY, undoBriefActionWithFeedback } = await import(
      '../components/report/brief-canvas/BriefCanvas'
    );
    expect(BRIEF_UNDO_FAILED_COPY).not.toMatch(/\bAI\b/);
    const failed: unknown[] = [];
    let undone = 0;
    const handlers = { onUndone: () => undone++, onFailed: (error: unknown) => failed.push(error) };
    expect(
      await undoBriefActionWithFeedback('dismiss_task', {}, handlers, async () => {
        throw new Error('offline');
      }),
    ).toBe(false);
    expect(failed).toHaveLength(1);
    expect(undone).toBe(0);
    expect(await undoBriefActionWithFeedback('dismiss_task', {}, handlers, async () => undefined)).toBe(true);
    expect(undone).toBe(1);
  });
});
