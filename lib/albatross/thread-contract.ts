// The Albatross thread contract (docs/albatross-thread.md).
//
// One file for the shapes that the server, the web client, and the native
// clients share: personal details, form questions, the canonical Work chat
// session, run views in the thread, and the merged timeline. The Swift models
// in apps/ios mirror these names. No React and no server imports here.

import { z } from 'zod';
import type { StepRunView } from '../../convex/albatrossStepRuns';

// ---------------------------------------------------------------------------
// Personal details
// ---------------------------------------------------------------------------

export const PERSONAL_DETAIL_KEYS = ['name', 'email', 'phone', 'home_address', 'emergency_contact'] as const;
export type FixedPersonalDetailKey = (typeof PERSONAL_DETAIL_KEYS)[number];
/** A fixed key, or `custom:<slug>` for a plain fact the user adds. */
export type PersonalDetailKey = FixedPersonalDetailKey | `custom:${string}`;

export const CUSTOM_DETAIL_PREFIX = 'custom:';
const CUSTOM_SLUG = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export function isPersonalDetailKey(value: unknown): value is PersonalDetailKey {
  if (typeof value !== 'string') return false;
  if ((PERSONAL_DETAIL_KEYS as readonly string[]).includes(value)) return true;
  return value.startsWith(CUSTOM_DETAIL_PREFIX) && CUSTOM_SLUG.test(value.slice(CUSTOM_DETAIL_PREFIX.length));
}

export const PERSONAL_DETAIL_LABELS: Record<FixedPersonalDetailKey, string> = {
  name: 'Name',
  email: 'Email',
  phone: 'Phone',
  home_address: 'Home address',
  emergency_contact: 'Emergency contact',
};

const line = (max: number) => z.string().trim().min(1).max(max);
const optionalLine = (max: number) => z.string().trim().max(max).optional();

export const nameValueSchema = z.object({
  first: line(80),
  middle: optionalLine(80),
  last: line(80),
});
export type NameValue = z.infer<typeof nameValueSchema>;

export const addressValueSchema = z.object({
  line1: line(160),
  line2: optionalLine(160),
  city: line(100),
  region: line(100),
  postalCode: line(20),
  /** ISO 3166-1 alpha-2, upper case. */
  country: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/)
    .transform((value) => value.toUpperCase()),
});
export type AddressValue = z.infer<typeof addressValueSchema>;

export const contactValueSchema = z.object({
  name: line(160),
  phone: line(40),
  relationship: optionalLine(60),
});
export type ContactValue = z.infer<typeof contactValueSchema>;

export const customValueSchema = z.object({
  label: line(60),
  value: line(400),
});
export type CustomValue = z.infer<typeof customValueSchema>;

export const phoneValueSchema = z
  .string()
  .trim()
  .min(7)
  .max(40)
  .regex(/^[+0-9()\-.\s]+$/, 'A phone number has digits, spaces, and + ( ) - . only.');
export const emailValueSchema = z.string().trim().max(254).email();

export type PersonalDetailValue = NameValue | AddressValue | ContactValue | CustomValue | string;

/** The value schema for one key. */
export function personalDetailValueSchema(key: PersonalDetailKey): z.ZodType<PersonalDetailValue> {
  switch (key) {
    case 'name':
      return nameValueSchema;
    case 'email':
      return emailValueSchema;
    case 'phone':
      return phoneValueSchema;
    case 'home_address':
      return addressValueSchema;
    case 'emergency_contact':
      return contactValueSchema;
    default:
      return customValueSchema;
  }
}

export type PersonalDetailSource = 'account' | 'settings' | 'chat' | 'form';

/** One saved detail, as the settings API returns it to the signed-in user. */
export interface PersonalDetailView {
  key: PersonalDetailKey;
  label: string;
  value: PersonalDetailValue;
  /** One line for lists: "(607) 555-0100", "12 Elm Street, Apt 3, Springfield, IL 62704". */
  display: string;
  source: PersonalDetailSource;
  /** False for an account default that the user has not saved. */
  saved: boolean;
  updatedAt: number | null;
}

/** GET /api/personal-details */
export interface PersonalDetailsResponse {
  ok: true;
  details: PersonalDetailView[];
  /** The fixed keys that have no value, in catalog order. */
  missing: FixedPersonalDetailKey[];
}

// ---------------------------------------------------------------------------
// Form questions (chat `ask_form` and the runner's `needs_answer`)
// ---------------------------------------------------------------------------

export const FORM_FIELD_KINDS = [
  'choice',
  'text',
  'number',
  'phone',
  'email',
  'date',
  'name',
  'address',
  'contact',
] as const;
export type FormFieldKind = (typeof FORM_FIELD_KINDS)[number];

// A refinement, not .regex(): model-facing schemas carry no JSON-schema
// pattern (the OpenAI Responses API rejects some patterns).
const FIELD_ID = /^[a-z][a-z0-9_]{0,39}$/;
const fieldId = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .refine((value) => FIELD_ID.test(value), 'Field ids are lower case letters, digits, and _.');

