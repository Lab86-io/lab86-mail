import { z } from 'zod';
import {
  type BriefDocumentV2,
  BriefDocumentV2Schema,
  type BriefNode,
  lintBriefDocument,
} from '../shared/brief-document';
import type { DailyReport } from '../shared/types';
import { type BriefComponentName, briefComponentNameSchema, parseBriefComponent } from './component-catalog';
import { briefRefKey } from './hydration';

// The writer arranges supplied modules. Only the host materializes records,
// references and action payloads. The same plan can be replayed after a live
// source update without another model call or a second layout implementation.
export type EditorialPresentation = 'story' | 'compact' | 'timeline' | 'checklist';
export type EditorialNode =
  | {
      kind: 'component';
      id: string;
      component: BriefComponentName;
      props: Record<string, unknown>;
      summary: string;
      sources: string[];
      footprint?: 'standard' | 'wide' | 'feature';
      emphasis?: 'primary' | 'standard' | 'muted';
    }
  | {
      kind: 'module';
      id: string;
      presentation?: EditorialPresentation;
      footprint?: 'standard' | 'wide' | 'feature';
      emphasis?: 'primary' | 'standard' | 'muted';
    }
  | { kind: 'stack'; density?: 'airy' | 'standard' | 'dense'; children: EditorialNode[] }
  | { kind: 'grid'; columns: 2 | 3; children: EditorialNode[] }
  | { kind: 'split'; ratio: 'balanced' | 'lead'; children: EditorialNode[] }
  | { kind: 'group'; title: string; collapsible?: boolean; children: EditorialNode[] };

export const editorialNodeSchema: z.ZodType<EditorialNode> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('component'),
        id: z.string().regex(/^[a-z][a-z0-9-]{0,70}$/),
        component: briefComponentNameSchema,
        props: z.record(z.string(), z.unknown()),
        summary: z.string().trim().min(1).max(1000),
        sources: z.array(z.string().min(1).max(1000)).min(1).max(24),
        footprint: z.enum(['standard', 'wide', 'feature']).optional(),
        emphasis: z.enum(['primary', 'standard', 'muted']).optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('module'),
        id: z.string().min(1).max(1000),
        presentation: z.enum(['story', 'compact', 'timeline', 'checklist']).optional(),
        footprint: z.enum(['standard', 'wide', 'feature']).optional(),
        emphasis: z.enum(['primary', 'standard', 'muted']).optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('stack'),
        density: z.enum(['airy', 'standard', 'dense']).optional(),
        children: z.array(editorialNodeSchema).min(1).max(24),
      })
      .strict(),
    z
      .object({
        kind: z.literal('grid'),
        columns: z.union([z.literal(2), z.literal(3)]),
        children: z.array(editorialNodeSchema).min(2).max(12),
      })
      .strict(),
    z
      .object({
        kind: z.literal('split'),
        ratio: z.enum(['balanced', 'lead']),
        children: z.array(editorialNodeSchema).length(2),
      })
      .strict(),
    z
      .object({
        kind: z.literal('group'),
        title: z.string().trim().min(1).max(160),
        collapsible: z.boolean().optional(),
        children: z.array(editorialNodeSchema).min(1).max(12),
      })
      .strict(),
  ]),
);

export const editorialPlanSchema = z
  .object({
    version: z.literal(1),
    title: z.string().trim().min(1).max(160).optional(),
    summary: z.string().trim().min(1).max(1200).optional(),
    sourceVersions: z.record(z.string(), z.string().max(2048)).optional(),
    areas: z
      .array(z.object({ areaId: z.string().max(240), name: z.string().max(500), line: z.string().max(4000) }))
      .max(12)
      .optional(),
    regions: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z][a-z0-9-]{0,70}$/),
            summary: z.string().trim().min(1).max(1000),
            tree: editorialNodeSchema,
          })
          .strict(),
      )
      .min(1)
      .max(12),
  })
  .strict();
