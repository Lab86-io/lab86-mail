import { describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { BriefActions } from '../components/report/brief-canvas/BriefActions';
import {
  BriefCanvas,
  briefActionHidesItem,
  executeBriefAction,
  undoBriefActionWithFeedback,
} from '../components/report/brief-canvas/BriefCanvas';
import { composeBudgetBriefDocument } from '../lib/mail/brief-budget-document';
import type { DailyReport, DailyReportItem } from '../lib/shared/types';

const NOW = Date.parse('2026-09-26T11:00:00Z');

function withFetch<T>(run: (requests: Array<{ url: string; body: any }>) => Promise<T>) {
  const original = globalThis.fetch;
  const requests: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(
      JSON.stringify({ ok: true, result: { ok: true, operationId: 'op-9', summary: 'Kept it out' } }),
    );
  }) as typeof fetch;
  return run(requests).finally(() => {
    globalThis.fetch = original;
  });
}

describe('steering from the web brief', () => {
  test('steer_item calls the steering tool, and its Undo reverses the logged operation', async () => {
    await withFetch(async (requests) => {
      const result = await executeBriefAction(
        'steer_item',
        {
          mode: 'less_from_sender',
          account: 'a1',
          threadId: 't1',
          subject: 'Plan',
          senderEmail: 'pat@example.com',
          receivedAt: NOW,
        },
        () => {},
      );
      expect(result).toMatchObject({ operationId: 'op-9' });
      expect(requests[0]).toEqual({
        url: '/api/tools/steer_brief_item',
        body: {
          mode: 'less_from_sender',
          account: 'a1',
          threadId: 't1',
          subject: 'Plan',
          senderEmail: 'pat@example.com',
          receivedAt: NOW,
        },
      });
      let undone = false;
      await undoBriefActionWithFeedback(
        'steer_item',
        { operationId: 'op-9' },
        { onUndone: () => (undone = true), onFailed: () => {} },
      );
      expect(undone).toBe(true);
      expect(requests[1]).toEqual({ url: '/api/tools/undo_operation', body: { operationId: 'op-9' } });
      await executeBriefAction('undo_operation', { operationId: 'op-7' }, () => {});
      expect(requests[2]).toEqual({ url: '/api/tools/undo_operation', body: { operationId: 'op-7' } });
      await expect(
        executeBriefAction('steer_item', { account: 'a1', threadId: 't1' }, () => {}),
      ).rejects.toThrow('omitted mode');
    });
  });

  test('Not for me and Less from hide the item now; Keep showing keeps it', () => {
    expect(briefActionHidesItem('steer_item', { mode: 'not_for_me' })).toBe(true);
    expect(briefActionHidesItem('steer_item', { mode: 'less_from_sender' })).toBe(true);
    expect(briefActionHidesItem('steer_item', { mode: 'keep_showing' })).toBe(false);
    expect(briefActionHidesItem('undo_operation', {})).toBe(true);
    expect(briefActionHidesItem('dismiss_thread', {})).toBe(true);
    expect(briefActionHidesItem('open_thread', {})).toBe(false);
  });

  test('the letter row keeps one action row and puts the steering choices behind the overflow control', () => {
    const item: DailyReportItem = {
      account: 'a1',
      threadId: 't1',
      subject: 'Plan',
      people: ['Maya'],
      whyItMatters: 'Reply.',
      unread: true,
      senderEmail: 'maya@example.com',
    };
    const document = composeBudgetBriefDocument({
      report: {
        generatedAt: NOW,
        narrative: 'Lede.',
        sections: { answer: [item] } as unknown as DailyReport['sections'],
      },
      prose: { lede: 'Lede.', weekAhead: '', lines: {} },
      timezone: 'UTC',
    });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <BriefCanvas value={document} />
      </QueryClientProvider>,
    );
    expect(html).toContain('data-brief-steering-trigger');
    expect(html).toContain('aria-label="Tune this item in the brief"');
    expect(html).not.toContain('data-brief-letter-action-name="steer_item"');
    expect(html).toContain('data-brief-letter-action-name="draft_reply"');
  });

  test('the canvas action bar also moves steering into the overflow control', () => {
    const html = renderToStaticMarkup(
      <BriefActions
        actions={[
          { action: 'open_thread', label: 'Open', payload: {}, style: 'quiet' },
          { action: 'steer_item', label: 'Not for me', payload: { mode: 'not_for_me' }, style: 'quiet' },
        ]}
        onAction={() => {}}
      />,
    );
    expect(html).toContain('>Open</button>');
    expect(html).not.toContain('>Not for me</button>');
    expect(html).toContain('data-brief-steering-trigger');
  });
});
