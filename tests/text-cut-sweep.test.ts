import { describe, expect, spyOn, test } from 'bun:test';
import './tools/harness';
import * as gateway from '../lib/ai/gateway';
import { chatCaptureRawText } from '../lib/albatross/capture-from-chat';
import { captureWork } from '../lib/albatross/capture-work';
import { buildAlbatrossDailyReportContext } from '../lib/albatross/daily-report';
import {
  captureFallbackItem,
  horizonForSplitItem,
  localMinuteOfDay,
  preserveCaptureText,
} from '../lib/albatross/work-v2';
import { composeEditorialDocument, defaultEditorialPlan } from '../lib/brief/editorial';
import { buildTriageHandoffIndex } from '../lib/brief/triage-index';
import { briefNotificationBody } from '../lib/mail/brief-ready';
import { composeReport } from '../lib/mail/daily-report';
import { matchingMailExcerpt } from '../lib/mail/search/ranking';
import { clipClassifierBody } from '../lib/mail/smart-categories';
import { detectMailSuggestions } from '../lib/mail/suggestion-detectors';
import { normalizeRecommendation } from '../lib/mail/thread-handoff';
import { assessUrgency, parseUrgencyConfirmation } from '../lib/mail/urgency';
import { loadGitHubItems } from '../lib/mcp/github';
import { cleanNarrativeProse, NARRATIVE_LIMITS } from '../lib/narrative/core';
import type { TrackedThread } from '../lib/shared/types';
import { summarizeThread } from '../lib/tools/ai';
import { briefComponentFixtures } from './fixtures/brief-components';
import { editorialFixture } from './fixtures/editorial';
import { report } from './fixtures/jev';
import { runTool, seedThreadMessage, withToolContext } from './tools/harness';
import { accountRow, withHttpHarness } from './tools/http-harness';

// An emoji is two UTF-16 code units. Each input below puts one across the
// cut, so a plain `.slice` would leave a lone surrogate that Convex rejects.
const EMOJI = '\u{1F600}';
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const across = (index: number, tail = 'tail') => `${'x'.repeat(index - 1)}${EMOJI}${tail}`;
// Mathematical bold A: astral, but not a pictograph, so stripEmoji keeps it.
const acrossAstral = (index: number, tail = 'tail') => `${'x'.repeat(index - 1)}\u{1D400}${tail}`;
const NOW = Date.parse('2026-09-22T11:00:00Z');

function expectWellFormed(value: string | undefined) {
  expect(typeof value).toBe('string');
  expect(LONE.test(value!)).toBe(false);
  expect(JSON.stringify(value)).not.toMatch(/\\ud[89a-f][0-9a-f]{2}/i);
}

