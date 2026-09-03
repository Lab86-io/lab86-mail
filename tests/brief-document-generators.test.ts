import { describe, expect, test } from 'bun:test';
import {
  composeAreaPulseDocument,
  fallbackAreaPulse,
  parseAreaPulse,
  renderAreaPulseHtml,
  setAreaLivingBriefDependenciesForTest,
  writeAreaPulse,
} from '../lib/albatross/area-living-brief';
import { __setIntentPlanDepsForTest, composePlanDocumentV2 } from '../lib/albatross/intent-plan';
import {
  composeBudgetBrief,
  createGenerationScopedWriter,
  finalizeBudgetReport,
} from '../lib/mail/agent-report';
import type { DailyReport, DailyReportItem } from '../lib/shared/types';
import './tools/harness';
import { withToolContext } from './tools/harness';

function reportFixture(): DailyReport {
  return {
    _id: 'report-1',
    kind: 'morning',
    generatedAt: Date.parse('2026-09-03T12:00:00Z'),
    status: 'ready',
    accounts: ['jakob@example.com'],
    title: 'Thursday',
    narrative: 'One priority today.',
    sections: {
      replyOwed: [],
      followUpOwed: [],
      newPeople: [],
      timeSensitive: [],
      tracked: [],
      fyi: [],
      bulkTail: [],
      answer: [item('thread-maya', 'Launch date', 'Maya', 'answer')],
      today: [],
      know: [item('thread-ben', 'Partner agreement', 'Ben', 'know')],
      tasks: [],
      calendar: [
        {
          account: 'jakob@example.com',
          eventId: 'event-dentist',
          title: 'Dentist',
          startAt: Date.parse('2026-09-03T14:00:00Z'),
          endAt: Date.parse('2026-09-03T15:00:00Z'),
          scope: 'week',
        },
        {
          account: 'jakob@example.com',
          eventId: 'event-review',
          title: 'Launch review',
          startAt: Date.parse('2026-09-07T15:00:00Z'),
          endAt: Date.parse('2026-09-07T16:00:00Z'),
          scope: 'week',
        },
      ],
      albatross: {
        includedAreas: [{ areaId: 'area_launch', name: 'Launch', reason: 'Live work' }],
        askBeforeCentering: [],
        activeIntents: [],
        activeProjects: [{ id: 'p1', title: 'Ship area briefs', areaId: 'area_launch', status: 'active' }],
        contextReview: [],
        completions: [],
      },
    },
    stats: {
      scannedThreads: 12,
      trackedThreads: 0,
      needsReply: 1,
      replyOwed: 1,
      dueSoon: 0,
      bulkTailCount: 0,
      noise: 10,
      selected: 2,
      unread: 0,
    },
  };
}

function item(
  threadId: string,
  subject: string,
  sender: string,
  budgetLane: 'answer' | 'today' | 'know',
): DailyReportItem {
  return {
    account: 'jakob@example.com',
    threadId,
    subject,
    people: [sender],
    sender,
    whyItMatters: `${sender} is waiting.`,
    unread: false,
    lane: 'reply_owed',
    budgetLane,
    score: 6,
    receivedAt: Date.parse('2026-09-02T12:00:00Z'),
  };
}

const loadMessages = async (_account: string, threadId: string) => [
  {
    _id: `${threadId}-m1`,
    account: 'jakob@example.com',
    threadId,
    from: threadId === 'thread-maya' ? 'Maya <maya@partner.test>' : 'Ben <ben@partner.test>',
    to: 'jakob@example.com',
    date: Date.parse('2026-09-02T12:00:00Z'),
    subject: 'x',
    textBody:
      threadId === 'thread-maya'
        ? 'Can you confirm the July 31 delivery date?'
        : 'Legal still needs to approve.',
  } as any,
];