export const formOptionSchema = z.object({
  id: z.string().trim().min(1).max(60),
  label: z.string().trim().min(1).max(120),
  /** One line under the label: "Mon, Oct 19 · 4:00–8:00 PM · Zoom · $70". */
  detail: z.string().trim().max(160).optional(),
  /**
   * The tag of the one best option, for example "Matches what you said" or "Earliest free
   * class". The client shows the tag and selects this option first.
   */
  recommended: z.string().trim().min(1).max(40).optional(),
  /** What the calendar says about this option. */
  calendar: z
    .object({
      fit: z.enum(['free', 'conflict']),
      /** "Free on your calendar", "Conflicts with Team sync". */
      note: z.string().trim().min(1).max(120),
    })
    .optional(),
});
export type FormOption = z.infer<typeof formOptionSchema>;

export const formFieldSchema = z
  .object({
    id: fieldId,
    label: z.string().trim().min(1).max(80),
    kind: z.enum(FORM_FIELD_KINDS),
    /** One line under the label. */
    help: z.string().trim().max(160).optional(),
    required: z.boolean().optional().describe('Default true.'),
    options: z.array(formOptionSchema).min(2).max(8).optional().describe('choice only: 2 to 8 options.'),
    multiple: z.boolean().optional().describe('choice only: more than one option.'),
    allowOther: z.boolean().optional().describe('choice only: add a free text "Other" answer.'),
    /** Binds the field to a personal detail: the client fills it, and "Save to my details" saves it. */
    detailKey: z.string().optional(),
    /** A value the agent found (for example in an email signature). The client shows `valueSource`. */
    value: z.unknown().optional(),
    valueSource: z
      .string()
      .trim()
      .max(80)
      .optional()
      .describe('Where `value` came from: "From your email signature".'),
    placeholder: z.string().trim().max(80).optional(),
  })
  .superRefine((field, ctx) => {
    if (field.kind === 'choice' && !field.options?.length)
      ctx.addIssue({ code: 'custom', message: 'A choice field needs options.', path: ['options'] });
    if (field.kind !== 'choice' && field.options?.length)
      ctx.addIssue({ code: 'custom', message: 'Only a choice field has options.', path: ['options'] });
    if (field.detailKey !== undefined && !isPersonalDetailKey(field.detailKey))
      ctx.addIssue({ code: 'custom', message: 'Unknown personal detail key.', path: ['detailKey'] });
  });
export type FormField = z.infer<typeof formFieldSchema>;

export const formQuestionSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    detail: z.string().trim().max(400).optional(),
    fields: z.array(formFieldSchema).min(1).max(8),
    submitLabel: z.string().trim().min(1).max(32).optional().describe('Default "Continue".'),
  })
  .superRefine((form, ctx) => {
    const ids = new Set<string>();
    for (const [index, field] of form.fields.entries()) {
      if (ids.has(field.id))
        ctx.addIssue({ code: 'custom', message: 'Field ids must be unique.', path: ['fields', index, 'id'] });
      ids.add(field.id);
      if ((field.options || []).filter((option) => option.recommended).length > 1)
        ctx.addIssue({
          code: 'custom',
          message: 'Only one option may be recommended.',
          path: ['fields', index, 'options'],
        });
    }
  });
export type FormQuestion = z.infer<typeof formQuestionSchema>;

/**
 * The value of one answered field:
 * - choice: the chosen option ids (one id when `multiple` is false), and `other` text when given;
 * - name / address / contact: the structured value;
 * - every other kind: a string (`date` is YYYY-MM-DD).
 */
export type FormFieldValue =
  | string
  | { choices: string[]; other?: string }
  | NameValue
  | AddressValue
  | ContactValue;

export const formAnswerSchema = z.object({
  values: z.record(fieldId, z.unknown()),
  /** Save the bound fields to personal details. */
  save: z.boolean(),
  /** The user closed the form without an answer. */
  skipped: z.boolean().optional(),
});
export interface FormAnswer {
  values: Record<string, FormFieldValue>;
  save: boolean;
  skipped?: boolean;
}

/** A planner question (prompt plus options) as a one-field form, so every client renders one shape. */
export function legacyQuestionToForm(question: {
  prompt: string;
  reason?: string | null;
  options?: ReadonlyArray<{ id: string; label: string; description?: string | null }> | null;
}): FormQuestion {
  const options = (question.options || []).slice(0, 8).map((option) => ({
    id: option.id,
    label: option.label,
    ...(option.description ? { detail: option.description } : {}),
  }));
  return {
    title: question.prompt,
    ...(question.reason ? { detail: question.reason } : {}),
    fields: [
      options.length >= 2
        ? { id: 'answer', label: 'Answer', kind: 'choice', options, allowOther: true }
        : { id: 'answer', label: 'Answer', kind: 'text' },
    ],
  };
}

// ---------------------------------------------------------------------------
// The Work thread
// ---------------------------------------------------------------------------

/** The canonical chat session of a Work. Fits the /api/chats id rule (8 to 64 of [A-Za-z0-9_-]). */
export function workThreadSessionId(workId: string): string {
  return `work-${String(workId)
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 59)}`;
}

export function isWorkThreadSessionId(id: string): boolean {
  return /^work-[A-Za-z0-9_-]{3,59}$/.test(id);
}

