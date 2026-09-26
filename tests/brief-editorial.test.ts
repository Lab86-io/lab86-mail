import { expect, spyOn, test } from 'bun:test';
import * as editorial from '../lib/brief/editorial';
import {
  composeEditorialDocument,
  defaultEditorialPlan,
  editorialModules,
  hasLiveBriefSection,
} from '../lib/brief/editorial';
import { collectBriefRefs } from '../lib/brief/hydration';
import { briefLetterKind } from '../lib/brief/letter';
import { projectBriefMail } from '../lib/jev/report';
import { composeDailyBrief, finalizeBudgetReport } from '../lib/mail/agent-report';
import { composeBudgetBriefDocument } from '../lib/mail/brief-budget-document';
import { createDailyEditorialSession, writeDailyEditorial } from '../lib/mail/brief-editorial';
import { lintBriefDocument, parseBriefDocument } from '../lib/shared/brief-document';
import { migrateDailyReport } from '../lib/store/daily-reports';
import { editorialFixture } from './fixtures/editorial';
import { assessment, NOW, policy, report, thread } from './fixtures/jev';
import { withToolContext } from './tools/harness';

test('final reading order is independent of creation and repair order and cannot omit or repeat regions', async () => {
  const { edition, letter, plan } = editorialFixture();
  const session = createDailyEditorialSession(edition, letter);
  const options = { toolCallId: 'reading-order', messages: [] };
  const regions = structuredClone(plan.regions);
  expect((await session.tools.place_regions.execute!({ regions: [...regions].reverse() }, options)).ok).toBe(
    true,
  );
  const order = regions.map((region) => region.id);
  for (const invalid of [order.slice(1), [...order.slice(1), order[1]], [...order.slice(1), 'invented']]) {
    expect(
      (
        await session.tools.finalize_brief.execute!(
          { title: 'Today', summary: 'Review', regionOrder: invalid },
          options,
        )
      ).ok,
    ).toBe(false);
    expect(session.result()).toBeNull();
  }
  expect(
    (
      await session.tools.finalize_brief.execute!(
        { title: 'Today', summary: 'Review', regionOrder: order },
        options,
      )
    ).ok,
  ).toBe(true);
  expect(session.result()?.plan.regions.map((region) => region.id)).toEqual(order);
  expect(session.result()?.document.regions.map((region) => region.id)).toEqual(
    order.map((id) => `editorial-${id}`),
  );
});

test('the writer receives the local edition date and completion evidence excluded from story ranking', async () => {
  const { edition, letter, plan } = editorialFixture();
  edition.generatedAt = Date.parse('2026-09-23T01:30:00Z');
  letter.timezone = 'America/New_York';
  edition.sections.mcp = [
    {
      server: 'github',
      kind: 'pull_request',
      title: 'Cedar PR #42',
      state: 'merged',
      updatedAt: edition.generatedAt,
      repository: 'cedar/app',
    },
  ];
  const result = await writeDailyEditorial(edition, letter, {
    generate: (async (options: any) => {
      const prompt = JSON.parse(options.prompt);
      expect(prompt.localDate).toBe('Tuesday, September 22');
      expect(prompt.localTime).toBe('9:30 PM');
      expect(prompt.connectedEvidence[0]).toMatchObject({ title: 'Cedar PR #42', state: 'merged' });
      expect(options.system).toContain('never rename this edition');
      expect(options.system).toContain('secondary snapshots');
      return { output: plan };
    }) as any,
  });
  expect(result.editorial.mode).toBe('generated');
});

