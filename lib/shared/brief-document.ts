import { z } from 'zod';
import { isKnownBriefAction } from './brief-actions';

export const BRIEF_DOCUMENT_VERSION = 2 as const;

export const BRIEF_DOCUMENT_LIMITS = {
  regions: 12,
  nodesPerRegion: 48,
  depth: 4,
  children: 24,
  actions: 8,
  entityItems: 24,
  queryLimit: 48,
  collectionItems: 24,
  timelineItems: 24,
  checklistItems: 24,
  chartPoints: 48,
  title: 160,
  summary: 1_200,
  regionSummary: 1_000,
  body: 4_000,
  shortText: 500,
  canvasHtml: 20_000,
  canvases: 2,
  heroes: 1,
} as const;

export const BRIEF_QUERY_NAMES = [
  'tasks_due_today',
  'tasks_overdue',
  'events_today',
  'events_next_7d',
  'unresolved_tracked_threads',
  'area_open_work',
] as const;

export type BriefQueryName = (typeof BRIEF_QUERY_NAMES)[number];

const emphasisSchema = z.enum(['primary', 'standard', 'muted']).default('standard');
const toneSchema = z.enum(['neutral', 'positive', 'warning', 'urgent']).default('neutral');
const surfaceSchema = z.enum(['plain', 'elevated', 'glass']).default('plain');
const entityVariantSchema = z.enum(['rows', 'cards', 'compact']).default('rows');

export const BriefSourceRefV2Schema = z.object({
  kind: z.enum(['thread', 'message', 'task', 'event', 'card', 'mcp', 'account', 'derived', 'area', 'work']),
  id: z.string().trim().min(1).max(240),
  account: z.string().trim().min(1).max(320).optional(),
  label: z.string().trim().min(1).max(BRIEF_DOCUMENT_LIMITS.shortText).optional(),
});

export const BriefActionV2Schema = z.object({
  action: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(80),
  payload: z.record(z.string(), z.unknown()).default({}),
  style: z.enum(['primary', 'secondary', 'danger', 'quiet']).default('secondary'),
});

export type BriefSourceRefV2 = z.infer<typeof BriefSourceRefV2Schema>;
export type BriefActionV2 = z.infer<typeof BriefActionV2Schema>;

export const BriefQuerySchema = z
  .object({
    name: z.enum(BRIEF_QUERY_NAMES),
    areaId: z.string().trim().min(1).max(240).optional(),
  })
  .superRefine((query, ctx) => {
    if (query.name === 'area_open_work' && !query.areaId) {
      ctx.addIssue({ code: 'custom', path: ['areaId'], message: 'area_open_work requires areaId' });
    }
  });

export type BriefQuery = z.infer<typeof BriefQuerySchema>;

const commonNodeShape = {
  id: z.string().trim().min(1).max(120).optional(),
  emphasis: emphasisSchema,
  tone: toneSchema,
};

const framingSchema = z.object({
  reason: z.string().max(BRIEF_DOCUMENT_LIMITS.shortText).optional(),
  lane: z.string().max(120).optional(),
  prep: z.string().max(BRIEF_DOCUMENT_LIMITS.shortText).optional(),
});

const handoffEvidenceSchema = z.object({
  label: z.string().trim().min(1).max(BRIEF_DOCUMENT_LIMITS.shortText),
  ref: BriefSourceRefV2Schema.optional(),
});

const handoffRecommendationSchema = z.object({
  label: z.string().trim().min(1).max(BRIEF_DOCUMENT_LIMITS.shortText),
  ref: BriefSourceRefV2Schema.optional(),
});

export const BriefEntityHandoffV1Schema = z.object({
  handoffId: z.string().trim().min(1).max(240).optional(),
  itemCount: z.number().int().min(1).max(8).default(1),
  situation: z.string().trim().min(1).max(BRIEF_DOCUMENT_LIMITS.shortText),
  background: z.array(z.string().trim().min(1).max(BRIEF_DOCUMENT_LIMITS.shortText)).max(3).default([]),
  assessment: z.string().trim().min(1).max(BRIEF_DOCUMENT_LIMITS.shortText),
  recommendation: z.string().trim().min(1).max(BRIEF_DOCUMENT_LIMITS.shortText),
  recommendations: z.array(handoffRecommendationSchema).max(4).default([]),
  evidence: z.array(handoffEvidenceSchema).max(4).default([]),
});

const entityItemSchema = z.object({
  ref: BriefSourceRefV2Schema,
  framing: framingSchema.default({}),
  handoff: BriefEntityHandoffV1Schema.optional(),
  actions: z.array(BriefActionV2Schema).max(BRIEF_DOCUMENT_LIMITS.actions).default([]),
});

export type BriefEntityHandoffV1 = z.infer<typeof BriefEntityHandoffV1Schema>;

const collectionItemSchema = z.object({
  image: z.url().optional(),
  title: z.string().trim().min(1).max(BRIEF_DOCUMENT_LIMITS.shortText),
  meta: z.string().max(BRIEF_DOCUMENT_LIMITS.shortText).optional(),
  badge: z.string().max(80).optional(),
  ref: BriefSourceRefV2Schema.optional(),
  actions: z.array(BriefActionV2Schema).max(BRIEF_DOCUMENT_LIMITS.actions).default([]),
});

