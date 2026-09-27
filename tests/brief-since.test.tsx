import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getFunctionName } from 'convex/server';
import { convexTest } from 'convex-test';
import { renderToStaticMarkup } from 'react-dom/server';
import './tools/harness';
import { BriefCanvas } from '../components/report/brief-canvas/BriefCanvas';
import { api } from '../convex/_generated/api';
import schema from '../convex/schema';
import { defaultEditorialPlan, editorialModules } from '../lib/brief/editorial';
import { briefLetterKind } from '../lib/brief/letter';
import {
  applySinceOperationStates,
  loadOperationStates,
  operationRefId,
  SINCE_REGION_TITLE,
  sinceOperationIds,
  sinceRegion,
} from '../lib/brief/since';
import { loadSinceLastEditionFromConvex } from '../lib/mail/agent-report';
import { composeBudgetBriefDocument } from '../lib/mail/brief-budget-document';
import type { DailyReport, DailyReportSinceLastEdition } from '../lib/shared/types';
import { getLatestDailyReport, setDailyReportReaderForTest } from '../lib/store/daily-reports';
import { withToolContext } from './tools/harness';

const NOW = Date.parse('2026-09-26T11:00:00Z');
const SECRET = 'since-secret';
const previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
beforeEach(() => {
  process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
});
afterEach(() => {
  if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
  setDailyReportReaderForTest();
});

const since: DailyReportSinceLastEdition = {
  previousGeneratedAt: NOW - 86_400_000,
  completions: [],
  agentActions: [
    {
      tool: 'archive_thread',
      surface: 'mail',
      summary: 'Archived 12 newsletters',
      createdAt: Date.parse('2026-09-26T01:40:00Z'),
      operationId: 'op-archive',
      undoable: true,
      reason: 'They matched your newsletter rule.',
      status: 'applied',
    },
    {
      tool: 'calendar_create_event',
      surface: 'calendar',
      summary: 'Held Friday 3 PM for the review',
      createdAt: Date.parse('2026-09-26T02:00:00Z'),
      operationId: 'op-hold',
      undoable: false,
      status: 'applied',
    },
    // An older edition's row without an id stays out of the list.
    { tool: 'x', surface: 'tasks', summary: 'No id', createdAt: NOW },
  ],
};

function report(extra: Partial<DailyReport> = {}): DailyReport {
  const base = {
    _id: 'r-since',
    kind: 'morning',
    generatedAt: NOW,
    accounts: [],
    title: 'Brief',
    narrative: 'Lede.',
    prose: { lede: 'Lede.', weekAhead: '', yesterday: 'You finished the deck.', model: 'local' },
    sections: {
      replyOwed: [],
      followUpOwed: [],
      newPeople: [],
      timeSensitive: [],
      tracked: [],
      fyi: [],
      bulkTail: [],
      answer: [],
      today: [],
      know: [],
      since,
    },
    stats: {
      scannedThreads: 0,
      trackedThreads: 0,
      needsReply: 0,
      replyOwed: 0,
      dueSoon: 0,
      bulkTailCount: 0,
      unread: 0,
    },
  } as unknown as DailyReport;
  const next = { ...base, ...extra };
  next.document = composeBudgetBriefDocument({
    report: next,
    prose: { lede: 'Lede.', weekAhead: '', yesterday: 'You finished the deck.', lines: {} },
    timezone: 'America/New_York',
  });
  return next;
}

describe('the look back region', () => {
  test('lists what Albatross did, with Undo only where the operation can be undone', () => {
    const region = sinceRegion(since, 'America/New_York');
    expect(region?.id).toBe('since');
    const tree = region?.tree as any;
    expect(tree.title).toBe(SINCE_REGION_TITLE);
    expect(tree.items.map((item: any) => item.ref)).toEqual([
      { kind: 'derived', id: 'operation:op-archive', label: 'Archived 12 newsletters' },
      { kind: 'derived', id: 'operation:op-hold', label: 'Held Friday 3 PM for the review' },
    ]);
    expect(tree.items[0].framing).toEqual({
      lane: 'since',
      sender: 'Mail · Fri 9:40 PM',
      reason: 'They matched your newsletter rule.',
    });
    expect(tree.items[0].actions).toEqual([
      {
        action: 'undo_operation',
        label: 'Undo',
        payload: { operationId: 'op-archive', summary: 'Archived 12 newsletters' },
        style: 'quiet',
      },
    ]);
    expect(tree.items[1].actions).toEqual([]);
    expect(region?.summary).toBe('Albatross took 2 actions since the last edition; 1 can be undone.');
    expect(sinceRegion({ ...since, agentActions: [] }, 'UTC')).toBeNull();
    expect(sinceRegion(undefined, 'UTC')).toBeNull();
  });

  test('the letter places it after the look-back paragraph, and a light edition keeps it', () => {
    const document = report().document!;
    expect(document.regions.map((region) => region.id)).toEqual(['lede', 'yesterday', 'since']);
    expect(briefLetterKind(document)).toBe('daily');
    expect(report({ light: true }).document!.regions.map((region) => region.id)).toContain('since');
  });

  test('the editorial writer receives it as one module', () => {
    const edition = report();
    const modules = editorialModules(edition, edition.document!);
    const module = modules.find((entry) => entry.id === 'since');
    expect(module?.title).toBe(SINCE_REGION_TITLE);
    expect(modules.filter((entry) => entry.section === 'since')).toHaveLength(1);
    const plan = defaultEditorialPlan(modules);
    expect(plan.regions.some((region) => region.id === 'since')).toBe(true);
  });

  test('the web letter renders each action with its Undo', () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <BriefCanvas value={report().document} />
      </QueryClientProvider>,
    );
    expect(html).toContain('data-brief-region="since"');
    expect(html).toContain('>What Albatross did</span>');
    expect(html).toContain('>Since yesterday</span>');
    expect(html).toContain('Archived 12 newsletters');
    expect(html).toContain('Mail · Fri 9:40 PM');
    expect(html).toContain('data-brief-letter-action-name="undo_operation"');
    expect(html).not.toMatch(/\bAI\b/);
  });
});

