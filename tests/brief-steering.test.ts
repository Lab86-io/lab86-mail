import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import { convexTest } from 'convex-test';
import './tools/harness';
import { api } from '../convex/_generated/api';
import schema from '../convex/schema';
import { buildAlbatrossDailyReportContext } from '../lib/albatross/daily-report';
import {
  BRIEF_STEER_UNDO_KIND,
  briefSenderCorrectionId,
  briefSteeringCorrection,
  briefThreadCorrectionId,
  steerBriefItem,
  undoBriefSteering,
} from '../lib/brief/steering';
import * as hosted from '../lib/hosted/convex';
import { DEFAULT_JEV_PREFERENCES, type JevAssessment } from '../lib/jev/contract';
import { handledSinceEdition, projectBriefMail } from '../lib/jev/report';
import { threadActions } from '../lib/mail/brief-budget-document';
import { composeReport } from '../lib/mail/daily-report';
import { briefActionTier, isBriefSteeringAction } from '../lib/shared/brief-actions';
import type { DailyReport, DailyReportItem, Thread, ThreadInsight } from '../lib/shared/types';
import { listDismissedDailyReportThreads } from '../lib/store/daily-report-dismissals';
import { getLatestDailyReport, setDailyReportReaderForTest } from '../lib/store/daily-reports';
import { upsertTrackedThread } from '../lib/store/tracked-threads';
import { steerBriefItemTool } from '../lib/tools/daily-report';
import { runTool, withToolContext } from './tools/harness';

const SECRET = 'steering-secret';
const NOW = Date.parse('2026-09-26T11:00:00Z');
const ACCOUNT = 'acct-1';
const previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
beforeEach(() => {
  process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
});
afterEach(() => {
  if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
  setDailyReportReaderForTest();
});

function convex() {
  return convexTest(schema, {
    '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
    '../convex/dailyReports.ts': () => import('../convex/dailyReports'),
  });
}