const chartPointSchema = z.object({
  label: z.string().trim().min(1).max(100),
  value: z.number().finite(),
  group: z.string().max(100).optional(),
});

const timelineItemSchema = z.object({
  label: z.string().trim().min(1).max(BRIEF_DOCUMENT_LIMITS.shortText),
  at: z.number().finite().nullable().optional(),
  detail: z.string().max(BRIEF_DOCUMENT_LIMITS.shortText).optional(),
  ref: BriefSourceRefV2Schema.optional(),
  actions: z.array(BriefActionV2Schema).max(BRIEF_DOCUMENT_LIMITS.actions).default([]),
});

const checklistItemSchema = z.object({
  label: z.string().trim().min(1).max(BRIEF_DOCUMENT_LIMITS.shortText),
  detail: z.string().max(BRIEF_DOCUMENT_LIMITS.shortText).optional(),
  checked: z.boolean().default(false),
  ref: BriefSourceRefV2Schema.optional(),
  action: BriefActionV2Schema.optional(),
});

const editorialLeafSchemas = [
  z.object({
    ...commonNodeShape,
    kind: z.literal('text'),
    role: z.enum(['lede', 'kicker', 'body', 'aside', 'caption']).default('body'),
    text: z.string().trim().min(1).max(BRIEF_DOCUMENT_LIMITS.body),
  }),
  z.object({
    ...commonNodeShape,
    kind: z.literal('actions'),
    actions: z.array(BriefActionV2Schema).min(1).max(BRIEF_DOCUMENT_LIMITS.actions),
  }),
  z.object({
    ...commonNodeShape,
    kind: z.literal('prompt'),
    variant: z.enum(['capture', 'question']).default('capture'),
    placeholder: z.string().max(240).default('Add a thought…'),
    questionId: z.string().max(240).optional(),
  }),
  z.object({
    ...commonNodeShape,
    kind: z.literal('divider'),
    variant: z.enum(['line', 'space', 'flourish']).default('line'),
  }),
  z.object({
    ...commonNodeShape,
    kind: z.literal('canvas'),
    canvasId: z.string().trim().min(1).max(120),
    title: z.string().trim().min(1).max(BRIEF_DOCUMENT_LIMITS.title),
    html: z.string().min(1).max(BRIEF_DOCUMENT_LIMITS.canvasHtml),
    fallbackText: z.string().trim().min(1).max(BRIEF_DOCUMENT_LIMITS.body),
    allowedActions: z.array(z.string().max(80)).max(BRIEF_DOCUMENT_LIMITS.actions).default([]),
    height: z.enum(['compact', 'medium', 'tall']).default('medium'),
  }),
] as const;

const dataLeafSchemas = [
  z.object({
    ...commonNodeShape,
    kind: z.literal('entity_list'),
    title: z.string().max(BRIEF_DOCUMENT_LIMITS.title).optional(),
    items: z.array(entityItemSchema).max(BRIEF_DOCUMENT_LIMITS.entityItems),
    variant: entityVariantSchema,
    emptyText: z.string().max(BRIEF_DOCUMENT_LIMITS.shortText).optional(),
  }),
  z.object({
    ...commonNodeShape,
    kind: z.literal('query_list'),
    title: z.string().max(BRIEF_DOCUMENT_LIMITS.title).optional(),
    query: BriefQuerySchema,
    limit: z.number().int().min(1).max(BRIEF_DOCUMENT_LIMITS.queryLimit).default(12),
    variant: entityVariantSchema,
    emptyText: z.string().max(BRIEF_DOCUMENT_LIMITS.shortText).default('Nothing here right now.'),
  }),
  z
    .object({
      ...commonNodeShape,
      kind: z.literal('stat'),
      label: z.string().trim().min(1).max(160),
      value: z.union([z.string().max(120), z.number().finite()]).optional(),
      queryValue: BriefQuerySchema.optional(),
      delta: z.string().max(120).optional(),
      unit: z.string().max(80).optional(),
    })
    .refine((value) => value.value !== undefined || value.queryValue !== undefined, {
      message: 'stat requires value or queryValue',
    }),
  z.object({
    ...commonNodeShape,
    kind: z.literal('chart'),
    variant: z.enum(['bar', 'stacked_bar', 'donut', 'line']).default('bar'),
    title: z.string().trim().min(1).max(BRIEF_DOCUMENT_LIMITS.title),
    description: z.string().max(BRIEF_DOCUMENT_LIMITS.shortText).optional(),
    data: z.array(chartPointSchema).min(1).max(BRIEF_DOCUMENT_LIMITS.chartPoints),
    sourceRefs: z.array(BriefSourceRefV2Schema).min(1).max(BRIEF_DOCUMENT_LIMITS.entityItems),
  }),
  z.object({
    ...commonNodeShape,
    kind: z.literal('timeline'),
    title: z.string().trim().min(1).max(BRIEF_DOCUMENT_LIMITS.title),
    items: z.array(timelineItemSchema).min(1).max(BRIEF_DOCUMENT_LIMITS.timelineItems),
  }),
  z.object({
    ...commonNodeShape,
    kind: z.literal('checklist'),
    title: z.string().trim().min(1).max(BRIEF_DOCUMENT_LIMITS.title),
    items: z.array(checklistItemSchema).min(1).max(BRIEF_DOCUMENT_LIMITS.checklistItems),
  }),
  z.object({
    ...commonNodeShape,
    kind: z.literal('collection'),
    title: z.string().max(BRIEF_DOCUMENT_LIMITS.title).optional(),
    items: z.array(collectionItemSchema).max(BRIEF_DOCUMENT_LIMITS.collectionItems),
    variant: z.enum(['shelf', 'grid', 'list']).default('list'),
    emptyText: z.string().max(BRIEF_DOCUMENT_LIMITS.shortText).optional(),
  }),
] as const;