test('an authored page preserves grounded sources, calendar actions, task completion, and explicit layout identity', () => {
  const { edition, letter } = editorialFixture();
  const document = parseBriefDocument(edition.document);
  expect(document.layout).toBe('editorial');
  expect(briefLetterKind(document)).toBeNull();
  expect(lintBriefDocument(document)).toEqual([]);
  expect(collectBriefRefs(document)).toEqual(collectBriefRefs(letter));
  expect(document.regions[1].tree.kind).toBe('split');
  const json = JSON.stringify(document);
  expect(json).toContain('"action":"open_event"');
  expect(json).toContain('"action":"draft_reply"');
  expect(json).toContain('"action":"toggle_task"');
  expect(json).toContain('"cardId":"check"');
  expect(hasLiveBriefSection(document, 'narrative')).toBe(true);
  expect(hasLiveBriefSection(document, 'prepared_work')).toBe(true);
});

test('the compiler rejects omissions, repeats, invented records, arbitrary payloads, and incompatible presentations', () => {
  const { modules, letter, plan } = editorialFixture();
  const compile = (input: unknown) => composeEditorialDocument(letter, modules, input);
  expect(() => compile({ ...plan, regions: plan.regions.slice(1) })).toThrow('omits');
  expect(() =>
    compile({ ...plan, regions: [...plan.regions, { ...plan.regions[0], id: 'duplicate' }] }),
  ).toThrow('repeats');
  for (const tree of [
    { kind: 'module', id: 'invented' },
    { kind: 'module', id: 'lede', payload: { url: 'https://example.test' } },
    { kind: 'module', id: 'lede', presentation: 'checklist' },
  ])
    expect(() =>
      compile({ ...plan, regions: [{ ...plan.regions[0], tree }, ...plan.regions.slice(1)] }),
    ).toThrow();
});

test('materialized depth is checked before compatibility repair could replace source content', () => {
  const { modules, letter, plan } = editorialFixture();
  const lead = plan.regions[0];
  const tree = {
    kind: 'stack',
    children: [{ kind: 'stack', children: [{ kind: 'stack', children: [lead.tree] }] }],
  };
  expect(() =>
    composeEditorialDocument(letter, modules, {
      ...plan,
      regions: [{ ...lead, tree }, ...plan.regions.slice(1)],
    }),
  ).toThrow();
});

test('stored composition survives migration and live updates; new mail appears once and resolved actions disappear', () => {
  const { edition } = editorialFixture();
  const saved = JSON.stringify(edition);
  const read = migrateDailyReport(edition, NOW);
  expect(read.editorial).toEqual(edition.editorial);
  const live = projectBriefMail(
    read,
    [
      thread({ jev: assessment({ sourceRevision: 'updated-request' }) }),
      thread({
        _id: 'new-request',
        subject: 'New request',
        lastDate: NOW + 1000,
        jev: assessment({ sourceRevision: 'new' }),
      }),
    ],
    policy,
    NOW + 2000,
  );
  expect(live.document?.regions[1].tree.kind).toBe('split');
  expect(live.editorial?.plan).toEqual(edition.editorial?.plan);
  expect(JSON.stringify(live.document)).toContain('support still needs an owner');
  expect(collectBriefRefs(live.document!).filter((ref) => ref.id === 'new-request')).toHaveLength(1);
  const resolved = projectBriefMail(
    live,
    [thread({ jev: assessment({ sourceRevision: 'resolved', obligations: [] }) })],
    policy,
    NOW + 3000,
  );
  expect(collectBriefRefs(resolved.document!).some((ref) => ref.id === 'thread-a')).toBe(false);
  expect(collectBriefRefs(resolved.document!).some((ref) => ref.id === 'review')).toBe(true);
  expect(JSON.stringify(edition)).toBe(saved);
  expect(
    projectBriefMail(
      edition,
      [thread({ jev: assessment({ sourceRevision: 'resolved', obligations: [] }) })],
      policy,
      NOW + 2 * 86_400_000,
    ),
  ).toBe(edition);
});

test('invalid stored plans are ignored without breaking older editions', () => {
  const { edition } = editorialFixture();
  expect(
    migrateDailyReport({ ...edition, editorial: { plan: { version: 99 } } }, NOW).editorial,
  ).toBeUndefined();
  expect(migrateDailyReport(report(), NOW).editorial).toBeUndefined();
});

