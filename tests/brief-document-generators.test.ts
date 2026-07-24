import { describe, expect, test } from 'bun:test';
import {
  composeAreaDocumentV2,
  setAreaLivingBriefDependenciesForTest,
} from '../lib/albatross/area-living-brief';
import { __setIntentPlanDepsForTest, composePlanDocumentV2 } from '../lib/albatross/intent-plan';
import { composeDocumentV2, createGenerationScopedWriter } from '../lib/mail/agent-report';
import type { DailyReport } from '../lib/shared/types';
import './tools/harness';
import { withToolContext } from './tools/harness';

const region = {
  id: 'lead',
  summary: 'The useful next move.',
  tree: {
    kind: 'hero',
    surface: 'glass',
    children: [{ kind: 'text', role: 'lede', text: 'Start with the useful next move.' }],
  },
};

function toolCallingGenerator(assertPrompt?: (options: any) => void) {
  return async (options: any) => {
    assertPrompt?.(options);
    await options.tools.place_region.execute({ region });
    await options.tools.finalize_brief.execute({
      title: 'Composed brief',
      summary: 'One accessible summary.',
    });
    return { text: '' };
  };
}

function reportFixture(): DailyReport {
  return {
    _id: 'report-1',
    kind: 'morning',
    generatedAt: Date.parse('2026-07-23T12:00:00Z'),
    status: 'ready',
    accounts: [],
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
      tasks: [],
      calendar: [],
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
  };
}

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

  test('Daily composition validates tool-placed regions and publishes progressive documents', async () => {
    const partials: string[][] = [];
    const document = await withToolContext(() =>
      composeDocumentV2(
        reportFixture(),
        undefined,
        async (partial) => {
          partials.push(partial.regions.map((item) => item.id));
        },
        toolCallingGenerator((options) => {
          expect(options.system).toContain('place_region');
          expect(options.system).toContain('Immediate with undo');
        }) as any,
      ),
    );

    expect(partials).toEqual([['lead']]);
    expect(document.title).toBe('Composed brief');
    expect(document.regions[0].tree.kind).toBe('hero');
  });

  test('Daily composition restores a protected thread omitted by the model', async () => {
    const report = reportFixture();
    report.accounts = ['jakob@example.com'];
    report.sections.replyOwed = [
      {
        account: 'jakob@example.com',
        threadId: 'thread-required',
        subject: 'Launch date',
        people: ['Maya'],
        whyItMatters: 'The date blocks planning.',
        nextAction: 'Confirm the July 31 delivery date.',
        openLoops: ['Confirm delivery date'],
        lane: 'reply_owed',
        surfacedBecause: ['reply_owed'],
        unread: false,
      },
    ];

    const document = await withToolContext(() =>
      composeDocumentV2(report, undefined, undefined, toolCallingGenerator() as any),
    );
    const json = JSON.stringify(document);

    expect(json).toContain('thread-required');
    expect(json).toContain('Confirm the July 31 delivery date.');
    expect(json).toContain('needs-you-required');
  });

  test('Area composition exposes only the shared v2 navigation vocabulary', async () => {
    let prompt = '';
    const restore = setAreaLivingBriefDependenciesForTest({
      generateTextForCurrentUser: toolCallingGenerator((options) => {
        prompt = options.prompt;
      }) as any,
    });
    try {
      const document = await composeAreaDocumentV2(
        {
          edition: { generatedAt: 1 },
          area: { areaId: 'area-1', name: 'Studio' },
          actions: { openTasks: { action: 'open_tasks', payload: {} } },
        },
        { lede: 'Studio is moving.', summary: 'One priority.' },
        { userId: 'user-1' },
      );
      expect(document.regions[0].id).toBe('lead');
      expect(JSON.parse(prompt).actions.openTasks).toEqual({
        action: 'open_view',
        payload: { view: 'tasks' },
      });
    } finally {
      restore();
    }
  });

  test('Work plan composition validates the shared document and keeps host controls outside it', async () => {
    __setIntentPlanDepsForTest({
      generateTextForCurrentUser: toolCallingGenerator((options) => {
        expect(options.system).toContain('host supplies Apply plan / Done controls');
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