export const BriefContentLeafSchema = z.discriminatedUnion('kind', [
  ...dataLeafSchemas,
  ...editorialLeafSchemas,
]);

export type BriefContentLeaf = z.infer<typeof BriefContentLeafSchema>;

export type BriefNode =
  | BriefContentLeaf
  | {
      kind: 'stack';
      id?: string;
      emphasis: 'primary' | 'standard' | 'muted';
      tone: 'neutral' | 'positive' | 'warning' | 'urgent';
      density: 'airy' | 'standard' | 'dense';
      children: BriefNode[];
    }
  | {
      kind: 'grid';
      id?: string;
      emphasis: 'primary' | 'standard' | 'muted';
      tone: 'neutral' | 'positive' | 'warning' | 'urgent';
      columns: 2 | 3;
      children: BriefNode[];
    }
  | {
      kind: 'split';
      id?: string;
      emphasis: 'primary' | 'standard' | 'muted';
      tone: 'neutral' | 'positive' | 'warning' | 'urgent';
      ratio: 'balanced' | 'lead';
      children: [BriefNode, BriefNode];
    }
  | {
      kind: 'hero';
      id?: string;
      emphasis: 'primary' | 'standard' | 'muted';
      tone: 'neutral' | 'positive' | 'warning' | 'urgent';
      surface: 'plain' | 'elevated' | 'glass';
      children: BriefNode[];
    }
  | {
      kind: 'group';
      id?: string;
      emphasis: 'primary' | 'standard' | 'muted';
      tone: 'neutral' | 'positive' | 'warning' | 'urgent';
      title: string;
      kicker?: string;
      surface: 'plain' | 'elevated' | 'glass';
      collapsible: boolean;
      children: BriefNode[];
    };

export const BriefNodeSchema: z.ZodType<BriefNode> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    BriefContentLeafSchema,
    z.object({
      ...commonNodeShape,
      kind: z.literal('stack'),
      density: z.enum(['airy', 'standard', 'dense']).default('standard'),
      children: z.array(BriefNodeSchema).min(1).max(BRIEF_DOCUMENT_LIMITS.children),
    }),
    z.object({
      ...commonNodeShape,
      kind: z.literal('grid'),
      columns: z.union([z.literal(2), z.literal(3)]).default(2),
      children: z.array(BriefNodeSchema).min(2).max(12),
    }),
    z.object({
      ...commonNodeShape,
      kind: z.literal('split'),
      ratio: z.enum(['balanced', 'lead']).default('balanced'),
      children: z.tuple([BriefNodeSchema, BriefNodeSchema]),
    }),
    z.object({
      ...commonNodeShape,
      kind: z.literal('hero'),
      surface: surfaceSchema,
      children: z.array(BriefNodeSchema).min(1).max(3),
    }),
    z.object({
      ...commonNodeShape,
      kind: z.literal('group'),
      title: z.string().trim().min(1).max(BRIEF_DOCUMENT_LIMITS.title),
      kicker: z.string().max(120).optional(),
      surface: surfaceSchema,
      collapsible: z.boolean().default(false),
      children: z.array(BriefNodeSchema).min(1).max(12),
    }),
  ]),
);

export const BriefRegionSchema = z.object({
  id: z.string().trim().min(1).max(120),
  intent: z.string().max(BRIEF_DOCUMENT_LIMITS.shortText).optional(),
  summary: z.string().trim().min(1).max(BRIEF_DOCUMENT_LIMITS.regionSummary),
  tree: BriefNodeSchema,
});

export const BriefDocumentV2Schema = z.object({
  version: z.literal(BRIEF_DOCUMENT_VERSION),
  title: z.string().trim().min(1).max(BRIEF_DOCUMENT_LIMITS.title),
  summary: z.string().trim().min(1).max(BRIEF_DOCUMENT_LIMITS.summary),
  generatedAt: z.number().finite().nonnegative(),
  regions: z.array(BriefRegionSchema).max(BRIEF_DOCUMENT_LIMITS.regions),
});

export type BriefRegion = z.infer<typeof BriefRegionSchema>;
export type BriefDocumentV2 = z.infer<typeof BriefDocumentV2Schema>;

export interface BriefDocumentLintIssue {
  code: 'depth' | 'node_count' | 'hero_count' | 'canvas_count' | 'heterogeneous_grid' | 'unknown_action';
  path: string;
  message: string;
}

export interface BriefDocumentParseResult {
  document: BriefDocumentV2;
  issues: BriefDocumentLintIssue[];
  repaired: boolean;
}

const layoutKinds = new Set(['stack', 'grid', 'split', 'hero', 'group']);
const leafKinds = new Set([
  'entity_list',
  'query_list',
  'stat',
  'chart',
  'timeline',
  'checklist',
  'collection',
  'text',
  'actions',
  'prompt',
  'divider',
  'canvas',
]);

