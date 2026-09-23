import { expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { briefComponentRenderers } from '../components/report/brief-canvas/BriefToolUi';
import { generateTextForCurrentUser } from '../lib/ai/gateway';
import {
  briefComponentNames,
  describeBriefComponent,
  parseBriefComponent,
  parseBriefComponentAnswer,
} from '../lib/brief/component-catalog';
import {
  bindEditorialSourceVersions,
  composeEditorialDocument,
  defaultEditorialPlan,
} from '../lib/brief/editorial';
import { briefRefKey, collectBriefRefs, hydratedEntityKey } from '../lib/brief/hydration';
import { projectBriefMail } from '../lib/jev/report';
import { createDailyEditorialSession, writeDailyEditorial } from '../lib/mail/brief-editorial';
import { BriefNodeSchema, parseBriefDocument } from '../lib/shared/brief-document';
import { briefComponentFixtures } from './fixtures/brief-components';
import { editorialFixture } from './fixtures/editorial';
import { assessment, NOW, policy, thread } from './fixtures/jev';

const toolOptions = { toolCallId: 'test', messages: [] };

test('editorial data labels remain valid while executable and data URLs are refused', () => {
  expect(
    parseBriefComponent('editorial-text', {
      id: 'analysis',
      title: 'Data: revenue rose 4%',
      text: 'Data: the change is supported.',
    }),
  ).toMatchObject({ title: 'Data: revenue rose 4%' });
  for (const text of [
    'javascript:alert(1)',
    'vbscript:run()',
    'data:text/html,<script>',
    'data:,payload',
    'data:;base64,cGF5bG9hZA==',
    'data:te\nxt/html,<script>',
  ]) {
    expect(() => parseBriefComponent('editorial-text', { id: 'unsafe', text })).toThrow(
      'Unsafe component URL',
    );
  }
});

test('gateway retries and provider failover each start a fresh editorial session', async () => {
  const { edition, letter, plan } = editorialFixture();
  const runtime = {
    userId: null,
    source: 'lab86' as const,
    provider: 'openai' as const,
    modelName: 'primary',
    model: {} as any,
  };
  let attempts = 0;
  const sessions: unknown[] = [];
  const result = await writeDailyEditorial(edition, letter, {
    generate: (options) =>
      generateTextForCurrentUser(options, {
        resolveAiRuntime: async () => runtime,
        fallbackRuntimes: () => [{ ...runtime, modelName: 'fallback' }],
        recordUsage: async () => {},
        generateText: (async (request: any) => {
          attempts += 1;
          expect(request.toolsForAttempt).toBeUndefined();
          expect(sessions).not.toContain(request.tools);
          sessions.push(request.tools);
          expect(request.stopWhen()).toBe(false);
          expect(
            (await request.tools.finalize_brief.execute({ title: 'Empty', summary: 'Empty' }, toolOptions))
              .ok,
          ).toBe(false);
          const regions = structuredClone(plan.regions);
          regions[0].id = `attempt-${attempts}`;
          expect((await request.tools.place_regions.execute({ regions }, toolOptions)).ok).toBe(true);
          expect(
            (
              await request.tools.finalize_brief.execute(
                { title: `Attempt ${attempts}`, summary: 'Complete', regionOrder: regions.map((r) => r.id) },
                toolOptions,
              )
            ).ok,
          ).toBe(true);
          if (attempts === 1) throw new Error('Invalid JSON response');
          if (attempts === 2) throw Object.assign(new Error('Provider unavailable'), { statusCode: 503 });
          return { text: '', usage: {} };
        }) as any,
      }),
  });
  expect(attempts).toBe(3);
  expect(result.failed).toBe(false);
  expect(result.document.title).toBe('Attempt 3');
  expect(result.document.regions[0].id).toBe('editorial-attempt-3');
  expect(JSON.stringify(result.document)).not.toContain('attempt-1');
  expect(JSON.stringify(result.document)).not.toContain('attempt-2');
});

test('authored source replacements retain account-scoped hydration refs and reject invalid stored props', () => {
  const { letter, modules, plan } = editorialFixture();
  plan.regions[1].tree = {
    kind: 'component',
    id: 'decision-story',
    component: 'editorial-text',
    props: briefComponentFixtures['editorial-text'],
    sources: ['thread:account-a:thread-a', 'calendar'],
    summary: 'The decision before the launch review',
  };
  const document = composeEditorialDocument(letter, modules, plan);
  expect(collectBriefRefs(document)).toEqual(collectBriefRefs(letter));
  const ref = collectBriefRefs(document).find((item) => item.id === 'thread-a')!;
  expect(hydratedEntityKey({ ...ref, kind: 'thread' })).toBe(briefRefKey(ref));
  expect(hydratedEntityKey({ kind: 'thread', id: ref.id, account: 'other' })).not.toBe(briefRefKey(ref));
  const stored = document.regions[1].tree;
  const invalid = BriefNodeSchema.safeParse({ ...stored, component: 'option-list', props: { options: [] } });
  expect(invalid.success).toBe(false);
  if (!invalid.success) expect(invalid.error.issues.some((issue) => issue.path.includes('props'))).toBe(true);
});

test('every Tool UI family is discoverable, validates against its real schema, compiles, survives storage and has a renderer', () => {
  const families = readdirSync(new URL('../components/tool-ui', import.meta.url), { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'shared')
    .map((d) => d.name)
    .sort();
  expect(briefComponentNames.filter((n) => n !== 'editorial-text').sort()).toEqual(families);
  expect(Object.keys(briefComponentRenderers).sort()).toEqual([...briefComponentNames].sort());
  const { letter, modules, plan } = editorialFixture();
  for (const name of briefComponentNames) {
    const description = describeBriefComponent(name);
    expect(description.schema).toBeDefined();
    const props = parseBriefComponent(name, { id: `test-${name}`, ...briefComponentFixtures[name] });
    const candidate = structuredClone(plan);
    candidate.regions[0].tree = {
      kind: 'component',
      id: `test-${name}`,
      component: name,
      props,
      sources: ['lede'],
      summary: 'Source-backed example',
    };
    const document = composeEditorialDocument(letter, modules, candidate);
    const restored = parseBriefDocument(JSON.parse(JSON.stringify(document)));
    expect(restored.regions[0].tree.kind).toBe('tool_ui');
    expect(collectBriefRefs(restored)).toEqual(collectBriefRefs(letter));
  }
});

test('component contracts reject executable props, forged receipts, unsafe URLs and invalid answers', () => {
  for (const extra of [
    { onClick: 'do something' },
    { className: 'fixed' },
    { receipt: { outcome: 'success', summary: 'Done', at: new Date().toISOString() } },
  ]) {
    expect(() =>
      parseBriefComponent('link-preview', { id: 'link', href: 'https://example.com', ...extra }),
    ).toThrow();
  }
  expect(() => parseBriefComponent('link-preview', { id: 'link', href: 'javascript:alert(1)' })).toThrow();
  expect(() =>
    parseBriefComponent('message-draft', {
      id: 'draft',
      ...briefComponentFixtures['message-draft'],
      outcome: 'sent',
    }),
  ).toThrow();
  const answer = (name: keyof typeof briefComponentFixtures, value: unknown) =>
    parseBriefComponentAnswer(name, { id: 'input', ...briefComponentFixtures[name] }, value);
  expect(answer('option-list', ['review'])).toEqual(['review']);
  expect(() => answer('option-list', ['invented'])).toThrow();
  expect(() => answer('option-list', ['review', 'clarify'])).toThrow();
  expect(answer('parameter-slider', { minutes: 45 })).toEqual({ minutes: 45 });
  for (const values of [{ minutes: 61 }, { minutes: 22 }, { minutes: 30, hidden: 1 }])
    expect(() => answer('parameter-slider', values)).toThrow();
  expect(answer('preferences-panel', { costs: true, depth: 'full' })).toEqual({ costs: true, depth: 'full' });
  expect(() => answer('preferences-panel', { costs: 'true', depth: 'full' })).toThrow();
  expect(() => answer('question-flow', { priority: ['invented'], detail: ['setup'] })).toThrow();
  expect(answer('question-flow', { priority: ['cost'], detail: ['setup', 'support'] })).toBeDefined();
  expect(() => answer('chart', { cost: 10 })).toThrow();
});

test('daily editor can discover, read, repair, compose and finalize custom functional components through its real tools', async () => {
  const { edition, letter, plan } = editorialFixture();
  const result = await writeDailyEditorial(edition, letter, {
    evidence: { lede: { original: 'Full original source beyond the short summary' } },
    generate: (async (options: any) => {
      const tools = options.tools;
      const described = await tools.describe_components.execute(
        { names: ['editorial-text', 'option-list'] },
        toolOptions,
      );
      expect(described.components.map((c: any) => c.name)).toEqual(['editorial-text', 'option-list']);
      const source = await tools.read_sources.execute({ ids: ['lede'] }, toolOptions);
      expect(source.sources[0].evidence.original).toContain('Full original');
      expect((await tools.read_sources.execute({ ids: ['other-users-thread'] }, toolOptions)).ok).toBe(false);
      const initial = await tools.finalize_brief.execute(
        { title: 'Today', summary: 'Not complete' },
        toolOptions,
      );
      expect(initial.ok).toBe(false);
      const custom = structuredClone(plan);
      custom.regions[0].tree = {
        kind: 'component',
        id: 'lead-story',
        component: 'editorial-text',
        props: briefComponentFixtures['editorial-text'],
        summary: 'Review the support decision',
        sources: ['lede'],
      };
      const extra = {
        id: 'decision',
        summary: 'Prepare the review',
        tree: {
          kind: 'component',
          id: 'review-choice',
          component: 'option-list',
          props: briefComponentFixtures['option-list'],
          summary: 'Choose how to prepare the support review',
          sources: ['lede'],
        },
      };
      expect(
        (await tools.place_regions.execute({ regions: [...custom.regions, extra] }, toolOptions)).ok,
      ).toBe(true);
      const bad = { ...extra, tree: { ...extra.tree, props: { options: [] } } };
      expect((await tools.place_regions.execute({ regions: [bad] }, toolOptions)).ok).toBe(false);
      expect((await tools.inspect_brief.execute({}, toolOptions)).ok).toBe(true);
      expect(
        (
          await tools.finalize_brief.execute(
            {
              title: 'The support decision',
              summary: 'Two proposals and one unresolved owner',
              regionOrder: [...custom.regions, extra].map((region) => region.id),
            },
            toolOptions,
          )
        ).ok,
      ).toBe(true);
      return { text: '' };
    }) as any,
  });
  expect(result.failed).toBe(false);
  expect(result.document.title).toBe('The support decision');
  expect(result.editorial.plan.title).toBe('The support decision');
  expect(JSON.stringify(result.document)).toContain('review-choice');
  expect(JSON.stringify(result.document)).toContain('The lower quote saves $60');
});

test('components preserve actual source actions and disappear safely when their evidence is removed', () => {
  const { edition, letter, plan, modules } = editorialFixture();
  const source = modules.find((m) => m.id.startsWith('thread:'))!;
  const candidate = {
    version: 1 as const,
    regions: [
      {
        id: 'story',
        summary: 'Analysis',
        tree: {
          kind: 'component' as const,
          id: 'story',
          component: 'editorial-text' as const,
          props: briefComponentFixtures['editorial-text'],
          sources: [source.id],
          summary: 'Analysis',
        },
      },
    ],
  };
  const document = composeEditorialDocument(letter, modules, candidate, false);
  expect(JSON.stringify(document.regions[0])).toContain('draft_reply');
  const changed = composeEditorialDocument(
    letter,
    modules.filter((m) => m.id !== source.id),
    candidate,
    false,
  );
  expect(JSON.stringify(changed)).not.toContain('The lower quote saves $60');
  expect(() =>
    composeEditorialDocument(letter, modules, {
      ...candidate,
      regions: [{ ...candidate.regions[0], tree: { ...candidate.regions[0].tree, sources: ['narrative'] } }],
    }),
  ).toThrow('private');
  const session = createDailyEditorialSession(edition, letter);
  expect(session.result()).toBeNull();
  expect(plan.version).toBe(1);
});

test('changed evidence invalidates derived prose, while unrelated source refreshes preserve authored area context', () => {
  const { edition, letter, modules } = editorialFixture();
  const mail = modules.find((m) => m.id.startsWith('thread:'))!;
  const authored = {
    version: 1 as const,
    regions: [
      {
        id: 'story',
        summary: 'Analysis',
        tree: {
          kind: 'component' as const,
          id: 'story',
          component: 'editorial-text' as const,
          props: briefComponentFixtures['editorial-text'],
          sources: [mail.id],
          summary: 'Analysis',
        },
      },
    ],
  };
  const bound = bindEditorialSourceVersions(authored, modules);
  const changed = composeEditorialDocument(
    letter,
    modules.map((m) => (m.id === mail.id ? { ...m, revision: 'changed-evidence' } : m)),
    bound,
    false,
  );
  expect(JSON.stringify(changed)).not.toContain('The lower quote saves $60');
  expect(collectBriefRefs(changed).some((ref) => ref.id === 'thread-a')).toBe(true);
  const area = modules.find((m) => m.id.startsWith('area:'))!;
  const page = {
    version: 1 as const,
    areas: [{ areaId: 'launch', name: 'Launch', line: 'Support still needs an owner.' }],
    regions: [
      {
        id: 'area-story',
        summary: 'Area context',
        tree: { ...authored.regions[0].tree, sources: ['lede', area.id] },
      },
      ...defaultEditorialPlan(modules.filter((m) => !['lede', area.id].includes(m.id))).regions,
    ],
  };
  edition.editorial = { mode: 'generated', plan: page };
  edition.document = composeEditorialDocument(letter, modules, page);
  const refreshed = projectBriefMail(
    edition,
    [
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
  expect(refreshed.document?.regions.some((region) => region.id === 'editorial-area-story')).toBe(true);
  expect(JSON.stringify(refreshed.document)).toContain('The lower quote saves $60');
});