describe('steering corrections in Convex', () => {
  test('sets, replaces, and removes one correction, and returns the one it replaced', async () => {
    const t = convex();
    const set = (id: string, correction: unknown) =>
      t.mutation((api as any).dailyReports.setBriefCorrection, {
        internalSecret: SECRET,
        userId: 'u1',
        id,
        correction,
      });
    const exclude = {
      id: 'brief-thread-a',
      scope: 'thread',
      match: 't1',
      accountId: ACCOUNT,
      brief: 'exclude',
    };
    expect(await set('brief-thread-a', exclude)).toEqual({ previous: null });
    const include = { ...exclude, brief: 'include' };
    expect(await set('brief-thread-a', include)).toEqual({ previous: exclude });
    await expect(set('brief-thread-b', exclude)).rejects.toThrow('does not match');
    const row = await t.run((ctx) => ctx.db.query('userDocs').unique());
    expect(row?.doc.corrections).toEqual([include]);
    expect(row?.doc.preferences).toEqual(DEFAULT_JEV_PREFERENCES);
    expect(await set('brief-thread-a', null)).toEqual({ previous: include });
    expect((await t.run((ctx) => ctx.db.query('userDocs').unique()))?.doc.corrections).toEqual([]);
    await expect(
      t.mutation((api as any).dailyReports.setBriefCorrection, {
        internalSecret: 'wrong',
        userId: 'u1',
        id: 'x',
        correction: null,
      }),
    ).rejects.toThrow();
  });

  test('makes room from the oldest steering rule, never from a Settings rule', async () => {
    const t = convex();
    const settings = Array.from({ length: 60 }, (_, i) => ({
      id: `settings-${i}`,
      scope: 'sender' as const,
      match: `s${i}@example.com`,
      brief: 'exclude' as const,
    }));
    const steering = Array.from({ length: 40 }, (_, i) => ({
      id: `brief-sender-${i}`,
      scope: 'sender' as const,
      match: `b${i}@example.com`,
      brief: 'exclude' as const,
    }));
    await t.run((ctx) =>
      ctx.db.insert('userDocs', {
        userId: 'u1',
        kind: 'jevPreferences',
        key: 'default',
        doc: { preferences: DEFAULT_JEV_PREFERENCES, corrections: [...settings, ...steering] },
        createdAt: 1,
        updatedAt: 5,
      }),
    );
    const next = { id: 'brief-sender-new', scope: 'sender', match: 'new@example.com', brief: 'exclude' };
    await t.mutation((api as any).dailyReports.setBriefCorrection, {
      internalSecret: SECRET,
      userId: 'u1',
      id: next.id,
      correction: next,
    });
    const row = await t.run((ctx) => ctx.db.query('userDocs').unique());
    const ids = row?.doc.corrections.map((rule: any) => rule.id);
    expect(ids).toHaveLength(100);
    expect(ids).not.toContain('brief-sender-0');
    expect(ids).toContain('settings-0');
    expect(ids.at(-1)).toBe('brief-sender-new');
    // The revision moves, so a Settings save that raced this write reloads.
    expect(row?.updatedAt).toBeGreaterThan(5);

    const full = convex();
    await full.run((ctx) =>
      ctx.db.insert('userDocs', {
        userId: 'u1',
        kind: 'jevPreferences',
        key: 'default',
        doc: {
          preferences: DEFAULT_JEV_PREFERENCES,
          corrections: Array.from({ length: 100 }, (_, i) => ({ ...settings[0], id: `settings-${i}` })),
        },
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    await expect(
      full.mutation((api as any).dailyReports.setBriefCorrection, {
        internalSecret: SECRET,
        userId: 'u1',
        id: next.id,
        correction: next,
      }),
    ).rejects.toThrow('At most 100');
  });
});

describe('steering an item', () => {
  function deps(overrides: Record<string, unknown> = {}) {
    const calls: Record<string, any[]> = { set: [], dismiss: [], restore: [], record: [], lookup: [] };
    return {
      calls,
      deps: {
        setCorrection: async (userId: string, id: string, correction: unknown) => {
          calls.set.push({ userId, id, correction });
          return { previous: null };
        },
        lookupSender: async (...args: unknown[]) => {
          calls.lookup.push(args);
          return 'looked-up@example.com';
        },
        dismiss: async (input: unknown) => {
          calls.dismiss.push(input);
          return input as any;
        },
        restore: async (input: unknown) => {
          calls.restore.push(input);
        },
        record: async (input: unknown) => {
          calls.record.push(input);
          return 'op-1';
        },
        ...overrides,
      } as any,
    };
  }

  test('Not for me excludes the thread, drops the item now, and logs an undoable operation', async () => {
    const { calls, deps: injected } = deps();
    const result = await withToolContext(() =>
      steerBriefItem(
        'u1',
        { mode: 'not_for_me', account: ACCOUNT, threadId: 't1', subject: 'Quarterly plan', receivedAt: NOW },
        injected,
      ),
    );
    expect(result).toMatchObject({
      ok: true,
      operationId: 'op-1',
      summary: 'Kept “Quarterly plan” out of the brief',
    });
    expect(calls.set[0].correction).toEqual({
      id: briefThreadCorrectionId(ACCOUNT, 't1'),
      scope: 'thread',
      match: 't1',
      accountId: ACCOUNT,
      brief: 'exclude',
    });
    expect(calls.dismiss[0]).toMatchObject({ account: ACCOUNT, threadId: 't1', receivedAt: NOW });
    expect(calls.record[0]).toMatchObject({
      userId: 'u1',
      agent: 'user',
      tool: 'steer_brief_item',
      surface: 'mail',
      inverse: { kind: BRIEF_STEER_UNDO_KIND, payload: { previous: null, dismissed: true } },
    });
    expect(calls.lookup).toHaveLength(0);
  });

  test('Keep showing includes the thread and keeps the item', async () => {
    const { calls, deps: injected } = deps();
    const result = await steerBriefItem(
      'u1',
      { mode: 'keep_showing', account: ACCOUNT, threadId: 't1' },
      injected,
    );
    expect(result.summary).toBe('Kept this conversation in the brief until you change it');
    expect(calls.set[0].correction.brief).toBe('include');
    // The same id as Not for me, so one choice replaces the other.
    expect(calls.set[0].id).toBe(briefThreadCorrectionId(ACCOUNT, 't1'));
    expect(calls.dismiss).toHaveLength(0);
  });

  test('Less from this sender uses the item address, or looks it up', async () => {
    const first = deps();
    await withToolContext(() =>
      steerBriefItem(
        'u1',
        {
          mode: 'less_from_sender',
          account: ACCOUNT,
          threadId: 't1',
          senderEmail: 'Maya <MAYA@example.com>',
        },
        first.deps,
      ),
    );
    expect(first.calls.set[0].correction).toEqual({
      id: briefSenderCorrectionId('maya@example.com'),
      scope: 'sender',
      match: 'maya@example.com',
      brief: 'exclude',
    });
    expect(first.calls.lookup).toHaveLength(0);
    const second = deps();
    const result = await withToolContext(() =>
      steerBriefItem('u1', { mode: 'less_from_sender', account: ACCOUNT, threadId: 't2' }, second.deps),
    );
    expect(second.calls.lookup[0]).toEqual(['u1', ACCOUNT, 't2']);
    expect(result.summary).toBe('Showing less from looked-up@example.com in the brief');
    const none = deps({ lookupSender: async () => null });
    await expect(
      steerBriefItem('u1', { mode: 'less_from_sender', account: ACCOUNT, threadId: 't3' }, none.deps),
    ).rejects.toThrow('could not tell who sent');
    expect(() =>
      briefSteeringCorrection({ mode: 'less_from_sender', account: ACCOUNT, threadId: 't' }, null),
    ).toThrow();
  });

  test('Undo restores the previous correction and brings the item back', async () => {
    const { calls, deps: injected } = deps();
    const previous = { id: 'x', scope: 'thread' as const, match: 't1', brief: 'include' as const };
    await undoBriefSteering(
      { correctionId: 'x', previous, account: ACCOUNT, threadId: 't1', dismissed: true },
      'u1',
      injected,
    );
    expect(calls.set[0]).toEqual({ userId: 'u1', id: 'x', correction: previous });
    expect(calls.restore[0]).toEqual({ account: ACCOUNT, threadId: 't1' });
    await undoBriefSteering(
      { correctionId: 'y', previous: null, account: ACCOUNT, threadId: 't1', dismissed: false },
      'u1',
      injected,
    );
    expect(calls.set[1]).toEqual({ userId: 'u1', id: 'y', correction: null });
    expect(calls.restore).toHaveLength(1);
  });

  test('the tool runs the real store: it dismisses, records, and undo reverses through the log', async () => {
    const mutations: Array<{ name: string; args: any }> = [];
    const mutation = spyOn(hosted, 'convexMutation').mockImplementation((async (fn: any, args: any) => {
      const name = getFunctionName(fn);
      mutations.push({ name, args });
      if (name === 'dailyReports:setBriefCorrection') return { previous: null };
      if (name === 'operations:record') return 'op-real';
      if (name === 'operations:claimUndo')
        return {
          state: 'claimed',
          tool: 'steer_brief_item',
          surface: 'mail',
          summary: 's',
          inverse: mutations.find((call) => call.name === 'operations:record')?.args.inverse,
        };
      return null;
    }) as any);
    try {
      const result = await runTool(steerBriefItemTool.handler, {
        mode: 'not_for_me',
        account: ACCOUNT,
        threadId: 'tool-thread',
        subject: 'From the tool',
      });
      expect(result.operationId).toBe('op-real');
      const dismissed = await withToolContext(() => listDismissedDailyReportThreads());
      expect(dismissed.some((row) => row.threadId === 'tool-thread')).toBe(true);
      const { undoOperation } = await import('../lib/ai/operations');
      await withToolContext(() => undoOperation('test_user_tools', 'op-real'));
      const after = await withToolContext(() => listDismissedDailyReportThreads());
      expect(after.some((row) => row.threadId === 'tool-thread')).toBe(false);
      const sets = mutations.filter((call) => call.name === 'dailyReports:setBriefCorrection');
      expect(sets.map((call) => call.args.correction?.brief ?? null)).toEqual(['exclude', null]);
    } finally {
      mutation.mockRestore();
    }
  });

  test('the default sender lookup never returns the user address', async () => {
    const query = spyOn(hosted, 'convexQuery').mockImplementation((async (fn: any) => {
      const name = getFunctionName(fn);
      if (name === 'jev:threadAssessments')
        return [{ jev: { sender: 'me@example.com' }, fromAddress: 'Pat <pat@example.com>' }];
      if (name === 'accounts:listConnectedAccounts') return [{ email: 'ME@example.com' }];
      return null;
    }) as any);
    const mutation = spyOn(hosted, 'convexMutation').mockImplementation((async (fn: any, args: any) =>
      getFunctionName(fn) === 'operations:record' ? 'op-2' : { previous: null, args }) as any);
    try {
      const result = await runTool(steerBriefItemTool.handler, {
        mode: 'less_from_sender',
        account: ACCOUNT,
        threadId: 'lookup-thread',
      });
      expect(result.correction.match).toBe('pat@example.com');
    } finally {
      query.mockRestore();
      mutation.mockRestore();
    }
  });
});

describe('steering in the document', () => {
  const item = (extra: Partial<DailyReportItem> = {}): DailyReportItem => ({
    account: ACCOUNT,
    threadId: 't1',
    subject: 'Plan',
    people: ['Maya'],
    whyItMatters: 'Because.',
    unread: false,
    ...extra,
  });

  test('lane items carry the steering choices after their other actions; waiting items do not', () => {
    const answer = threadActions(item({ senderEmail: 'maya@example.com' }), 'answer');
    expect(answer.map((action) => `${action.action}:${action.payload.mode ?? ''}`)).toEqual([
      'open_thread:',
      'draft_reply:',
      'dismiss_thread:',
      'steer_item:not_for_me',
      'steer_item:less_from_sender',
      'steer_item:keep_showing',
    ]);
    expect(answer[4].payload.senderEmail).toBe('maya@example.com');
    const know = threadActions(item(), 'know');
    expect(know.map((action) => action.payload.mode).filter(Boolean)).toEqual(['not_for_me', 'keep_showing']);
    expect(
      threadActions(item({ dueAt: NOW }), 'today').some((action) => action.action === 'steer_item'),
    ).toBe(true);
    expect(threadActions(item(), 'waiting').some((action) => action.action === 'steer_item')).toBe(false);
    expect(briefActionTier('steer_item')).toBe('immediate');
    expect(briefActionTier('undo_operation')).toBe('immediate');
    expect(isBriefSteeringAction('steer_item')).toBe(true);
    expect(isBriefSteeringAction('dismiss_thread')).toBe(false);
  });
});

describe('handled items leave the live edition', () => {
  const policy = { preferences: DEFAULT_JEV_PREFERENCES, corrections: [] as any[] };
  const assessment = (
    kinds: Array<'reply' | 'action' | 'waiting'>,
    sourceRevision = 'rev-1',
  ): JevAssessment => ({
    version: 1,
    questionVersion: 'mail-1',
    sourceMessageId: 'm1',
    sourceRevision,
    evaluatedAt: NOW,
    model: 'jev',
    status: 'accepted',
    purpose: 'conversation',
    subjectKind: 'general',
    confidence: 0.9,
    obligations: kinds.map((kind) => ({
      kind,
      evidence: { messageId: 'm1', text: 'Evidence.' },
      probability: 0.9,
    })),
    meaningfulChange: false,
    probabilities: {},
    contextComplete: true,
    sender: 'maya@example.com',
  });
  const item = (threadId: string, extra: Partial<DailyReportItem> = {}): DailyReportItem => ({
    account: ACCOUNT,
    threadId,
    subject: threadId,
    people: ['Maya'],
    whyItMatters: 'Because.',
    unread: true,
    inInbox: true,
    receivedAt: NOW - 3600_000,
    budgetLane: 'know',
    score: 5,
    ...extra,
  });
  const thread = (threadId: string, extra: Partial<Thread> = {}): Thread =>
    ({
      _id: threadId,
      account: ACCOUNT,
      subject: threadId,
      fromAddress: 'Maya <maya@example.com>',
      lastDate: NOW - 3600_000,
      labels: ['INBOX'],
      unread: true,
      ...extra,
    }) as Thread;
  const report = (sections: Partial<DailyReport['sections']>): DailyReport =>
    ({
      _id: 'r1',
      kind: 'morning',
      generatedAt: NOW - 2 * 3600_000,
      accounts: [ACCOUNT],
      title: 'Brief',
      narrative: 'Lede.',
      tier: 'pro',
      prose: { lede: 'Lede.', weekAhead: '', model: 'local' },
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
        overflow: [],
        waiting: [],
        ...sections,
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
    }) as DailyReport;

  test('the rule tells trashed, archived, read, and answered apart', () => {
    const self = new Set(['me@example.com']);
    const base = { included: false, waiting: false, selfAddresses: self };
    expect(handledSinceEdition(item('a'), thread('a', { labels: ['TRASH'] }), base)).toBe('trashed');
    expect(handledSinceEdition(item('a'), thread('a', { labels: ['CATEGORY_PERSONAL'] }), base)).toBe(
      'archived',
    );
    // Not known to be in the inbox at edition time: never read as archived.
    expect(
      handledSinceEdition(item('a', { inInbox: undefined }), thread('a', { labels: ['X'] }), base),
    ).toBeNull();
    expect(handledSinceEdition(item('a'), thread('a', { unread: false }), base)).toBe('read');
    // Reading does not answer a request.
    expect(
      handledSinceEdition(item('a'), thread('a', { unread: false, jev: assessment(['reply']) }), base),
    ).toBeNull();
    expect(
      handledSinceEdition(
        item('a', { unread: false }),
        thread('a', { fromAddress: 'Me <me@example.com>', lastDate: NOW }),
        base,
      ),
    ).toBe('answered');
    // Waiting items wait for the reply; Keep showing keeps everything.
    expect(
      handledSinceEdition(item('a'), thread('a', { unread: false }), { ...base, waiting: true }),
    ).toBeNull();
    expect(
      handledSinceEdition(item('a'), thread('a', { labels: ['TRASH'] }), { ...base, included: true }),
    ).toBeNull();
  });

  test('the live projection drops handled items and keeps the rest', () => {
    const edition = report({
      know: [item('read'), item('kept')],
      answer: [
        item('archived', { budgetLane: 'answer' }),
        item('answered', { budgetLane: 'answer', unread: false }),
      ],
      waiting: [item('waiting', { budgetLane: undefined })],
    });
    const live = projectBriefMail(
      edition,
      [
        thread('read', { unread: false }),
        thread('kept'),
        thread('archived', { labels: [] }),
        thread('answered', { fromAddress: 'me@example.com', lastDate: NOW }),
        thread('waiting', { unread: false, fromAddress: 'me@example.com', lastDate: NOW }),
      ],
      policy,
      NOW,
      { selfAddresses: new Set(['me@example.com']) },
    );
    const shown = [
      ...(live.sections.answer ?? []),
      ...(live.sections.know ?? []),
      ...(live.sections.waiting ?? []),
    ].map((entry) => entry.threadId);
    // An empty label list is unknown, so "archived" stays.
    expect(shown.sort()).toEqual(['archived', 'kept', 'waiting']);
  });

  test('Keep showing keeps a read item, and a closed tracked thread leaves any edition', () => {
    const edition = report({ know: [item('keep'), item('tracked', { trackedThreadId: 'tr-1' })] });
    const keep = projectBriefMail(
      edition,
      [thread('keep', { unread: false }), thread('tracked')],
      {
        ...policy,
        corrections: [{ id: 'k', scope: 'thread', match: 'keep', accountId: ACCOUNT, brief: 'include' }],
      },
      NOW,
      { closedTracked: new Set(['tr-1']) },
    );
    expect((keep.sections.know ?? []).map((entry) => entry.threadId)).toEqual(['keep']);
    const old = projectBriefMail(edition, [], policy, NOW + 3 * 86_400_000, {
      closedTracked: new Set(['tr-1']),
    });
    expect((old.sections.know ?? []).map((entry) => entry.threadId)).toEqual(['keep']);
    expect(projectBriefMail(edition, [], policy, NOW + 3 * 86_400_000, { closedTracked: new Set() })).toBe(
      edition,
    );
  });

  test('the reader loads closed tracked threads and the user addresses', async () => {
    const edition = report({
      know: [
        item('answered', { trackedThreadId: 'tr-open' }),
        item('closed', { trackedThreadId: 'tr-closed' }),
      ],
    });
    const asked: string[][] = [];
    setDailyReportReaderForTest({
      configured: () => true,
      load: (async () => edition) as any,
      loadDismissals: async () => ({}),
      loadPolicy: (async () => ({ ...policy, revision: 0 })) as any,
      loadClosedTracked: async (ids: string[]) => {
        asked.push(ids);
        return new Set(['tr-closed']);
      },
      loadSelfAddresses: async () => new Set(['me@example.com']),
      query: (async (fn: any) => {
        const name = getFunctionName(fn);
        if (name === 'userData:dailyReportPage') return { page: [edition], isDone: true, continueCursor: '' };
        if (name === 'jev:threadAssessments')
          return [thread('answered', { fromAddress: 'me@example.com', lastDate: NOW })];
        return [];
      }) as any,
    });
    const latest = await withToolContext(() => getLatestDailyReport(undefined, true));
    expect(asked).toEqual([['tr-open', 'tr-closed']]);
    expect(latest?.sections.know ?? []).toEqual([]);
  });

  test('the edition records unread, inbox, and sender facts for each item', async () => {
    const insight = (threadId: string): ThreadInsight =>
      ({
        _id: `${ACCOUNT}:${threadId}`,
        account: ACCOUNT,
        threadId,
        subject: threadId,
        summary: 'Summary.',
        people: ['Maya'],
        commitments: [],
        openLoops: [],
        needsReply: true,
        waitingOnSomeone: false,
        suggestedTrack: false,
        suggestedCategory: 'main',
        reason: 'Reply.',
        replyOwed: true,
        followUpOwed: false,
        isNewSender: false,
        isPersonal: true,
        isImportant: false,
        isPriorCorrespondent: true,
        briefEligible: true,
        floorProtected: true,
        lane: 'reply_owed',
        surfacedBecause: [],
        generatedAt: NOW,
        model: 'local',
        jev: threadId === 'b' ? assessment(['reply']) : undefined,
      }) as ThreadInsight;
    const composed = await withToolContext(() =>
      composeReport({
        kind: 'morning',
        now: NOW,
        accounts: [ACCOUNT],
        insights: [insight('a'), insight('b')],
        tracked: [],
        lastDateByKey: new Map(),
        calendarContext: [],
        taskContext: [],
        memoryContext: [],
        albatrossContext: buildAlbatrossDailyReportContext({ now: NOW }),
        errors: [],
        reportId: 'facts',
        tier: 'pro',
        threadFacts: new Map([
          [`${ACCOUNT}:a`, { unread: true, inInbox: true, senderEmail: 'pat@example.com' }],
        ]),
      }),
    );
    const byId = new Map((composed.sections.answer ?? []).map((entry) => [entry.threadId, entry]));
    expect(byId.get('a')).toMatchObject({ unread: true, inInbox: true, senderEmail: 'pat@example.com' });
    expect(byId.get('b')).toMatchObject({ unread: false, senderEmail: 'maya@example.com' });
    expect(byId.get('b')?.inInbox).toBeUndefined();
  });
});

describe('the default reader loaders', () => {
  test('a tracked thread the user resolved leaves the latest edition, and a failed look-back read keeps it', async () => {
    const user = { userId: 'closed_tracked_reader' };
    const tracked = await withToolContext(
      () =>
        upsertTrackedThread({
          account: ACCOUNT,
          threadId: 'resolved-thread',
          subject: 'Resolved',
          status: 'resolved',
        }),
      user,
    );
    const edition = {
      _id: 'r-default',
      kind: 'morning',
      generatedAt: Date.now() - 3 * 86_400_000,
      accounts: [ACCOUNT],
      title: 'Brief',
      narrative: 'Lede.',
      sections: {
        replyOwed: [],
        followUpOwed: [],
        newPeople: [],
        timeSensitive: [],
        tracked: [],
        fyi: [],
        bulkTail: [],
        know: [
          {
            account: ACCOUNT,
            threadId: 'resolved-thread',
            subject: 'Resolved',
            people: [],
            whyItMatters: 'Because.',
            unread: false,
            trackedThreadId: tracked._id,
          },
        ],
        since: {
          previousGeneratedAt: 0,
          completions: [],
          agentActions: [
            {
              tool: 't',
              surface: 'mail',
              summary: 'Archived',
              createdAt: 1,
              operationId: 'op-x',
              undoable: true,
            },
          ],
        },
      },
      stats: {},
    } as unknown as DailyReport;
    setDailyReportReaderForTest({
      configured: () => true,
      load: (async () => edition) as any,
      loadDismissals: async () => ({}),
      loadOperationStates: async () => {
        throw new Error('convex down');
      },
      query: (async (fn: any) =>
        getFunctionName(fn) === 'userData:dailyReportPage'
          ? { page: [edition], isDone: true, continueCursor: '' }
          : []) as any,
    });
    const latest = await withToolContext(() => getLatestDailyReport(undefined, true), user);
    expect(latest?.sections.know ?? []).toEqual([]);
    expect(latest?.sections.since?.agentActions[0].operationId).toBe('op-x');
  });
});