export function parseBriefDocument(value: unknown): BriefDocumentV2 {
  return parseBriefDocumentWithReport(value).document;
}

export function parseBriefDocumentWithReport(value: unknown): BriefDocumentParseResult {
  const repaired = repairBriefDocument(value);
  const document = BriefDocumentV2Schema.parse(repaired);
  const issues = lintBriefDocument(document);
  return { document, issues, repaired: issues.length > 0 || repaired !== value };
}

export function repairBriefDocument(value: unknown): unknown {
  const raw = record(value);
  const title = clippedString(raw?.title, BRIEF_DOCUMENT_LIMITS.title) || 'Daily Brief';
  const summary =
    clippedString(raw?.summary, BRIEF_DOCUMENT_LIMITS.summary) ||
    'This brief was created by a newer client and is available as a summary.';
  const generatedAt = finiteNumber(raw?.generatedAt) ?? Date.now();

  if (finiteNumber(raw?.version) !== BRIEF_DOCUMENT_VERSION) {
    return {
      version: BRIEF_DOCUMENT_VERSION,
      title,
      summary,
      generatedAt,
      regions: [
        {
          id: 'document-fallback',
          summary,
          tree: fallbackNode(summary, title),
        },
      ],
    };
  }

  const documentBudget = { nodes: 0, heroes: 0, canvases: 0 };
  const regions = (Array.isArray(raw?.regions) ? raw.regions : [])
    .slice(0, BRIEF_DOCUMENT_LIMITS.regions)
    .flatMap((entry, index) => {
      const region = record(entry);
      if (!region) return [];
      const regionSummary = clippedString(region.summary, BRIEF_DOCUMENT_LIMITS.regionSummary) || summary;
      documentBudget.nodes = 0;
      return [
        {
          id: clippedString(region.id, 120) || `region-${index + 1}`,
          ...(clippedString(region.intent, BRIEF_DOCUMENT_LIMITS.shortText)
            ? { intent: clippedString(region.intent, BRIEF_DOCUMENT_LIMITS.shortText) }
            : {}),
          summary: regionSummary,
          tree: repairNode(region.tree, regionSummary, 1, documentBudget, `regions.${index}.tree`),
        },
      ];
    });

  return {
    version: BRIEF_DOCUMENT_VERSION,
    title,
    summary,
    generatedAt,
    regions: regions.length
      ? regions
      : [{ id: 'brief-fallback', summary, tree: fallbackNode(summary, title) }],
  };
}

export function lintBriefDocument(document: BriefDocumentV2): BriefDocumentLintIssue[] {
  const issues: BriefDocumentLintIssue[] = [];
  let heroes = 0;
  let canvases = 0;
  for (const [regionIndex, region] of document.regions.entries()) {
    let nodes = 0;
    const visit = (node: BriefNode, depth: number, path: string) => {
      nodes += 1;
      if (depth > BRIEF_DOCUMENT_LIMITS.depth) {
        issues.push({ code: 'depth', path, message: `Node depth exceeds ${BRIEF_DOCUMENT_LIMITS.depth}.` });
      }
      if (node.kind === 'hero') heroes += 1;
      if (node.kind === 'canvas') canvases += 1;
      if (node.kind === 'grid') {
        const kinds = new Set(node.children.map((child) => child.kind));
        if (kinds.size > 1) {
          issues.push({
            code: 'heterogeneous_grid',
            path,
            message: 'Grid children should share a node kind.',
          });
        }
      }
      for (const [actionIndex, action] of actionsInNode(node).entries()) {
        if (!isKnownBriefAction(action.action)) {
          issues.push({
            code: 'unknown_action',
            path: `${path}.actions.${actionIndex}`,
            message: `Unknown action "${action.action}" is hidden by clients.`,
          });
        }
      }
      if ('children' in node) {
        node.children.forEach((child, index) => {
          visit(child, depth + 1, `${path}.children.${index}`);
        });
      }
    };
    visit(region.tree, 1, `regions.${regionIndex}.tree`);
    if (nodes > BRIEF_DOCUMENT_LIMITS.nodesPerRegion) {
      issues.push({
        code: 'node_count',
        path: `regions.${regionIndex}`,
        message: `Region has ${nodes} nodes; maximum is ${BRIEF_DOCUMENT_LIMITS.nodesPerRegion}.`,
      });
    }
  }
  if (heroes > BRIEF_DOCUMENT_LIMITS.heroes) {
    issues.push({ code: 'hero_count', path: 'regions', message: 'Document has more than one hero.' });
  }
  if (canvases > BRIEF_DOCUMENT_LIMITS.canvases) {
    issues.push({ code: 'canvas_count', path: 'regions', message: 'Document has more than two canvases.' });
  }
  return issues;
}