describe('Brief Document v2 generators', () => {
  test('terminal artifact writes cannot be overwritten by late progressive callbacks', async () => {
    const events: string[] = [];
    let releasePersist!: () => void;
    let markPersistStarted!: () => void;
    const persistStarted = new Promise<void>((resolve) => {
      markPersistStarted = resolve;
    });
    const persistReleased = new Promise<void>((resolve) => {
      releasePersist = resolve;
    });
    const writer = createGenerationScopedWriter<string>(async (value) => {
      events.push(`start:${value}`);
      markPersistStarted();
      await persistReleased;
      events.push(`finish:${value}`);
    });

    const inFlight = writer.write('partial');
    await persistStarted;
    const closing = writer.close();
    const late = writer.write('late');
    releasePersist();
    await Promise.all([inFlight, closing, late]);
    await writer.write('later');
    events.push('terminal');

    expect(events).toEqual(['start:partial', 'finish:partial', 'terminal']);
  });

  test('budget composition makes one prose call and emits the fixed node layout', async () => {
    let calls = 0;
    let prompt = '';
    const composed = await withToolContext(() =>
      composeBudgetBrief(reportFixture(), 'user-1', {
        loadMessages,
        loadAreaPulses: async () => [
          {
            areaId: 'area_launch',
            pulse: { nextMove: 'Send the launch note to Maya.', lastChange: '', openQuestion: '', prose: '' },
          },
        ],
        loadWeather: async () => 'Rochester: rain, 61°F now.',
        generate: (async (options: any) => {
          calls += 1;
          prompt = options.prompt;
          expect(options.feature).toBe('daily_brief_prose');
          expect(options.system).toContain('Never write the word "AI"');
          return {
            text: JSON.stringify({
              lede: 'Maya needs the delivery date before she can book the venue. The dentist is at 10. Ben can wait until Friday. Nothing else needs you.',
              items: [
                {
                  key: 'jakob@example.com:thread-maya',
                  line: 'She asked for the July 31 date; one line back closes it.',
                },
                { key: 'jakob@example.com:thread-ben', line: '' },
                { key: 'not-a-real-key', line: 'Ignore me.' },
              ],
              weekAhead:
                'This Sunday is the launch review. Friday and Saturday are open. AI can help. Nothing else is booked!',
            }),
          };
        }) as any,
      }),
    );

    expect(calls).toBe(1);
    expect(prompt).toContain('Rochester: rain');
    expect(prompt).toContain('Can you confirm the July 31 delivery date?');
    expect(prompt).toContain('"weekday": "Thursday"');

    const { document, prose } = composed;
    expect(document.title).toBe('The Thursday Brief');
    expect(document.regions.map((region) => region.id)).toEqual([
      'lede',
      'answer',
      'today',
      'know',
      'week-ahead',
      'areas',
    ]);
    expect(document.regions[0].tree.kind).toBe('hero');
    expect(document.summary).toBe(prose.lede);

    const answer = document.regions[1].tree as any;
    expect(answer.kind).toBe('entity_list');
    expect(answer.title).toBe('Answer');
    expect(answer.items[0].ref).toEqual({
      kind: 'thread',
      id: 'thread-maya',
      account: 'jakob@example.com',
      label: 'Launch date',
    });
    expect(answer.items[0].framing).toEqual({
      lane: 'answer',
      reason: 'She asked for the July 31 date; one line back closes it.',
      sender: 'Maya',
    });
    expect(answer.items[0].actions).toEqual([
      {
        action: 'open_thread',
        label: 'Open',
        payload: { account: 'jakob@example.com', threadId: 'thread-maya' },
        style: 'quiet',
      },
    ]);

    const today = document.regions[2].tree as any;
    expect(today.items[0].ref.kind).toBe('event');
    expect(today.items[0].ref.id).toBe('event-dentist');
    expect(today.items[0].actions[0].action).toBe('open_event');
    // The Monday event is not today, so it stays out of the today lane.
    expect(today.items).toHaveLength(1);

    const know = document.regions[3].tree as any;
    expect(know.items[0].framing).toEqual({ lane: 'know', sender: 'Ben' });

    const week = document.regions[4].tree as any;
    expect(week.kind).toBe('text');
    expect(week.role).toBe('body');
    // Sentence with "AI" removed, exclamation mark softened, four-sentence cap.
    expect(week.text).toBe(
      'This Sunday is the launch review. Friday and Saturday are open. Nothing else is booked.',
    );

    const areas = document.regions[5].tree as any;
    expect(areas.variant).toBe('compact');
    expect(areas.items).toHaveLength(1);
    expect(areas.items[0].ref).toEqual({ kind: 'area', id: 'area_launch', label: 'Launch' });
    expect(areas.items[0].framing.reason).toBe('Send the launch note to Maya.');
    expect(areas.items[0].actions[0].payload).toEqual({ areaId: 'area_launch' });

    const finalized = finalizeBudgetReport(reportFixture(), composed);
    expect(finalized.narrative).toBe(prose.lede);
    expect(finalized.sections.answer?.[0].line).toBe(
      'She asked for the July 31 date; one line back closes it.',
    );
    expect(finalized.sections.know?.[0].line).toBeUndefined();
    expect(finalized.artifactSource).toBe('document-v2');
    expect(finalized.artifactStatus).toBe('ready');
    expect(finalized.html).toContain('<');
  }, 15_000);

  test('budget composition without a model writes a plain letter and keeps every item', async () => {
    const composed = await withToolContext(() =>
      composeBudgetBrief(reportFixture(), null, {
        loadMessages,
        generate: null,
        loadWeather: async () => null,
      }),
    );
    expect(composed.prose.model).toBe('local');
    expect(composed.prose.lede).toContain('Maya is waiting on a reply about Launch date.');
    expect(composed.prose.weekAhead).toContain('Today: Dentist at');
    expect(composed.prose.weekAhead).toContain('Monday: Launch review at');
    expect(composed.prose.weekAhead).toMatch(/Friday, Saturday, (and )?[A-Z][a-z]+day/);
    expect(composed.document.regions.map((region) => region.id)).toEqual([
      'lede',
      'answer',
      'today',
      'know',
      'week-ahead',
      'areas',
    ]);
    // Without a pulse the area line falls back to the report's area context.
    expect((composed.document.regions[5].tree as any).items[0].framing.reason).toBe(
      'Project: Ship area briefs',
    );
  });

  test('budget composition falls back to the plain letter when the model reply is not JSON', async () => {
    const composed = await withToolContext(() =>
      composeBudgetBrief(reportFixture(), null, {
        loadMessages,
        loadWeather: async () => null,
        generate: (async () => ({ text: 'Sorry, I cannot.' })) as any,
      }),
    );
    expect(composed.prose.model).toBe('local');
    expect(composed.document.regions[0].id).toBe('lede');
  });

  test('area pulse parses the model reply, clamps it, and falls back per field', () => {
    const context = {
      area: { areaId: 'area-1', name: 'Studio' },
      work: [{ title: 'Ship the intent layer', updatedAt: 10 }],
      tasks: [{ title: 'Write the artifact', completed: false, dueAt: 30 }],
      events: [],
      mail: [],
      projectPulse: [{ pendingQuestions: [{ questionId: 'q-1', prompt: 'Which venue?' }] }],
    };
    const fallback = fallbackAreaPulse(context);
    expect(fallback).toEqual({
      lastChange: 'Latest: Ship the intent layer.',
      nextMove: 'Next: Write the artifact.',
      openQuestion: 'Which venue?',
      prose: 'Studio has 1 active Work item and 1 open task.',
      model: 'local',
    });

    const parsed = parseAreaPulse(
      JSON.stringify({
        lastChange: 'Maya sent the venue list on Tuesday!',
        nextMove: '',
        openQuestion: 'AI should decide?',
        prose: 'One. Two. Three. Four.',
      }),
      fallback,
    );
    expect(parsed).toEqual({
      lastChange: 'Maya sent the venue list on Tuesday.',
      nextMove: 'Next: Write the artifact.',
      openQuestion: 'Which venue?',
      prose: 'One. Two. Three.',
    });
    expect(parseAreaPulse('no json here', fallback)).toBeNull();
  });

  test('area pulse document and HTML render from the pulse alone', () => {
    const context = {
      edition: { generatedAt: 1 },
      area: { areaId: 'area-1', name: 'Studio' },
      projectPulse: [{ pendingQuestions: [{ questionId: 'q-1', prompt: 'Which venue?' }] }],
    };
    const pulse = {
      lastChange: 'Maya sent the venue list.',
      nextMove: 'Pick a venue.',
      openQuestion: 'Which venue?',
      prose: 'The studio is waiting on a venue.',
    };
    const document = composeAreaPulseDocument(context, pulse);
    expect(document.title).toBe('Studio');
    expect(document.regions.map((region) => region.id)).toEqual(['lede', 'pulse', 'ask', 'open-work']);
    expect(document.regions[0].tree.kind).toBe('hero');
    expect((document.regions[1].tree as any).children.map((child: any) => child.text)).toEqual([
      'Last change: Maya sent the venue list.',
      'Next move: Pick a venue.',
      'Open question: Which venue?',
    ]);
    expect(document.regions[2].tree).toMatchObject({
      kind: 'prompt',
      variant: 'question',
      questionId: 'q-1',
    });
    expect(document.regions[3].tree).toMatchObject({
      kind: 'query_list',
      query: { name: 'area_open_work', areaId: 'area-1' },
    });

    const capture = composeAreaPulseDocument(
      { area: { areaId: 'area-1', name: 'Studio' } },
      { ...pulse, openQuestion: '' },
    );
    expect(capture.regions.find((region) => region.id === 'ask')?.tree).toMatchObject({
      kind: 'prompt',
      variant: 'capture',
    });

    const html = renderAreaPulseHtml('Studio & <Lab>', pulse);
    expect(html).toContain('Studio &amp; &lt;Lab&gt;');
    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain('Pick a venue.');
  });

  test('writeAreaPulse uses the fast lane once and survives a model failure', async () => {
    let calls = 0;
    const restore = setAreaLivingBriefDependenciesForTest({
      generateTextForCurrentUser: (async (options: any) => {
        calls += 1;
        expect(options.feature).toBe('albatross_area_pulse');
        expect(options.speed).toBe('fast');
        throw new Error('model down');
      }) as any,
    });
    try {
      const pulse = await writeAreaPulse({ area: { areaId: 'a', name: 'Studio' } }, { userId: 'user-1' });
      expect(calls).toBe(1);
      expect(pulse.model).toBe('local');
      expect(pulse.prose).toBe('Studio has 0 active Work items and 0 open tasks.');
    } finally {
      restore();
    }
  });

  test('Work plan composition validates the shared document and keeps host controls outside it', async () => {
    const region = {
      id: 'lead',
      summary: 'The useful next move.',
      tree: {
        kind: 'hero',
        surface: 'glass',
        children: [{ kind: 'text', role: 'lede', text: 'Start with the useful next move.' }],
      },
    };
    __setIntentPlanDepsForTest({
      generateTextForCurrentUser: (async (options: any) => {
        expect(options.system).toContain('host supplies Apply plan / Done controls');
        await options.tools.place_region.execute({ region });
        await options.tools.finalize_brief.execute({
          title: 'Composed brief',
          summary: 'One accessible summary.',
        });
        return { text: '' };
      }) as any,
    });
    try {
      const document = await composePlanDocumentV2(
        { title: 'Ship v2', outcome: 'A verified release.' },
        { userId: 'user-1' },
      );
      expect(document.summary).toBe('One accessible summary.');
      expect(document.regions[0].tree.kind).toBe('hero');
    } finally {
      __setIntentPlanDepsForTest();
    }
  });
});