export type EditorialPlan = z.infer<typeof editorialPlanSchema>;

export interface EditorialModule {
  id: string;
  section: string;
  title: string;
  summary: string;
  revision?: string;
  presentations: Partial<Record<EditorialPresentation, BriefNode>> & { story: BriefNode };
}

const base = { emphasis: 'standard', tone: 'neutral' } as const;

export function editorialModules(report: DailyReport, letter: BriefDocumentV2): EditorialModule[] {
  const modules: EditorialModule[] = [];
  for (const region of letter.regions) {
    const tree = region.tree;
    if (tree.kind !== 'entity_list') {
      const title =
        region.id === 'yesterday'
          ? 'Since yesterday'
          : region.id === 'week-ahead'
            ? 'The week ahead'
            : undefined;
      const story: BriefNode = title
        ? {
            ...base,
            kind: 'stack',
            density: 'dense',
            children: [{ ...base, kind: 'text', role: 'kicker', text: title }, tree],
          }
        : tree;
      modules.push({
        id: region.id,
        section: region.id,
        title: region.id,
        summary: region.summary,
        presentations: { story },
      });
      continue;
    }
    // Calendar and task modules can take a temporal/completion form without
    // losing the real actions that their source rows already supply.
    const events = tree.items.filter((item) => item.ref.kind === 'event');
    const others = tree.items.filter((item) => item.ref.kind !== 'event');
    if (events.length) {
      const story = { ...tree, title: 'On the calendar', items: events };
      const timeline: BriefNode = {
        ...base,
        kind: 'timeline',
        title: 'On the calendar',
        items: events.map((item) => {
          const event = report.sections.calendar?.find(
            (event) => event.eventId === item.ref.id && event.account === item.ref.account,
          );
          return {
            label: item.ref.label || 'Event',
            detail: item.framing.reason,
            at: event?.allDay ? undefined : event?.startAt,
            ref: item.ref,
            actions: item.actions,
          };
        }),
      };
      modules.push({
        id: 'calendar',
        section: region.id,
        title: 'On the calendar',
        summary: events.map((item) => item.ref.label).join('; '),
        presentations: { story, compact: { ...story, variant: 'compact' }, timeline },
      });
    }
    if (region.id === 'tasks' && others.length) {
      const story = { ...tree, items: others };
      const checklist: BriefNode = {
        ...base,
        kind: 'checklist',
        title: tree.title || 'Tasks this week',
        items: others.map((item) => ({
          label: item.ref.label || 'Task',
          detail: item.framing.reason,
          ref: item.ref,
          checked: false,
          action: item.actions.find((action) => action.action === 'toggle_task'),
        })),
      };
      modules.push({
        id: 'tasks',
        section: region.id,
        title: tree.title || 'Tasks this week',
        summary: region.summary,
        presentations: { story, compact: { ...story, variant: 'compact' }, checklist },
      });
      continue;
    }
    for (const item of others) {
      const story: BriefNode = { ...tree, title: undefined, items: [item] };
      const source =
        item.ref.kind === 'thread'
          ? [
              ...(report.sections.answer ?? []),
              ...(report.sections.today ?? []),
              ...(report.sections.know ?? []),
              ...(report.sections.waiting ?? []),
            ].find((source) => source.account === item.ref.account && source.threadId === item.ref.id)
          : undefined;
      modules.push({
        id: briefRefKey(item.ref),
        section: region.id,
        title: item.ref.label || tree.title || region.id,
        summary: item.framing.reason || region.summary,
        revision: source
          ? JSON.stringify([source.jev?.sourceRevision ?? null, source.receivedAt ?? null])
          : undefined,
        presentations: { story, compact: { ...story, variant: 'compact' } },
      });
    }
  }
  // These are permission-checked live modules, never cached copies of private
  // narrative memory or editable preparations inside an immutable edition.
  for (const section of ['narrative', 'prepared_work'] as const) {
    const title = section === 'narrative' ? 'Personal context' : 'Prepared for you';
    modules.push({
      id: section,
      section,
      title,
      summary: title,
      presentations: {
        story: { ...base, kind: 'live_section', section, at: report.generatedAt },
      },
    });
  }
  return modules.filter((module, index) => modules.findIndex((entry) => entry.id === module.id) === index);
}