describe('the live look back', () => {
  test('an operation undone since the edition leaves it; a failed undo keeps its row', () => {
    const edition = report();
    expect(sinceOperationIds(edition)).toEqual(['op-archive', 'op-hold']);
    const live = applySinceOperationStates(
      edition,
      new Map([
        ['op-archive', 'undone'],
        ['op-hold', 'undo_failed'],
      ]),
    );
    const tree = live.document!.regions.find((region) => region.id === 'since')!.tree as any;
    expect(tree.items.map((item: any) => item.ref.id)).toEqual([operationRefId('op-hold')]);
    expect(live.sections.since?.agentActions.map((action) => action.status)).toEqual([
      'undone',
      'undo_failed',
      undefined,
    ]);
    expect(edition.sections.since?.agentActions[0].status).toBe('applied');
    expect(applySinceOperationStates(edition, new Map())).toBe(edition);
    expect(applySinceOperationStates(edition, new Map([['op-archive', 'applied']])).document).toBe(
      edition.document,
    );
  });

  test('the edition reader applies the live states', async () => {
    const edition = report();
    const asked: string[][] = [];
    setDailyReportReaderForTest({
      configured: () => true,
      load: (async () => edition) as any,
      loadDismissals: async () => ({}),
      loadClosedTracked: async () => new Set(),
      loadSelfAddresses: async () => new Set(),
      loadPolicy: (async () => ({ preferences: {}, corrections: [], revision: 0 })) as any,
      loadOperationStates: async (_userId: string, ids: string[]) => {
        asked.push(ids);
        return new Map([['op-archive', 'undone']]);
      },
      query: (async (fn: any) =>
        getFunctionName(fn) === 'userData:dailyReportPage'
          ? { page: [edition], isDone: true, continueCursor: '' }
          : []) as any,
    });
    const latest = await withToolContext(() => getLatestDailyReport(undefined, true));
    expect(asked).toEqual([['op-archive', 'op-hold']]);
    const tree = latest!.document!.regions.find((region) => region.id === 'since')!.tree as any;
    expect(tree.items).toHaveLength(1);
  });

  test('operation states come from the caller rows only', async () => {
    const t = convexTest(schema, {
      '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
      '../convex/dailyReports.ts': () => import('../convex/dailyReports'),
    });
    const ids = await t.run(async (ctx) => {
      const mine = await ctx.db.insert('aiOperations', {
        userId: 'u1',
        agent: 'ai',
        tool: 'archive_thread',
        surface: 'mail',
        summary: 'Archived',
        target: {},
        status: 'undone',
        createdAt: NOW,
      });
      const theirs = await ctx.db.insert('aiOperations', {
        userId: 'u2',
        agent: 'ai',
        tool: 'archive_thread',
        surface: 'mail',
        summary: 'Archived',
        target: {},
        status: 'applied',
        createdAt: NOW,
      });
      return [String(mine), String(theirs), 'not-an-id'];
    });
    const states = await loadOperationStates('u1', ids, ((fn: any, args: any) =>
      t.query(fn, { ...args, internalSecret: SECRET })) as any);
    expect([...states.entries()]).toEqual([[ids[0], 'undone']]);
    expect(await loadOperationStates('u1', [])).toEqual(new Map());
    await expect(t.query((api as any).dailyReports.operationStates, { userId: 'u1', ids })).rejects.toThrow();
  });

  test('the look back keeps the log row id, the undo flag, and the reason', async () => {
    const query = async <T,>(fn: unknown): Promise<T> => {
      if (getFunctionName(fn as any) === 'albatrossWork:completionsSince') return [] as T;
      return [
        {
          _id: 'op-1',
          agent: 'ai',
          status: 'applied',
          createdAt: NOW,
          tool: 'archive_thread',
          surface: 'mail',
          summary: 'Archived a thread',
          inverse: { kind: 'mail.unarchive', payload: {} },
          reason: '  It matched a rule.  ',
        },
        {
          _id: 'op-2',
          agent: 'ai',
          status: 'applied',
          createdAt: NOW,
          tool: 't',
          surface: 'tasks',
          summary: 'Done',
        },
      ] as T;
    };
    const result = await loadSinceLastEditionFromConvex('u1', NOW - 1000, query as any);
    expect(result.agentActions).toEqual([
      {
        tool: 'archive_thread',
        surface: 'mail',
        summary: 'Archived a thread',
        createdAt: NOW,
        operationId: 'op-1',
        undoable: true,
        reason: 'It matched a rule.',
        status: 'applied',
      },
      {
        tool: 't',
        surface: 'tasks',
        summary: 'Done',
        createdAt: NOW,
        operationId: 'op-2',
        undoable: false,
        status: 'applied',
      },
    ]);
  });
});