function repairNode(
  value: unknown,
  summary: string,
  depth: number,
  budget: { nodes: number; heroes: number; canvases: number },
  path: string,
): unknown {
  const candidate = record(value);
  if (depth > BRIEF_DOCUMENT_LIMITS.depth || budget.nodes >= BRIEF_DOCUMENT_LIMITS.nodesPerRegion) {
    return fallbackTextLeaf(summary);
  }
  if (
    depth === BRIEF_DOCUMENT_LIMITS.depth &&
    candidate &&
    layoutKinds.has(typeof candidate.kind === 'string' ? candidate.kind : '')
  ) {
    budget.nodes += 1;
    return fallbackTextLeaf(summary);
  }
  budget.nodes += 1;
  const node = candidate;
  if (!node) return fallbackNode(summary);
  const kind = typeof node.kind === 'string' ? node.kind : '';

  if (!layoutKinds.has(kind) && !leafKinds.has(kind)) {
    if (Array.isArray(node.children) && node.children.length) {
      return {
        kind: 'stack',
        ...commonNodeFields(node),
        density: 'standard',
        children: node.children
          .slice(0, BRIEF_DOCUMENT_LIMITS.children)
          .map((child, index) => repairNode(child, summary, depth + 1, budget, `${path}.children.${index}`)),
      };
    }
    return depth >= BRIEF_DOCUMENT_LIMITS.depth
      ? fallbackTextLeaf(
          clippedString(node.fallbackText, BRIEF_DOCUMENT_LIMITS.body) ||
            clippedString(node.summary, BRIEF_DOCUMENT_LIMITS.body) ||
            summary,
        )
      : fallbackNode(
          clippedString(node.fallbackText, BRIEF_DOCUMENT_LIMITS.body) ||
            clippedString(node.summary, BRIEF_DOCUMENT_LIMITS.body) ||
            summary,
        );
  }

  if (layoutKinds.has(kind)) {
    const rawChildren = Array.isArray(node.children) ? node.children : [];
    const maxChildren =
      kind === 'hero' ? 3 : kind === 'split' ? 2 : kind === 'grid' ? 12 : kind === 'group' ? 12 : 24;
    let children = rawChildren
      .slice(0, maxChildren)
      .map((child, index) => repairNode(child, summary, depth + 1, budget, `${path}.children.${index}`));
    if (kind === 'split') {
      while (children.length < 2) children.push(fallbackNode(summary));
      children = children.slice(0, 2);
    }
    if (kind === 'grid') {
      while (children.length < 2) children.push(fallbackNode(summary));
      const childKinds = new Set(children.map((child) => record(child)?.kind));
      if (childKinds.size > 1) {
        return {
          kind: 'stack',
          ...commonNodeFields(node),
          density: 'standard',
          children,
        };
      }
    }
    if (!children.length) children = [fallbackNode(summary)];
    if (kind === 'hero') {
      budget.heroes += 1;
      if (budget.heroes > BRIEF_DOCUMENT_LIMITS.heroes) {
        return { kind: 'stack', ...commonNodeFields(node), density: 'airy', children };
      }
    }
    const base = { kind, ...commonNodeFields(node), children };
    if (kind === 'stack')
      return { ...base, density: oneOf(node.density, ['airy', 'standard', 'dense'], 'standard') };
    if (kind === 'grid') return { ...base, columns: node.columns === 3 ? 3 : 2 };
    if (kind === 'split') return { ...base, ratio: oneOf(node.ratio, ['balanced', 'lead'], 'balanced') };
    if (kind === 'hero') return { ...base, surface: surface(node.surface) };
    return {
      ...base,
      title: clippedString(node.title, BRIEF_DOCUMENT_LIMITS.title) || 'Brief',
      ...(clippedString(node.kicker, 120) ? { kicker: clippedString(node.kicker, 120) } : {}),
      surface: surface(node.surface),
      collapsible: Boolean(node.collapsible),
    };
  }

  return repairLeaf(node, kind, summary, budget);
}