export function defaultEditorialPlan(modules: EditorialModule[]): EditorialPlan {
  const sections = new Map<string, EditorialModule[]>();
  for (const module of modules) {
    const group = sections.get(module.section) || [];
    group.push(module);
    sections.set(module.section, group);
  }
  return {
    version: 1,
    regions: [...sections].map(([section, entries]) => ({
      id: section.replaceAll('_', '-'),
      summary: entries
        .map((entry) => entry.summary)
        .join(' ')
        .slice(0, 1000),
      tree:
        entries.length === 1 && entries[0].presentations.story.kind === 'live_section'
          ? { kind: 'module', id: entries[0].id, footprint: 'feature' }
          : {
              kind: 'stack',
              density: 'standard',
              children: entries.map((entry) => ({
                kind: 'module',
                id: entry.id,
                presentation: entry.presentations.timeline
                  ? 'timeline'
                  : entry.presentations.checklist
                    ? 'checklist'
                    : 'story',
                footprint: section === 'lede' || section === 'prepared_work' ? 'feature' : 'standard',
              })),
            },
    })),
  };
}

/** The host records the evidence version after authoring, never from model claims. */
export function bindEditorialSourceVersions(plan: EditorialPlan, modules: EditorialModule[]): EditorialPlan {
  return {
    ...plan,
    sourceVersions: Object.fromEntries(
      modules.filter((m) => m.revision !== undefined).map((m) => [m.id, m.revision!]),
    ),
  };
}

