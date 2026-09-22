import { z } from 'zod';
import { SerializableApprovalCardSchema } from '@/components/tool-ui/approval-card/schema';
import { SerializableAudioSchema } from '@/components/tool-ui/audio/schema';
import { SerializableChartSchema } from '@/components/tool-ui/chart/schema';
import { SerializableCitationSchema } from '@/components/tool-ui/citation/schema';
import { SerializableCodeBlockSchema } from '@/components/tool-ui/code-block/schema';
import { SerializableCodeDiffSchema } from '@/components/tool-ui/code-diff/schema';
import { SerializableDataTableSchema } from '@/components/tool-ui/data-table/schema';
import { SerializableGeoMapSchema } from '@/components/tool-ui/geo-map/schema';
import { SerializableImageSchema } from '@/components/tool-ui/image/schema';
import { SerializableImageGallerySchema } from '@/components/tool-ui/image-gallery/schema';
import { SerializableInstagramPostSchema } from '@/components/tool-ui/instagram-post/schema';
import { SerializableItemCarouselSchema } from '@/components/tool-ui/item-carousel/schema';
import { SerializableLinkPreviewSchema } from '@/components/tool-ui/link-preview/schema';
import { SerializableLinkedInPostSchema } from '@/components/tool-ui/linkedin-post/schema';
import { SerializableMessageDraftSchema } from '@/components/tool-ui/message-draft/schema';
import { SerializableOptionListSchema } from '@/components/tool-ui/option-list/schema';
import { SerializableOrderSummarySchema } from '@/components/tool-ui/order-summary/schema';
import { SerializableParameterSliderSchema } from '@/components/tool-ui/parameter-slider/schema';
import { SerializablePlanSchema } from '@/components/tool-ui/plan/schema';
import { SerializablePreferencesPanelSchema } from '@/components/tool-ui/preferences-panel/schema';
import { SerializableProgressTrackerSchema } from '@/components/tool-ui/progress-tracker/schema';
import { SerializableUpfrontModeSchema } from '@/components/tool-ui/question-flow/schema';
import { SerializableStatsDisplaySchema } from '@/components/tool-ui/stats-display/schema';
import { SerializableTerminalSchema } from '@/components/tool-ui/terminal/schema';
import { SerializableVideoSchema } from '@/components/tool-ui/video/schema';
import { SerializableXPostSchema } from '@/components/tool-ui/x-post/schema';