function repairLeaf(
  node: Record<string, unknown>,
  kind: string,
  summary: string,
  budget: { nodes: number; heroes: number; canvases: number },
): unknown {
  const common = commonNodeFields(node);
  const cleanActions = (value: unknown) =>
    (Array.isArray(value) ? value : []).slice(0, BRIEF_DOCUMENT_LIMITS.actions).flatMap((entry) => {
      const action = record(entry);
      const name = clippedString(action?.action, 80);
      if (!action || !name || !isKnownBriefAction(name)) return [];
      return [
        {
          action: name,
          label: clippedString(action.label, 80) || defaultActionLabel(name),
          payload: record(action.payload) || {},
          style: oneOf(action.style, ['primary', 'secondary', 'danger', 'quiet'], 'secondary'),
        },
      ];
    });
  const ref = (value: unknown) => repairRef(value);

  switch (kind) {
    case 'text':
      return {
        kind,
        ...common,
        role: oneOf(node.role, ['lede', 'kicker', 'body', 'aside', 'caption'], 'body'),
        text: clippedString(node.text, BRIEF_DOCUMENT_LIMITS.body) || summary,
      };
    case 'divider':
      return {
        kind,
        ...common,
        variant: oneOf(node.variant, ['line', 'space', 'flourish'], 'line'),
      };
    case 'prompt':
      return {
        kind,
        ...common,
        variant: oneOf(node.variant, ['capture', 'question'], 'capture'),
        placeholder: clippedString(node.placeholder, 240) || 'Add a thought…',
        ...(clippedString(node.questionId, 240) ? { questionId: clippedString(node.questionId, 240) } : {}),
      };
    case 'actions': {
      const actions = cleanActions(node.actions);
      return actions.length ? { kind, ...common, actions } : fallbackNode(summary);
    }
    case 'canvas': {
      budget.canvases += 1;
      const fallbackText = clippedString(node.fallbackText, BRIEF_DOCUMENT_LIMITS.body) || summary;
      if (
        budget.canvases > BRIEF_DOCUMENT_LIMITS.canvases ||
        !clippedString(node.html, BRIEF_DOCUMENT_LIMITS.canvasHtml)
      ) {
        return fallbackNode(fallbackText, clippedString(node.title, BRIEF_DOCUMENT_LIMITS.title));
      }
      return {
        kind,
        ...common,
        canvasId: clippedString(node.canvasId ?? node.id, 120) || `canvas-${budget.canvases}`,
        title: clippedString(node.title, BRIEF_DOCUMENT_LIMITS.title) || 'Visual',
        html: clippedString(node.html, BRIEF_DOCUMENT_LIMITS.canvasHtml),
        fallbackText,
        allowedActions: (Array.isArray(node.allowedActions) ? node.allowedActions : [])
          .filter((action): action is string => typeof action === 'string' && isKnownBriefAction(action))
          .slice(0, BRIEF_DOCUMENT_LIMITS.actions),
        height: oneOf(node.height, ['compact', 'medium', 'tall'], 'medium'),
      };
    }
    case 'entity_list':
      return {
        kind,
        ...common,
        ...(clippedString(node.title, BRIEF_DOCUMENT_LIMITS.title)
          ? { title: clippedString(node.title, BRIEF_DOCUMENT_LIMITS.title) }
          : {}),
        items: (Array.isArray(node.items) ? node.items : [])
          .slice(0, BRIEF_DOCUMENT_LIMITS.entityItems)
          .flatMap((entry) => {
            const item = record(entry);
            const sourceRef = ref(item?.ref);
            if (!item || !sourceRef) return [];
            const framing = record(item.framing) || {};
            const handoff = repairEntityHandoff(item.handoff, ref);
            return [
              {
                ref: sourceRef,
                framing: {
                  ...(clippedString(framing.reason, BRIEF_DOCUMENT_LIMITS.shortText)
                    ? { reason: clippedString(framing.reason, BRIEF_DOCUMENT_LIMITS.shortText) }
                    : {}),
                  ...(clippedString(framing.lane, 120) ? { lane: clippedString(framing.lane, 120) } : {}),
                  ...(clippedString(framing.prep, BRIEF_DOCUMENT_LIMITS.shortText)
                    ? { prep: clippedString(framing.prep, BRIEF_DOCUMENT_LIMITS.shortText) }
                    : {}),
                },
                ...(handoff ? { handoff } : {}),
                actions: cleanActions(item.actions),
              },
            ];
          }),
        variant: oneOf(node.variant, ['rows', 'cards', 'compact'], 'rows'),
        ...(clippedString(node.emptyText, BRIEF_DOCUMENT_LIMITS.shortText)
          ? { emptyText: clippedString(node.emptyText, BRIEF_DOCUMENT_LIMITS.shortText) }
          : {}),
      };
    case 'query_list': {
      const query = repairQuery(node.query);
      if (!query) {
        return {
          kind: 'text',
          ...common,
          role: 'aside',
          text: clippedString(node.emptyText, BRIEF_DOCUMENT_LIMITS.shortText) || summary,
        };
      }
      return {
        kind,
        ...common,
        ...(clippedString(node.title, BRIEF_DOCUMENT_LIMITS.title)
          ? { title: clippedString(node.title, BRIEF_DOCUMENT_LIMITS.title) }
          : {}),
        query,
        limit: clampInteger(node.limit, 1, BRIEF_DOCUMENT_LIMITS.queryLimit, 12),
        variant: oneOf(node.variant, ['rows', 'cards', 'compact'], 'rows'),
        emptyText:
          clippedString(node.emptyText, BRIEF_DOCUMENT_LIMITS.shortText) || 'Nothing here right now.',
      };
    }
    case 'stat': {
      const queryValue = repairQuery(node.queryValue);
      const value =
        typeof node.value === 'number' && Number.isFinite(node.value)
          ? node.value
          : clippedString(node.value, 120);
      if (value === undefined && !queryValue) return fallbackNode(summary);
      return {
        kind,
        ...common,
        label: clippedString(node.label, 160) || 'Status',
        ...(value !== undefined ? { value } : {}),
        ...(queryValue ? { queryValue } : {}),
        ...(clippedString(node.delta, 120) ? { delta: clippedString(node.delta, 120) } : {}),
        ...(clippedString(node.unit, 80) ? { unit: clippedString(node.unit, 80) } : {}),
      };
    }
    case 'chart': {
      const refs = (Array.isArray(node.sourceRefs) ? node.sourceRefs : []).flatMap((entry) => {
        const sourceRef = ref(entry);
        return sourceRef ? [sourceRef] : [];
      });
      const data = (Array.isArray(node.data) ? node.data : [])
        .slice(0, BRIEF_DOCUMENT_LIMITS.chartPoints)
        .flatMap((entry) => {
          const point = record(entry);
          const label = clippedString(point?.label, 100);
          const value = finiteNumber(point?.value);
          if (!point || !label || value === undefined) return [];
          return [
            {
              label,
              value,
              ...(clippedString(point.group, 100) ? { group: clippedString(point.group, 100) } : {}),
            },
          ];
        });
      if (!data.length) return fallbackNode(summary);
      return {
        kind,
        ...common,
        variant: oneOf(node.variant, ['bar', 'stacked_bar', 'donut', 'line'], 'bar'),
        title: clippedString(node.title, BRIEF_DOCUMENT_LIMITS.title) || 'Chart',
        ...(clippedString(node.description, BRIEF_DOCUMENT_LIMITS.shortText)
          ? { description: clippedString(node.description, BRIEF_DOCUMENT_LIMITS.shortText) }
          : {}),
        data,
        sourceRefs: refs.length ? refs : [{ kind: 'derived', id: 'brief-chart' }],
      };
    }
    case 'timeline': {
      const items = repairTimelineItems(node.items, ref, cleanActions);
      return items.length
        ? {
            kind,
            ...common,
            title: clippedString(node.title, BRIEF_DOCUMENT_LIMITS.title) || 'Timeline',
            items,
          }
        : fallbackNode(summary);
    }
    case 'checklist': {
      const items = (Array.isArray(node.items) ? node.items : [])
        .slice(0, BRIEF_DOCUMENT_LIMITS.checklistItems)
        .flatMap((entry) => {
          const item = record(entry);
          const label = clippedString(item?.label, BRIEF_DOCUMENT_LIMITS.shortText);
          if (!item || !label) return [];
          const [action] = cleanActions(item.action ? [item.action] : []);
          const sourceRef = ref(item.ref);
          return [
            {
              label,
              ...(clippedString(item.detail, BRIEF_DOCUMENT_LIMITS.shortText)
                ? { detail: clippedString(item.detail, BRIEF_DOCUMENT_LIMITS.shortText) }
                : {}),
              checked: Boolean(item.checked),
              ...(sourceRef ? { ref: sourceRef } : {}),
              ...(action ? { action } : {}),
            },
          ];
        });
      return items.length
        ? {
            kind,
            ...common,
            title: clippedString(node.title, BRIEF_DOCUMENT_LIMITS.title) || 'Checklist',
            items,
          }
        : fallbackNode(summary);
    }
    case 'collection':
      return {
        kind,
        ...common,
        ...(clippedString(node.title, BRIEF_DOCUMENT_LIMITS.title)
          ? { title: clippedString(node.title, BRIEF_DOCUMENT_LIMITS.title) }
          : {}),
        items: (Array.isArray(node.items) ? node.items : [])
          .slice(0, BRIEF_DOCUMENT_LIMITS.collectionItems)
          .flatMap((entry) => {
            const item = record(entry);
            const title = clippedString(item?.title, BRIEF_DOCUMENT_LIMITS.shortText);
            if (!item || !title) return [];
            const image = safeUrl(item.image);
            const sourceRef = ref(item.ref);
            return [
              {
                title,
                ...(image ? { image } : {}),
                ...(clippedString(item.meta, BRIEF_DOCUMENT_LIMITS.shortText)
                  ? { meta: clippedString(item.meta, BRIEF_DOCUMENT_LIMITS.shortText) }
                  : {}),
                ...(clippedString(item.badge, 80) ? { badge: clippedString(item.badge, 80) } : {}),
                ...(sourceRef ? { ref: sourceRef } : {}),
                actions: cleanActions(item.actions),
              },
            ];
          }),
        variant: oneOf(node.variant, ['shelf', 'grid', 'list'], 'list'),
        ...(clippedString(node.emptyText, BRIEF_DOCUMENT_LIMITS.shortText)
          ? { emptyText: clippedString(node.emptyText, BRIEF_DOCUMENT_LIMITS.shortText) }
          : {}),
      };
    default:
      return fallbackNode(summary);
  }
}