/**
 * A Work question as the thread shows it. `form` is null for an older
 * question: build one with legacyQuestionToForm(question).
 */
export interface ThreadQuestion {
  id: string;
  form: FormQuestion | null;
  prompt: string;
  reason: string | null;
  options: Array<{ id: string; label: string; description?: string }> | null;
  status: 'pending' | 'answered' | 'dismissed' | 'superseded';
  /** The answer text for an answered question. */
  answer: string | null;
  /** Where the user answered: the form, or a message in the chat. Null while pending. */
  answeredIn: 'form' | 'chat' | null;
}

/** The answer text prefix when a chat message answered a run's question. */
export const CHAT_ANSWER_PREFIX = 'Answered in the chat: ';

/** The form to render for a question. */
export function threadQuestionForm(question: ThreadQuestion): FormQuestion {
  return question.form ?? legacyQuestionToForm(question);
}

/** A run in the thread: the step-runner view (with parentRunId and next.doneLabel) plus its question. */
export type ThreadRunView = StepRunView & {
  question: ThreadQuestion | null;
};

/** GET /api/albatross/work/[workId]/runs */
export interface ThreadRunsResponse {
  ok: true;
  /** Oldest first, at most 30. */
  runs: ThreadRunView[];
}

/** Message metadata that the thread reads. */
export interface ThreadMessageMetadata {
  createdAt?: number;
}

/** Tool names the thread renders specially. */
export const THREAD_TOOLS = {
  /** Starts, continues, steers, or (with stop: true) stops a run. */
  handleStep: 'albatross_handle_step',
  askForm: 'ask_form',
  detailsGet: 'personal_details_get',
  detailsSave: 'personal_details_save',
} as const;

/**
 * The `data-tool-shape` that the thread adds (lib/ai/tool-shapes.ts) for
 * `albatross_handle_step`: the client renders the live run block for `runId`
 * in place. `personal_details_save` uses the existing `receipt` shape
 * (surface `memory`, `target.personalDetails` = keys) with the action
 * `{ kind: 'undo_personal_details', keys }`.
 */
export type ThreadStepRunShape = {
  kind: 'step_run';
  runId: string;
  workId: string;
  action: 'started' | 'resumed' | 'steered';
};

export type ThreadTimelineItem<M> =
  | { kind: 'message'; at: number | null; message: M }
  | { kind: 'run'; at: number; run: ThreadRunView; continues: boolean };

/**
 * Merge the chat messages and the runs into one timeline (docs/albatross-thread.md, "The
 * timeline"). Messages without a time keep their order and come first. A run that a message
 * started renders inside that message, so it is left out here.
 */
export function mergeThreadTimeline<M>(
  messages: readonly M[],
  runs: readonly ThreadRunView[],
  read: { createdAt(message: M): number | null | undefined; startedRunIds(message: M): readonly string[] },
): ThreadTimelineItem<M>[] {
  const inline = new Set<string>();
  for (const message of messages) for (const id of read.startedRunIds(message)) inline.add(id);
  const items: Array<ThreadTimelineItem<M> & { order: number }> = [];
  messages.forEach((message, index) => {
    const at = read.createdAt(message);
    items.push({
      kind: 'message',
      at: typeof at === 'number' && Number.isFinite(at) ? at : null,
      message,
      order: index,
    });
  });
  const byId = new Map(runs.map((run) => [run.id, run]));
  runs.forEach((run, index) => {
    if (inline.has(run.id)) return;
    const continues = Boolean(run.parentRunId && byId.has(run.parentRunId));
    items.push({ kind: 'run', at: run.createdAt, run, continues, order: messages.length + index });
  });
  items.sort((a, b) => {
    if (a.at === null && b.at === null) return a.order - b.order;
    if (a.at === null) return -1;
    if (b.at === null) return 1;
    return a.at - b.at || a.order - b.order;
  });
  return items.map(({ order: _order, ...item }) => item as ThreadTimelineItem<M>);
}

/**
 * Add the messages that a Work thread save merged in from another device to
 * the client's list: unknown ids only, placed by `metadata.createdAt`. A
 * message without a time keeps its place.
 */
export function addMergedThreadMessages<M extends { id?: unknown; metadata?: unknown }>(
  current: readonly M[],
  merged: readonly M[],
): M[] {
  const known = new Set(current.map((message) => String(message.id ?? '')));
  const extra = merged.filter((message) => message.id && !known.has(String(message.id)));
  if (!extra.length) return [...current];
  const timeOf = (message: M) => {
    const at = (message.metadata as ThreadMessageMetadata | undefined)?.createdAt;
    return typeof at === 'number' && Number.isFinite(at) ? at : null;
  };
  const stamp = (list: readonly M[], source: number) => {
    let last = 0;
    return list.map((message, index) => {
      const at = timeOf(message);
      if (at !== null) last = at;
      return { message, at: at ?? last, source, index };
    });
  };
  return [...stamp(current, 0), ...stamp(extra, 1)]
    .sort((a, b) => a.at - b.at || a.source - b.source || a.index - b.index)
    .map((entry) => entry.message);
}