test('live refresh repairs a malformed stored layout while preserving source actions', () => {
  const { edition } = editorialFixture();
  edition.editorial!.plan.regions = [];
  const refreshed = projectBriefMail(
    edition,
    [thread({ jev: assessment({ sourceRevision: 'changed' }) })],
    policy,
    NOW + 1000,
  );
  expect(refreshed.editorial?.mode).toBe('fallback');
  expect(refreshed.editorial?.plan.regions.length).toBeGreaterThan(0);
  expect(lintBriefDocument(refreshed.document!)).toEqual([]);
  expect(collectBriefRefs(refreshed.document!).some((ref) => ref.id === 'thread-a')).toBe(true);
  expect(JSON.stringify(refreshed.document)).toContain('"action":"draft_reply"');
});

test('live refresh still returns the source letter if both layout attempts fail', () => {
  const { edition } = editorialFixture();
  const compile = spyOn(editorial, 'composeEditorialDocument').mockImplementation(() => {
    throw new Error('Editorial layout exceeds document limits');
  });
  try {
    const refreshed = projectBriefMail(
      edition,
      [thread({ jev: assessment({ sourceRevision: 'changed' }) })],
      policy,
      NOW + 1000,
    );
    expect(compile).toHaveBeenCalledTimes(2);
    expect(refreshed.document?.layout).not.toBe('editorial');
    expect(refreshed.editorial).toBeUndefined();
    expect(collectBriefRefs(refreshed.document!).some((ref) => ref.id === 'thread-a')).toBe(true);
    expect(JSON.stringify(refreshed.document)).toContain('"action":"draft_reply"');
  } finally {
    compile.mockRestore();
  }
});

test('all-day calendar events do not acquire a midnight appointment in the timeline', () => {
  const { edition } = editorialFixture();
  edition.sections.calendar![0].allDay = true;
  const letter = composeBudgetBriefDocument({
    report: edition,
    prose: { ...edition.prose!, lines: {} },
    timezone: 'America/New_York',
  });
  const timeline = editorialModules(edition, letter).find((module) => module.id === 'calendar')!.presentations
    .timeline;
  expect(timeline?.kind).toBe('timeline');
  if (timeline?.kind === 'timeline') {
    expect(timeline.items[0].at).toBeUndefined();
    expect(timeline.items[0].detail).toBe('All day');
  }
});

test('the writer receives the actual module catalogue and can design a different page', async () => {
  const { edition, letter, modules } = editorialFixture();
  const plan = defaultEditorialPlan(modules);
  plan.regions.reverse();
  const result = await writeDailyEditorial(edition, letter, {
    generate: (async (options: any) => {
      expect(options.feature).toBe('daily_brief_layout');
      expect(options.system).toContain('newer direct evidence outranks');
      expect(options.system).toContain(
        'never also offer it as an outstanding priority or interactive choice',
      );
      expect(options.system).toContain('current status is unverified');
      expect(options.abortSignal).toBeUndefined();
      const stops = Array.isArray(options.stopWhen) ? options.stopWhen : [options.stopWhen];
      for (const stop of stops) expect(await stop({ steps: Array(100).fill({}) })).toBe(false);
      for (let i = 0; i < 60; i++) {
        const result = await options.tools.read_sources.execute(
          { ids: [modules[0].id] },
          { toolCallId: String(i), messages: [] },
        );
        expect(result.ok).toBe(true);
      }
      expect(options.prompt).toContain('Maya');
      expect(options.prompt).toContain('"timeline"');
      expect(options.prompt).toContain('"checklist"');
      return { output: plan };
    }) as any,
  });
  expect(result.editorial.mode).toBe('generated');
  expect(result.document.regions[0].id).toBe(`editorial-${plan.regions[0].id}`);
});