/** Strict on generation, tolerant of removed sources on subsequent live reads. */
export function composeEditorialDocument(
  letter: BriefDocumentV2,
  modules: EditorialModule[],
  input: unknown,
  strict = true,
  requireAll = true,
): BriefDocumentV2 {
  const plan = editorialPlanSchema.parse(input);
  const known = new Map(modules.map((module) => [module.id, module]));
  const used = new Set<string>();
  const regionIds = new Set<string>();
  const componentIds = new Set<string>();
  const actionSources = new Set<string>();
  let nodeCount = 0;
  const visit = (node: EditorialNode, depth: number): BriefNode | null => {
    if (++nodeCount > 96 || depth > 3) throw new Error('Editorial layout is too complex');
    if (node.kind === 'component') {
      if (componentIds.has(node.id)) throw new Error('Editorial layout repeats a component id');
      componentIds.add(node.id);
      const selected = node.sources.map((id) => known.get(id));
      if (selected.some((module) => !module)) {
        if (strict) throw new Error('Editorial component refers to an unknown source');
        // A changed source invalidates its authored interpretation. Retain the
        // page structure, then append the remaining live sources below.
        return null;
      }
      if (
        !strict &&
        selected.some(
          (module) =>
            module &&
            plan.sourceVersions?.[module.id] !== undefined &&
            plan.sourceVersions[module.id] !== module.revision,
        )
      )
        return null;
      const sources: Extract<BriefNode, { kind: 'tool_ui' }>['sources'] = [];
      for (const module of selected) {
        if (!module) continue;
        if (module.presentations.story.kind === 'live_section')
          throw new Error('Live private sections must be placed as modules');
        used.add(module.id);
        const collect = (part: BriefNode) => {
          if (part.kind === 'entity_list')
            for (const item of part.items) {
              const key = briefRefKey(item.ref);
              if (!sources.some((s) => briefRefKey(s.ref) === key)) {
                sources.push({
                  ref: item.ref,
                  actions: actionSources.has(key)
                    ? item.actions.filter((action) => action.action.startsWith('open_'))
                    : item.actions,
                });
                actionSources.add(key);
              }
            }
          if ('children' in part) part.children.forEach(collect);
        };
        collect(module.presentations.story);
      }
      return {
        ...base,
        kind: 'tool_ui',
        id: node.id,
        component: node.component,
        props: parseBriefComponent(node.component, { ...node.props, id: node.id }),
        summary: node.summary,
        sources,
        footprint:
          node.footprint ??
          (node.component === 'editorial-text' && node.props.role === 'lede' ? 'feature' : undefined),
        emphasis: node.emphasis || 'standard',
      };
    }
    if (node.kind === 'module') {
      const module = known.get(node.id);
      if (!module) {
        if (strict) throw new Error('Editorial layout refers to an unknown module');
        return null;
      }
      if (used.has(node.id)) throw new Error('Editorial layout repeats a module');
      used.add(node.id);
      const presentation = module.presentations[node.presentation || 'story'];
      if (!presentation) throw new Error('Editorial layout requests an unavailable presentation');
      return {
        ...presentation,
        ...(node.footprint ? { footprint: node.footprint } : {}),
        ...(node.emphasis ? { emphasis: node.emphasis } : {}),
      };
    }
    const children = node.children
      .map((child) => visit(child, depth + 1))
      .filter((child): child is BriefNode => !!child);
    if (!children.length) return null;
    if (node.kind === 'split' && children.length === 2)
      return { ...base, ...node, footprint: 'feature', children: [children[0], children[1]] };
    if (node.kind === 'group')
      return {
        ...base,
        ...node,
        footprint: 'feature',
        collapsible: node.collapsible ?? false,
        surface: 'plain',
        children,
      };
    if (
      node.kind === 'grid' &&
      children.length > 1 &&
      new Set(children.map((child) => child.kind)).size === 1
    )
      return { ...base, ...node, footprint: 'feature', children };
    return {
      ...base,
      kind: 'stack',
      footprint: 'feature',
      density: node.kind === 'stack' ? node.density || 'standard' : 'standard',
      children,
    };
  };
  const regions = plan.regions.flatMap((region) => {
    if (regionIds.has(region.id)) throw new Error('Editorial layout repeats a region');
    regionIds.add(region.id);
    nodeCount = 0;
    const tree = visit(region.tree, 1);
    return tree ? [{ ...region, id: `editorial-${region.id}`, tree }] : [];
  });
  const missing = modules.filter((module) => !used.has(module.id));
  if (missing.length && strict && requireAll)
    throw new Error(`Editorial layout omits supplied content: ${missing.map((m) => m.id).join(', ')}`);
  if (missing.length && !strict) {
    // New mail arrives between editions. It remains visible without asking a
    // model to rewrite the saved page on every refresh.
    const additions = missing.map((module) => module.presentations.story);
    const last = regions.at(-1);
    if (regions.length >= 12 && last) {
      last.tree = { ...base, kind: 'stack', density: 'standard', children: [last.tree, ...additions] };
    } else
      regions.push({
        id: 'live-updates',
        summary: 'Updates since this edition was composed.',
        tree: { ...base, kind: 'stack', footprint: 'feature', density: 'standard', children: additions },
      });
  }
  // Reject an over-deep or oversized composition before the compatibility
  // parser could repair it by replacing content with a summary.
  const document = BriefDocumentV2Schema.parse({
    ...letter,
    ...(plan.title ? { title: plan.title } : {}),
    ...(plan.summary ? { summary: plan.summary } : {}),
    layout: 'editorial',
    regions,
  });
  if (lintBriefDocument(document).length) throw new Error('Editorial layout exceeds document limits');
  return document;
}

export function hasLiveBriefSection(document: BriefDocumentV2, section: 'narrative' | 'prepared_work') {
  const visit = (node: BriefNode): boolean =>
    node.kind === 'live_section' ? node.section === section : 'children' in node && node.children.some(visit);
  return document.regions.some((region) => visit(region.tree));
}