describe('text cuts keep emoji whole at their limits', () => {
  test('mail classifier, search excerpt, handoff and notification cuts', () => {
    // Head cut at 2500, tail cut at -1500.
    const body = `${across(2500)}${'y'.repeat(3000)}${EMOJI}${'z'.repeat(1499)}`;
    expect(LONE.test(body.slice(0, 2500))).toBe(true);
    expect(LONE.test(body.slice(-1500))).toBe(true);
    expectWellFormed(clipClassifierBody(body));
    expect(clipClassifierBody('short body')).toBe('short body');

    const excerptSource = `${'a'.repeat(10)}${EMOJI}${'b'.repeat(119)}budget`;
    expect(LONE.test(excerptSource.slice(excerptSource.indexOf('budget') - 120))).toBe(true);
    expectWellFormed(matchingMailExcerpt(excerptSource, 'budget'));
    expectWellFormed(matchingMailExcerpt(across(1600), 'none'));

    expectWellFormed(normalizeRecommendation(across(280, ' and more words')));
    expect(normalizeRecommendation('Reply to Maya with the signed budget today')).toBe(
      'Reply to Maya with the signed budget today',
    );

    const lede = across(180, ' more words to pass the limit');
    expectWellFormed(briefNotificationBody({ prose: { lede } }));
    expectWellFormed(
      briefNotificationBody({ prose: { lede: across(179, ' more words to pass the limit') } }),
    );
  });

  test('capture, work and narrative cuts', () => {
    expectWellFormed(chatCaptureRawText(across(20_000)));
    expect(chatCaptureRawText(' hello ', ' reply ')).toBe('hello\n\nreply');
    expectWellFormed(preserveCaptureText(across(20_000)));
    expectWellFormed(captureFallbackItem(across(180)).title);
    expect(captureFallbackItem('Book the dentist').title).toBe('Book the dentist');
    expectWellFormed(cleanNarrativeProse(across(NARRATIVE_LIMITS.body)));
    expect(cleanNarrativeProse('<b>Met</b>   Maya')).toBe('Met Maya');
    // A local date the zone cannot read falls back to no bound; a bad zone to UTC.
    expect(horizonForSplitItem({ kind: 'later', notBeforeIso: 'not a date' }, 'later', NOW, 'UTC')).toEqual({
      kind: 'later',
    });
    expect(localMinuteOfDay('Not/AZone', new Date(NOW))).toBe(11 * 60);
  });

  test('reviewed capture items keep whole emoji in their titles', async () => {
    await withHttpHarness(async (h) => {
      h.onConvex('albatrossNotifications:deliveryTimezone', () => 'America/New_York');
      h.onConvex('albatrossWorkV2:beginCapture', () => 'capture-1');
      h.onConvex('albatrossWorkV2:finishCapture', (args) =>
        args.items.map((_: unknown, i: number) => `w${i}`),
      );
      const result = await captureWork(
        {
          rawText: 'Plan the trip',
          source: 'text',
          reviewedItems: [{ title: across(180), rawText: 'Plan the trip' }],
        },
        { userId: 'user_capture', email: 'owner@example.com', name: 'Owner', source: 'clerk' },
      );
      expect(result).toMatchObject({ status: 'split', workIds: ['w0'] });
      const finish = h.convexCalls.find((call) => call.path === 'albatrossWorkV2:finishCapture');
      expectWellFormed(finish?.args.items[0].title);
      expect(finish?.args.items[0].title).toBe('x'.repeat(179));
    });
  });

  test('editorial region summaries and a full page with live updates', () => {
    const { letter, modules } = editorialFixture();
    const plan = defaultEditorialPlan([{ ...modules[0], summary: across(1000) }]);
    expectWellFormed(plan.regions[0].summary);
    // A page already at twelve regions takes new sources into its last region.
    const full = {
      version: 1,
      regions: Array.from({ length: 12 }, (_, i) => ({
        id: `region-${i}`,
        summary: `Region ${i}`,
        tree: {
          kind: 'component',
          id: `story-${i}`,
          component: 'editorial-text',
          props: briefComponentFixtures['editorial-text'],
          sources: ['calendar'],
          summary: 'The day ahead',
        },
      })),
    };
    const document = composeEditorialDocument(letter, modules, full, false, false);
    expect(document.regions).toHaveLength(12);
    expect(document.regions[11].tree.kind).toBe('stack');
  });

  test('triage handoffs, urgency reasons and connector titles', async () => {
    const edition = report([]);
    edition.sections.tasks = [
      { cardId: 'hi', boardId: 'b', columnId: 'c', title: 'Book the venue', priority: 'high' },
      { cardId: 'lo', boardId: 'b', columnId: 'c', title: 'Plan', description: acrossAstral(500) },
    ] as any;
    const handoffs = new Map(buildTriageHandoffIndex(edition).map((item) => [item.sourceKey, item]));
    expect(handoffs.get('task:hi')?.assessment).toBe('This task is marked high priority.');
    expectWellFormed(handoffs.get('task:lo')?.assessment);
    expect(handoffs.get('task:lo')?.assessment).toBe('x'.repeat(499));

    expect(
      assessUrgency(
        { subject: 'Invoice due today', from: 'Billing <b@example.test>', receivedAt: NOW },
        { now: NOW },
      ),
    ).toMatchObject({ urgent: true, kind: 'deadline' });
    const confirmed = parseUrgencyConfirmation(
      JSON.stringify({ urgent: true, confidence: 0.9, reason: across(120, ' more') }),
    );
    expectWellFormed(confirmed.reason);

    const project = {
      id: 'PVT_1',
      title: across(500),
      owner: { login: 'jakob' },
      updatedAt: '2026-09-20T00:00:00Z',
    };
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/user')) return Response.json({ login: 'jakob' });
      if (url.includes('/search/')) return Response.json({ items: [] });
      if (url.includes('/user/repos')) return Response.json([]);
      if (url.endsWith('/graphql') && init?.method === 'POST') {
        const query = String(JSON.parse(String(init.body)).query);
        if (query.includes('AlbatrossProjectItems'))
          return Response.json({
            data: {
              node: {
                items: {
                  nodes: [{ id: 'PVTI_1', type: 'DRAFT_ISSUE', content: { title: 'Draft the plan' } }],
                },
              },
            },
          });
        return Response.json({
          data: { user: { projectsV2: { nodes: [project] } }, viewer: { organizations: { nodes: [] } } },
        });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    const { items } = await loadGitHubItems('https://api.github.com', 'token', fetchImpl);
    const projectItem = items.find((item) => item.externalId === 'github:project:PVT_1');
    expectWellFormed(projectItem?.title);
    expect(projectItem?.title).toBe('x'.repeat(499));
  });

  test('tracked brief lines keep whole emoji at the line limit', async () => {
    const tracked = (threadId: string, patch: Partial<TrackedThread>): TrackedThread => ({
      _id: `tracked-${threadId}`,
      account: 'jakob@example.com',
      threadId,
      subject: `Tracked ${threadId}`,
      participants: ['Daniel Ruiz <daniel@example.com>'],
      status: 'open',
      reason: 'Unread',
      openLoops: [],
      importance: 2,
      source: 'manual',
      createdAt: NOW - 86_400_000,
      updatedAt: NOW,
      ...patch,
    });
    const composed = await withToolContext(() =>
      composeReport({
        kind: 'morning',
        now: NOW,
        accounts: ['jakob@example.com'],
        insights: [],
        tracked: [
          tracked('long', { reason: acrossAstral(280, ' and the rest of the reason') }),
          tracked('due', { dueAt: NOW + 86_400_000 }),
          tracked('next', { nextAction: 'Send the signed form' }),
          tracked('waiting', { status: 'waiting' }),
          tracked('open', {}),
        ],
        lastDateByKey: new Map(),
        calendarContext: [],
        taskContext: [],
        memoryContext: [],
        albatrossContext: buildAlbatrossDailyReportContext({ now: NOW }),
        errors: [],
        reportId: 'r-sweep',
        tier: 'pro',
      }),
    );
    const lines = new Map(
      (composed.sections.tracked ?? []).map((item) => [item.threadId, item.whyItMatters]),
    );
    expectWellFormed(lines.get('long'));
    expect(lines.get('long')).toBe('x'.repeat(279));
    expect(lines.get('due')).toContain('due');
    expect(lines.get('next')).toBe('Next: Send the signed form (with Daniel Ruiz).');
    expect(lines.get('waiting')).toBe('Waiting on Daniel Ruiz about Tracked waiting.');
    expect(lines.get('open')).toBe('Tracking Daniel Ruiz — Tracked open.');
  });

  test('thread summaries and inline event suggestions send and store whole emoji', async () => {
    const hasAi = spyOn(gateway, 'hasAiForCurrentUser').mockResolvedValue(true);
    const prompts: string[] = [];
    const generate = spyOn(gateway, 'generateTextForCurrentUser').mockImplementation((async (
      options: any,
    ) => {
      prompts.push(String(options.prompt));
      if (options.feature === 'mail_event_suggestion')
        return {
          text: JSON.stringify({
            isEvent: true,
            confidence: 0.95,
            title: across(180),
            startIso: new Date(Date.now() + 86_400_000).toISOString(),
            endIso: new Date(Date.now() + 90_000_000).toISOString(),
            allDay: false,
            location: null,
            reason: 'The email names a meeting time.',
          }),
        };
      return { text: 'Summary of the thread.' };
    }) as any);
    try {
      const { account, threadId } = await seedThreadMessage({
        threadId: 'thread_sweep_summary',
        messageId: 'msg_sweep_1',
        subject: 'Launch',
        textBody: across(4000),
      });
      await seedThreadMessage({
        account,
        threadId,
        messageId: 'msg_sweep_2',
        subject: 'Launch',
        textBody: 'OK',
      });
      const summary = await runTool(summarizeThread.handler, { account, threadId });
      expect(summary.summary).toBe('Summary of the thread.');
      expect(prompts.length).toBeGreaterThan(0);
      for (const prompt of prompts) expectWellFormed(prompt);

      await withHttpHarness(async (h) => {
        h.onConvex('albatrossNotifications:deliveryTimezone', () => 'UTC');
        h.onConvex('suggestions:getByDedupe', () => null);
        h.onConvex('suggestions:upsert', () => 'suggestion-1');
        h.onConvex('albatrossNotifications:queueSuggestionNotification', () => ({
          notificationId: 'n-1',
          created: false,
        }));
        await detectMailSuggestions(accountRow(), [
          {
            providerMessageId: 'ics-1',
            providerThreadId: 't-ics',
            subject: 'Invitation: design review',
            from: 'Maya <maya@example.test>',
            receivedAt: Date.now(),
            attachments: [{ id: 'att-1', filename: 'invite.ics', contentType: 'text/calendar' }],
          },
          {
            providerMessageId: 'inline-1',
            providerThreadId: 't-inline',
            subject: 'Meeting tomorrow',
            from: 'Maya <maya@example.test>',
            receivedAt: Date.now(),
            textBody: across(8_000, ' Can we meet tomorrow at 10?'),
          },
        ]);
        const upserts = h.convexCalls.filter((call) => call.path === 'suggestions:upsert');
        expect(upserts.map((call) => call.args.title)).toEqual([
          'Invitation: design review',
          'x'.repeat(179),
        ]);
      });
      for (const prompt of prompts) expectWellFormed(prompt);
    } finally {
      hasAi.mockRestore();
      generate.mockRestore();
    }
  });
});