test('bad JSON, unsupported layout, provider failure, and missing AI all leave a complete usable brief', async () => {
  const { edition, letter } = editorialFixture();
  const replies = [
    async () => ({ text: 'not JSON' }),
    async () => ({ output: { version: 1, regions: [] } }),
    async () => {
      throw new Error('Provider unavailable');
    },
    null,
  ];
  for (const generate of replies) {
    const result = await writeDailyEditorial(edition, letter, { generate: generate as any });
    expect(result.editorial.mode).toBe('fallback');
    expect(result.failed).toBe(generate !== null);
    expect(collectBriefRefs(result.document)).toEqual(collectBriefRefs(letter));
    expect(lintBriefDocument(result.document)).toEqual([]);
  }
});

test('the active daily pipeline calls prose then design and persists the design with final source prose', async () => {
  const { edition, modules } = editorialFixture();
  edition.sections.mcp = [{ server: 'github', kind: 'pull_request', title: 'Cedar PR #42', state: 'merged' }];
  const calls: string[] = [];
  const composed = await withToolContext(() =>
    composeDailyBrief(edition, null, {
      loadMessages: async () => [],
      loadWeather: async () => null,
      generate: (async (options: any) => {
        calls.push(options.feature);
        if (options.feature === 'daily_brief_prose') {
          expect(options.prompt).toContain('"state": "merged"');
          return {
            text: JSON.stringify({
              lede: 'Read the budget before the review.',
              yesterday: 'The release checklist is complete.',
              items: [{ key: 'account-a:thread-a', line: 'Maya needs your decision.' }],
              weekAhead: 'Prepare for Thursday.',
            }),
          };
        }
        expect(JSON.parse(options.prompt).connectedEvidence).toEqual(edition.sections.mcp);
        // This run has no area pulse loader, so only select the supplied IDs.
        const ids = new Set(JSON.parse(options.prompt).modules.map((module: any) => module.id));
        return { output: defaultEditorialPlan(modules.filter((module) => ids.has(module.id))) };
      }) as any,
    }),
  );
  expect(calls).toEqual(['daily_brief_prose', 'daily_brief_layout']);
  expect(composed.editorial?.mode).toBe('generated');
  const finalized = finalizeBudgetReport(edition, composed);
  expect(finalized.artifactSource).toBe('document-v2');
  expect(finalized.editorial).toEqual(composed.editorial);
  expect(finalized.sections.answer?.[0].line).toBe('Maya needs your decision.');
  expect(finalized.html).toBeTruthy();
});

test('saved area context respects the plan schema even when user content is oversized', async () => {
  const { edition } = editorialFixture();
  edition.sections.albatross = {
    includedAreas: [{ areaId: 'area-a', name: 'A'.repeat(600), reason: 'x'.repeat(5000) }],
    askBeforeCentering: [],
    activeIntents: [],
    activeProjects: [],
    contextReview: [],
    completions: [],
  };
  const composed = await withToolContext(() =>
    composeDailyBrief(edition, null, {
      generate: null,
      loadMessages: async () => [],
      loadWeather: async () => null,
    }),
  );
  const restored = migrateDailyReport(finalizeBudgetReport(edition, composed), NOW);
  expect(restored.editorial).toBeDefined();
  expect(restored.editorial?.plan.areas).toEqual([
    { areaId: 'area-a', name: 'A'.repeat(500), line: 'x'.repeat(4000) },
  ]);
});