// One catalogue for authoring, validation, rendering and saved interaction state.
// Reuse the actual Tool UI contracts, so a component cannot exist only in a prompt.
const weatherCondition = z.enum([
  'clear',
  'partly-cloudy',
  'cloudy',
  'overcast',
  'fog',
  'drizzle',
  'rain',
  'heavy-rain',
  'thunderstorm',
  'snow',
  'sleet',
  'hail',
  'windy',
]);
const WeatherSchema = z.object({
  version: z.literal('3.1'),
  id: z.string().min(1),
  location: z.object({ name: z.string().min(1) }),
  units: z.object({ temperature: z.enum(['celsius', 'fahrenheit']) }),
  current: z.object({
    conditionCode: weatherCondition,
    temperature: z.number(),
    tempMin: z.number(),
    tempMax: z.number(),
    windSpeed: z.number().optional(),
    precipitationLevel: z.enum(['none', 'light', 'moderate', 'heavy']).optional(),
    visibility: z.number().optional(),
  }),
  forecast: z
    .array(
      z.object({
        label: z.string(),
        conditionCode: weatherCondition,
        tempMin: z.number(),
        tempMax: z.number(),
      }),
    )
    .max(7),
  time: z.object({
    timeBucket: z.number().int().min(0).max(11).optional(),
    localTimeOfDay: z.number().min(0).max(24).optional(),
  }),
  updatedAt: z.string().optional(),
});
export const briefComponentCatalog = {
  'approval-card': {
    schema: SerializableApprovalCardSchema,
    description: 'Record a decision; continue in the assistant to carry it out.',
  },
  audio: { schema: SerializableAudioSchema, description: 'Play source audio.' },
  chart: { schema: SerializableChartSchema, description: 'Explore factual numerical series.' },
  citation: { schema: SerializableCitationSchema, description: 'Link to an original source.' },
  'code-block': { schema: SerializableCodeBlockSchema, description: 'Read or copy source code.' },
  'code-diff': { schema: SerializableCodeDiffSchema, description: 'Compare proposed code changes.' },
  'data-table': { schema: SerializableDataTableSchema, description: 'Sort and inspect comparable records.' },
  'geo-map': { schema: SerializableGeoMapSchema, description: 'Explore grounded locations and routes.' },
  'image-gallery': { schema: SerializableImageGallerySchema, description: 'Browse related source images.' },
  image: { schema: SerializableImageSchema, description: 'Show a source image.' },
  'instagram-post': {
    schema: SerializableInstagramPostSchema,
    description: 'Read a sourced Instagram post.',
  },
  'item-carousel': {
    schema: SerializableItemCarouselSchema,
    description: 'Compare items and save a selection.',
  },
  'link-preview': { schema: SerializableLinkPreviewSchema, description: 'Open a referenced page.' },
  'linkedin-post': { schema: SerializableLinkedInPostSchema, description: 'Read a sourced LinkedIn post.' },
  'message-draft': {
    schema: SerializableMessageDraftSchema,
    description: 'Review and edit a draft; sending requires the normal composer.',
  },
  'option-list': { schema: SerializableOptionListSchema, description: 'Save a single or multiple choice.' },
  'order-summary': {
    schema: SerializableOrderSummarySchema,
    description: 'Inspect itemized costs; this does not purchase anything.',
  },
  'parameter-slider': {
    schema: SerializableParameterSliderSchema,
    description: 'Save bounded numerical inputs.',
  },
  plan: { schema: SerializablePlanSchema, description: 'Read a proposed sequence with actual progress.' },
  'preferences-panel': {
    schema: SerializablePreferencesPanelSchema,
    description: 'Save preferences for this brief workflow.',
  },
  'progress-tracker': {
    schema: SerializableProgressTrackerSchema,
    description: 'Show verified process status.',
  },
  'question-flow': {
    schema: SerializableUpfrontModeSchema,
    description: 'Save answers to a guided questionnaire.',
  },
  'stats-display': {
    schema: SerializableStatsDisplaySchema,
    description: 'Show sourced figures and changes.',
  },
  terminal: {
    schema: SerializableTerminalSchema,
    description: 'Read actual command output; never executes code.',
  },
  video: { schema: SerializableVideoSchema, description: 'Play source video.' },
  'x-post': { schema: SerializableXPostSchema, description: 'Read a sourced X post.' },
  'weather-widget': {
    schema: WeatherSchema,
    description: 'Show observed weather and forecast. Use only supplied weather data.',
  },
  'editorial-text': {
    schema: z
      .object({
        id: z.string().min(1),
        title: z.string().max(160).optional(),
        text: z.string().min(1).max(12000),
        role: z.enum(['lede', 'body', 'aside']).default('body'),
      })
      .strict(),
    description:
      'Write a substantial editorial story, analysis, recap or explanatory note in Markdown, grounded in the selected sources.',
  },
} as const;
export type BriefComponentName = keyof typeof briefComponentCatalog;
export const briefComponentNames = Object.keys(briefComponentCatalog) as [
  BriefComponentName,
  ...BriefComponentName[],
];
export const briefComponentNameSchema = z.enum(briefComponentNames);
export const interactiveBriefComponents = new Set<BriefComponentName>([
  'approval-card',
  'option-list',
  'parameter-slider',
  'preferences-panel',
  'question-flow',
  'item-carousel',
  'message-draft',
]);

export function describeBriefComponent(name: BriefComponentName) {
  const entry = briefComponentCatalog[name];
  return {
    name,
    description: entry.description,
    interactive: interactiveBriefComponents.has(name),
    schema: z.toJSONSchema(entry.schema, { unrepresentable: 'any' }),
  };
}

/** Check before parsing: Zod's compatibility stripping must not conceal unsafe props. */
function inspectJson(value: unknown, depth = 0) {
  if (depth > 16) throw new Error('Component data is too deeply nested.');
  if (
    typeof value === 'string' &&
    /^\s*(?:(?:javascript|vbscript):|data:\s*(?:[^,\s;]+\/[^,\s;]+)?(?:;[^,\s]*)?,)/i.test(
      value.replace(/[\t\n\r]/g, ''),
    )
  )
    throw new Error('Unsafe component URL.');
  if (typeof value === 'function') throw new Error('Callbacks are supplied by the host.');
  if (Array.isArray(value)) {
    if (value.length > 300) throw new Error('Too many component items.');
    for (const item of value) inspectJson(item, depth + 1);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (
        /^on[A-Z]|className$|^style$|^dangerouslySetInnerHTML$|^__proto__$|^constructor$|^prototype$/.test(
          key,
        )
      )
        throw new Error('Component styling and handlers are host-owned.');
      inspectJson(item, depth + 1);
    }
  }
}