function repairEntityHandoff(
  value: unknown,
  ref: (value: unknown) => Record<string, unknown> | null,
): Record<string, unknown> | null {
  const handoff = record(value);
  if (!handoff) return null;
  const situation = clippedString(handoff.situation, BRIEF_DOCUMENT_LIMITS.shortText);
  const assessment = clippedString(handoff.assessment, BRIEF_DOCUMENT_LIMITS.shortText);
  const recommendation = clippedString(handoff.recommendation, BRIEF_DOCUMENT_LIMITS.shortText);
  if (!situation || !assessment || !recommendation) return null;
  const background = (Array.isArray(handoff.background) ? handoff.background : [])
    .map((entry) => clippedString(entry, BRIEF_DOCUMENT_LIMITS.shortText))
    .filter((entry): entry is string => Boolean(entry))
    .slice(0, 3);
  const recommendations = (Array.isArray(handoff.recommendations) ? handoff.recommendations : [])
    .slice(0, 4)
    .flatMap((entry) => {
      const item = record(entry);
      const label = clippedString(item?.label, BRIEF_DOCUMENT_LIMITS.shortText);
      if (!item || !label) return [];
      const sourceRef = ref(item.ref);
      return [{ label, ...(sourceRef ? { ref: sourceRef } : {}) }];
    });
  const evidence = (Array.isArray(handoff.evidence) ? handoff.evidence : []).slice(0, 4).flatMap((entry) => {
    const item = record(entry);
    const label = clippedString(item?.label, BRIEF_DOCUMENT_LIMITS.shortText);
    if (!item || !label) return [];
    const sourceRef = ref(item.ref);
    return [{ label, ...(sourceRef ? { ref: sourceRef } : {}) }];
  });
  return {
    ...(clippedString(handoff.handoffId, 240) ? { handoffId: clippedString(handoff.handoffId, 240) } : {}),
    itemCount: Math.min(8, Math.max(1, Math.floor(finiteNumber(handoff.itemCount) ?? 1))),
    situation,
    background,
    assessment,
    recommendation,
    recommendations,
    evidence,
  };
}