test('text-only provider responses work, including providers that throw when output is read', async () => {
  const { edition, letter, plan } = editorialFixture();
  const result = await writeDailyEditorial(edition, letter, {
    generate: (async () => ({
      get output() {
        throw new Error('No structured output');
      },
      text: `\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``,
    })) as any,
  });
  expect(result.editorial.mode).toBe('generated');
});

test('the daily pipeline settles a failed design as a usable edition with a recorded nonfatal error', async () => {
  const { edition } = editorialFixture();
  const composed = await withToolContext(() =>
    composeDailyBrief(edition, null, {
      loadMessages: async () => [],
      loadWeather: async () => null,
      generate: (async (options: any) => {
        if (options.feature === 'daily_brief_layout') throw new DOMException('Timeout', 'TimeoutError');
        return {
          text: JSON.stringify({
            lede: 'Read the budget before the review.',
            items: [],
            weekAhead: 'Prepare for Thursday.',
          }),
        };
      }) as any,
    }),
  );
  const result = finalizeBudgetReport(edition, composed);
  expect(result.artifactStatus).toBe('ready');
  expect(result.editorial?.mode).toBe('fallback');
  expect(result.artifactErrors?.at(-1)?.stage).toBe('document_v2');
  expect(collectBriefRefs(result.document!).some((ref) => ref.id === 'thread-a')).toBe(true);
});

test('a writer with no credits or plan reports a terminal error; an outage does not', async () => {
  const { edition, letter } = editorialFixture();
  const credit = await writeDailyEditorial(edition, letter, {
    generate: (async () => {
      throw Object.assign(new Error('Insufficient credits'), { statusCode: 402 });
    }) as any,
  });
  expect(credit.editorial.mode).toBe('fallback');
  expect(credit.terminalError?.message).toBe('Insufficient credits');
  const outage = await writeDailyEditorial(edition, letter, {
    generate: (async () => {
      throw Object.assign(new Error('Bad gateway'), { statusCode: 502 });
    }) as any,
  });
  expect(outage.editorial.mode).toBe('fallback');
  expect(outage.terminalError).toBeUndefined();
});

test('the daily pipeline carries a terminal writer error to the job, not into the edition', async () => {
  const { edition } = editorialFixture();
  const composed = await withToolContext(() =>
    composeDailyBrief(edition, null, {
      loadMessages: async () => [],
      loadWeather: async () => null,
      generate: (async () => {
        throw Object.assign(new Error('Payment required'), { statusCode: 402 });
      }) as any,
    }),
  );
  expect(composed.editorial?.mode).toBe('fallback');
  expect(composed.writerTerminalError?.message).toBe('Payment required');
  expect(JSON.stringify(finalizeBudgetReport(edition, composed))).not.toContain('Payment required');
});

test('saved dismissals hide items from the latest edition on every read, also after 24 hours', () => {
  const { edition } = editorialFixture();
  const read = migrateDailyReport(edition, NOW);
  const refsOf = (value: typeof read) => collectBriefRefs(value.document!).map((ref) => ref.id);
  expect(refsOf(read)).toContain('thread-a');
  expect(refsOf(read)).toContain('check');
  for (const at of [NOW + 1000, NOW + 3 * 86_400_000]) {
    const hidden = projectBriefMail(read, [], policy, at, {
      threads: new Set(['account-a:thread-a']),
      tasks: new Set(['check']),
    });
    expect(refsOf(hidden)).not.toContain('thread-a');
    expect(refsOf(hidden)).not.toContain('check');
    expect(hidden.sections.answer?.some((item) => item.threadId === 'thread-a')).toBe(false);
    expect(hidden.sections.tasks).toEqual([]);
  }
  // Nothing hidden and an old edition: the stored snapshot comes back as is.
  expect(projectBriefMail(read, [], policy, NOW + 3 * 86_400_000, { threads: new Set() })).toBe(read);
  expect(JSON.stringify(migrateDailyReport(edition, NOW))).toBe(JSON.stringify(read));
});

test('a mail update keeps the written lede and changes only the item lines', () => {
  const { edition } = editorialFixture();
  const read = migrateDailyReport(edition, NOW);
  const live = projectBriefMail(
    read,
    [thread({ jev: assessment({ sourceRevision: 'updated-request' }) })],
    policy,
    NOW + 2000,
  );
  expect(live).not.toBe(read);
  expect(live.prose?.lede).toBe(edition.prose!.lede);
  expect(live.prose?.model).toBe('fixture');
  expect(JSON.stringify(live.document)).not.toContain('refreshed from the latest mail');
});