export function parseBriefComponent(name: BriefComponentName, input: unknown): Record<string, unknown> {
  if (JSON.stringify(input).length > 60000) throw new Error('Component payload exceeds 60 KB.');
  inspectJson(input);
  const props = briefComponentCatalog[name].schema.parse(input) as Record<string, unknown>;
  if (name === 'option-list' && !(props.options as unknown[]).length)
    throw new Error('Supply at least one option.');
  if (name === 'item-carousel' && !(props.items as unknown[]).length)
    throw new Error('Supply at least one item.');
  if (name === 'data-table' && (!(props.columns as unknown[]).length || !(props.data as unknown[]).length))
    throw new Error('A comparison needs columns and source rows.');
  // A model cannot claim the user answered or that an external operation completed.
  if (
    props.receipt !== undefined ||
    props.choice !== undefined ||
    props.outcome !== undefined ||
    props.variant === 'receipt'
  )
    throw new Error('Receipts come from saved user interactions, not the writer.');
  if (name === 'data-table' && props.sort !== undefined)
    throw new Error('Use defaultSort so the table remains interactive.');
  if (name === 'chart')
    props.colors = [
      'var(--color-accent)',
      'var(--color-accent-2)',
      'oklch(from var(--color-accent) calc(l + 0.18) calc(c * 0.7) h)',
      'oklch(from var(--color-accent-2) calc(l + 0.18) calc(c * 0.7) h)',
    ];
  return props;
}

/** Values are checked against this exact component, not a generic JSON blob. */
export function parseBriefComponentAnswer(
  name: BriefComponentName,
  props: Record<string, unknown>,
  value: unknown,
): unknown {
  const fail = () => {
    throw new Error('The answer does not match this component.');
  };
  const selection = (
    options: Array<{ id: string; disabled?: boolean }>,
    raw: unknown,
    multi: boolean,
    min = 1,
    max = options.length,
  ) => {
    const ids = z.array(z.string()).parse(raw);
    if (
      new Set(ids).size !== ids.length ||
      ids.length < min ||
      ids.length > (multi ? max : 1) ||
      ids.some((id) => !options.some((o) => o.id === id && !o.disabled))
    )
      fail();
    return ids;
  };
  switch (name) {
    case 'approval-card':
      return z.enum(['approved', 'denied']).parse(value);
    case 'option-list': {
      const p = SerializableOptionListSchema.parse(props);
      return selection(p.options, value, p.selectionMode === 'multi', p.minSelections ?? 1, p.maxSelections);
    }
    case 'item-carousel': {
      const p = SerializableItemCarouselSchema.parse(props);
      return selection(p.items, value, false);
    }
    case 'parameter-slider': {
      const p = SerializableParameterSliderSchema.parse(props);
      const values = z.record(z.string(), z.number().finite()).parse(value);
      if (Object.keys(values).length !== p.sliders.length) fail();
      for (const slider of p.sliders) {
        const n = values[slider.id];
        if (n === undefined || n < slider.min || n > slider.max || (slider.disabled && n !== slider.value))
          fail();
        const step = slider.step ?? 1;
        if (Math.abs((n - slider.min) / step - Math.round((n - slider.min) / step)) > 0.00001) fail();
      }
      return values;
    }
    case 'preferences-panel': {
      const p = SerializablePreferencesPanelSchema.parse(props);
      const values = z.record(z.string(), z.union([z.string(), z.boolean()])).parse(value);
      const items = p.sections.flatMap((s) => s.items);
      if (Object.keys(values).length !== items.length) fail();
      for (const item of items) {
        const v = values[item.id];
        if (
          item.type === 'switch'
            ? typeof v !== 'boolean'
            : !(item.type === 'toggle' ? item.options : item.selectOptions).some((o) => o.value === v)
        )
          fail();
      }
      return values;
    }
    case 'question-flow': {
      const p = SerializableUpfrontModeSchema.parse(props);
      const values = z.record(z.string(), z.array(z.string())).parse(value);
      if (Object.keys(values).length !== p.steps.length) fail();
      for (const step of p.steps) selection(step.options, values[step.id], step.selectionMode === 'multi');
      return values;
    }
    case 'message-draft':
      return z
        .object({ body: z.string().trim().min(1).max(20000), cancelled: z.boolean().optional() })
        .strict()
        .parse(value);
    default:
      throw new Error('This component has no saved input.');
  }
}