function repairTimelineItems(
  value: unknown,
  ref: (value: unknown) => Record<string, unknown> | null,
  cleanActions: (value: unknown) => Array<Record<string, unknown>>,
) {
  return (Array.isArray(value) ? value : [])
    .slice(0, BRIEF_DOCUMENT_LIMITS.timelineItems)
    .flatMap((entry) => {
      const item = record(entry);
      const label = clippedString(item?.label, BRIEF_DOCUMENT_LIMITS.shortText);
      if (!item || !label) return [];
      const sourceRef = ref(item.ref);
      const at = finiteNumber(item.at);
      return [
        {
          label,
          ...(at !== undefined ? { at } : {}),
          ...(clippedString(item.detail, BRIEF_DOCUMENT_LIMITS.shortText)
            ? { detail: clippedString(item.detail, BRIEF_DOCUMENT_LIMITS.shortText) }
            : {}),
          ...(sourceRef ? { ref: sourceRef } : {}),
          actions: cleanActions(item.actions),
        },
      ];
    });
}

function repairRef(value: unknown): Record<string, unknown> | null {
  const source = record(value);
  const id = clippedString(
    source?.id ?? source?.threadId ?? source?.messageId ?? source?.cardId ?? source?.eventId,
    240,
  );
  if (!source || !id) return null;
  const rawKind = typeof source.kind === 'string' ? source.kind.toLowerCase() : '';
  const kind =
    oneOf(
      rawKind,
      ['thread', 'message', 'task', 'event', 'card', 'mcp', 'account', 'derived', 'area', 'work'],
      '',
    ) ||
    (source.threadId
      ? 'thread'
      : source.messageId
        ? 'message'
        : source.cardId
          ? 'card'
          : source.eventId
            ? 'event'
            : 'derived');
  return {
    kind,
    id,
    ...(clippedString(source.account, 320) ? { account: clippedString(source.account, 320) } : {}),
    ...(clippedString(source.label ?? source.title ?? source.subject, BRIEF_DOCUMENT_LIMITS.shortText)
      ? {
          label: clippedString(
            source.label ?? source.title ?? source.subject,
            BRIEF_DOCUMENT_LIMITS.shortText,
          ),
        }
      : {}),
  };
}

function repairQuery(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    const area = value.match(/^area_open_work\\(([^)]+)\\)$/);
    if (area) return { name: 'area_open_work', areaId: area[1] };
    return (BRIEF_QUERY_NAMES as readonly string[]).includes(value) && value !== 'area_open_work'
      ? { name: value }
      : null;
  }
  const query = record(value);
  if (!query || !(BRIEF_QUERY_NAMES as readonly unknown[]).includes(query.name)) return null;
  if (query.name === 'area_open_work') {
    const areaId = clippedString(query.areaId, 240);
    return areaId ? { name: query.name, areaId } : null;
  }
  return { name: query.name };
}

function fallbackNode(text: string, title = 'Brief update') {
  return {
    kind: 'group',
    emphasis: 'standard',
    tone: 'neutral',
    title: title.slice(0, BRIEF_DOCUMENT_LIMITS.title),
    surface: 'elevated',
    collapsible: false,
    children: [
      {
        kind: 'text',
        emphasis: 'standard',
        tone: 'neutral',
        role: 'body',
        text: text.slice(0, BRIEF_DOCUMENT_LIMITS.body),
      },
    ],
  };
}

function fallbackTextLeaf(text: string) {
  return {
    kind: 'text',
    emphasis: 'standard',
    tone: 'neutral',
    role: 'body',
    text: text.slice(0, BRIEF_DOCUMENT_LIMITS.body),
  };
}

function commonNodeFields(node: Record<string, unknown>) {
  return {
    ...(clippedString(node.id, 120) ? { id: clippedString(node.id, 120) } : {}),
    emphasis: oneOf(node.emphasis, ['primary', 'standard', 'muted'], 'standard'),
    tone: oneOf(node.tone, ['neutral', 'positive', 'warning', 'urgent'], 'neutral'),
  };
}

function actionsInNode(node: BriefNode) {
  if (node.kind === 'actions') return node.actions;
  if (node.kind === 'entity_list') return node.items.flatMap((item) => item.actions);
  if (node.kind === 'collection') return node.items.flatMap((item) => item.actions);
  if (node.kind === 'timeline') return node.items.flatMap((item) => item.actions);
  if (node.kind === 'checklist') return node.items.flatMap((item) => (item.action ? [item.action] : []));
  return [];
}

function surface(value: unknown) {
  return oneOf(value, ['plain', 'elevated', 'glass'], 'plain');
}

function defaultActionLabel(action: string) {
  return action
    .split('_')
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(' ')
    .slice(0, 80);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function clippedString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function clampInteger(value: unknown, min: number, max: number, fallback: number) {
  const number = finiteNumber(value);
  return number === undefined ? fallback : Math.min(max, Math.max(min, Math.floor(number)));
}

function oneOf<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === 'string' && (values as readonly string[]).includes(value) ? (value as T) : fallback;
}

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}
