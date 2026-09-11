import {
  tool as aiTool,
  createUIMessageStream,
  createUIMessageStreamResponse,
  jsonSchema,
  type ModelMessage,
  stepCountIs,
  streamText,
} from 'ai';
import { z } from 'zod';
import { narrativePrompt } from '../narrative/service';
import { withDeadline } from '../shared/deadline';
import { listMemories } from '../store/memories';
import { TOOLS } from '../tools';
import { invokeTool } from '../tools/registry';
import { getAiRequestContext, runWithAiRequestContext } from './context';
import {
  agentProviderOptions,
  canFailOverAgentRuntime,
  hasPlatformAi,
  maxOutputTokensForFeature,
  recordAgentUsage,
  resolveAgentRuntimes,
} from './gateway';
import { newOperationBatchId } from './operations';
import { buildSystemPrompt } from './system-prompt';
import {
  activeToolNames,
  ENABLE_TOOLS_NAME,
  enabledGroupsFromSteps,
  enableToolsDescription,
  enableToolsInputSchema,
  enableToolsResult,
} from './tool-groups';
import { resolveToolShape, type ToolShape } from './tool-shapes';

/** Search text only, never attachment bytes or opaque tool/image payloads. */
export function narrativeQueryFromContent(content: ModelMessage['content'] | undefined): string {
  return (
    typeof content === 'string'
      ? content
      : (content || [])
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join(' ')
  ).slice(0, 240);
}

export async function boundedAgentNarrativeContext(
  userId: string | null | undefined,
  query: string,
  read = narrativePrompt,
  topics?: string[],
  signal?: AbortSignal,
) {
  const contextSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(8000)]);
  return withDeadline(read(userId, query, topics, contextSignal), 8000, 'Agent narrative context').catch(
    () => '',
  );
}

/** Short follow-ups retain their recent subject without admitting attachment bytes. */
export function narrativeQueryFromMessages(messages: ModelMessage[]): string {
  return messages
    .filter((message) => message.role === 'user')
    .slice(-3)
    .reverse()
    .map((message) => narrativeQueryFromContent(message.content))
    .filter(Boolean)
    .join(' ')
    .slice(0, 240);
}

export const AGENT_TOOL_NAMES = new Set([
  'narrative_search',
  'narrative_task_context',
  'narrative_read',
  'narrative_sources',
  'narrative_changes_since',
  'narrative_record_change',
  'list_accounts',
  'search_threads',
  'corpus_search',
  'sender_profile',
  'corpus_count',
  'thread_timeline',
  'list_smart_category',
  'get_thread',
  'read_thread',
  'get_message',
  'list_labels',
  'list_attachments',
  'archive_thread',
  'trash_thread',
  'mark_read',
  'mark_unread',
  'star',
  'unstar',
  'add_label',
  'remove_label',
  'create_label',
  'mute_thread',
  'snooze_thread',
  'unsnooze_thread',
  'save_draft',
  'update_draft',
  'delete_draft',
  'list_drafts',
  'schedule_send',
  'cancel_scheduled',
  'list_scheduled',
  'undo_send',
  'summarize_thread',
  'triage_thread',
  'draft_reply',
  'bulk_triage',
  'extract_action_items',
  'translate_thread',
  'pre_send_critique',
  'nl_search',
  'remember',
  'recall',
  'forget',
  'list_memories',
  'calendar_free_busy',
  'calendar_suggest_times',
  'calendar_create_event',
  'calendar_list_calendars',
  'calendar_list_events',
  'calendar_search_events',
  'calendar_count_events',
  'calendar_event_detail',
  'calendar_sync_now',
  'calendar_update_event',
  'calendar_delete_event',
  'calendar_delete_recurring_series',
  'calendar_rsvp_event',
  'calendar_get_primary',
  'calendar_unsubscribe_calendar',
  'list_recent_operations',
  'undo_operation',
  'tasks_list_boards',
  'tasks_get_board',
  'tasks_create_board',
  'tasks_create_card',
  'tasks_update_card',
  'tasks_move_card',
  'tasks_delete_card',
  'tasks_create_column',
  'tasks_rename_column',
  'tasks_delete_column',
  'tasks_rename_board',
  'tasks_delete_board',
  'albatross_apply_intent_plan',
  'albatross_list_approval_queue',
  'albatross_create_project',
  'albatross_list_projects',
  'albatross_create_routine',
  'albatross_list_routines',
  'albatross_set_routine_consent',
  'albatross_run_routine_now',
  'albatross_get_project_pane',
  'albatross_create_sprint',
  'albatross_list_sprints',
  'albatross_preview_undo_unresolved',
  'albatross_get_work_context',
  'albatross_record_progress',
  'albatross_replan_work',
  'albatross_split_work',
  'albatross_list_add',
  'albatross_metric_log',
  'albatross_capture_work',
  'area_list',
  'area_create',
  'area_update_identity',
  'area_archive',
  'area_artifact_set_status',
  'area_add_fact',
  'area_fact_set_status',
  'area_domain_activity',
  'area_discover_context',
  'salvage_context',
  'tasks_add_comment',
  'tasks_attach_link',
  'tasks_attach_file',
  'tasks_attach_calendar_event_link',
  'document_create',
  'document_list',
  'document_get',
  'document_edit',
  'document_suggest_changes',
  'document_apply_instruction',
  'document_publish_google',
  'document_export',
  'cloud_file_search',
  'google_file_import',
  'mcp_search',
  'mcp_connection_status',
  'github_search',
  'mcp_list_items',
  'mcp_create_task',
  'contact_lookup',
  'expand_alias',
  'browserbase_search',
  'browserbase_fetch',
  'list_smart_labels',
  'create_smart_label',
  'preview_smart_label',
  'update_smart_label',
  'delete_smart_label',
  'list_smart_rules',
  'create_smart_rule',
  'set_smart_rule_enabled',
  'apply_smart_correction',
  'ui_focus_thread',
  'ui_set_query',
  'ui_open_compose',
  'ui_open_reply',
  'ui_toast',
  'ui_close_bar',
  'ui_switch_account',
  // Display tools (lib/tools/display.ts) — rich tool-ui renderings in chat.
  'show_weather',
  'show_chart',
  'show_stats',
  'show_table',
  'show_code',
  'show_code_diff',
  'show_terminal',
  'show_plan',
  'show_progress',
  'show_citations',
  'show_link_preview',
  'show_image',
  'show_image_gallery',
  'show_video',
  'show_audio',
  'show_map',
  'show_carousel',
  'show_order_summary',
  'show_social_post',
  'show_message_draft',
  'show_email_preview',
]);

const AGENT_TOOL_TIMEOUT_MS = 75_000;
const ALBATROSS_REPLAN_TIMEOUT_MS = 210_000;

type UiStreamWriter = Parameters<Parameters<typeof createUIMessageStream>[0]['execute']>[0]['writer'];

async function withToolTimeout<T>(promise: Promise<T>, toolName: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutMs =
    toolName === 'albatross_replan_work' ? ALBATROSS_REPLAN_TIMEOUT_MS : AGENT_TOOL_TIMEOUT_MS;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${toolName} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The JSON schema the model sees for a registry tool. Regex patterns are
 * dropped: the OpenAI Responses API rejects lookarounds (zod's email pattern
 * has one), and the registry re-validates every call with the real zod schema
 * in invokeTool, so the model-facing schema only needs shape and descriptions.
 */
export function modelInputSchema(input: unknown) {
  const schema = (input as z.ZodTypeAny | undefined) ?? z.object({});
  let json: Record<string, unknown>;
  try {
    json = z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' }) as Record<string, unknown>;
  } catch {
    return schema as any;
  }
  return jsonSchema(stripPatterns(json) as any);
}

export function stripPatterns<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripPatterns) as T;
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'pattern' && typeof entry === 'string') continue;
    out[key] = stripPatterns(entry);
  }
  return out as T;
}

export function liftToolsForAgent(operationBatchId?: string, userTimezone?: string): Record<string, any> {
  const lifted: Record<string, any> = {};
  for (const [name, t] of Object.entries(TOOLS)) {
    if (!AGENT_TOOL_NAMES.has(name)) continue;
    lifted[name] = aiTool({
      description: t.description + (t.mutating ? ' (mutating — surfaces a confirmation in the UI)' : ''),
      inputSchema: modelInputSchema(t.input),
      execute: async (args: unknown) => {
        const context = getAiRequestContext();
        const result = await withToolTimeout(
          invokeTool(t, args ?? {}, {
            agent: 'ai',
            userId: context.userId,
            userEmail: context.userEmail,
            userName: context.userName,
            operationBatchId,
            userTimezone,
          }),
          name,
        );
        return result;
      },
    });
  }
  // Human-in-the-loop tools. Deliberately have NO execute: the stream pauses
  // on the tool call until the client renders the form and supplies the
  // answer via addToolResult, after which the agent continues with it.
  lifted.ask_user = aiTool({
    description:
      "Ask the user up to 4 questions at once and WAIT for their answers before continuing. Each question MAY offer 2–6 quick options, but the user can ALWAYS also type a free-text answer — so include options only when there is a clear, finite set of choices, and OMIT options for open-ended questions (times, names, amounts). Set multiSelect: true when several options can apply at once ('which of these?'); the user can then pick multiple (including shift-click ranges). Never pack several distinct questions into one question's options — give each its own entry in `questions`. Reach for this whenever you are unsure, must choose between approaches, or want to offer to dive deeper.",
    inputSchema: z.object({
      questions: z
        .array(
          z.object({
            question: z.string().describe('The question to ask.'),
            options: z
              .array(z.object({ label: z.string(), description: z.string().optional() }))
              .min(2)
              .max(6)
              .optional()
              .describe('Optional 2–6 quick choices. Omit entirely for a free-text question.'),
            multiSelect: z
              .boolean()
              .optional()
              .describe('Allow choosing more than one option (answers arrive comma-separated).'),
            minSelections: z.number().int().min(0).optional().describe('Multi-select only.'),
            maxSelections: z.number().int().min(1).optional().describe('Multi-select only.'),
          }),
        )
        .min(1)
        .max(4)
        .describe('1–4 distinct questions, asked together. Each can be choice-based or free-text.'),
    }),
  });
  // A yes/no gate for one consequential action. Renders an approval card and
  // waits. Output: { decision: 'approved' | 'denied' }.
  lifted.ask_approval = aiTool({
    description:
      "Ask the user to approve or deny ONE consequential action before you take it (send on their behalf, delete something, notify attendees). Renders an approval card and WAITS. Use ask_user for open questions; use this only for a binary go/no-go. State exactly what will happen in `description`; add metadata rows for the key facts (recipient, when, how many). Set intent: 'destructive' for irreversible actions.",
    inputSchema: z.object({
      title: z.string().describe("What you want to do, e.g. 'Send the reply to Sam'."),
      description: z.string().optional().describe('One or two sentences on exactly what will happen.'),
      metadata: z
        .array(z.object({ label: z.string(), value: z.string() }))
        .max(6)
        .optional()
        .describe('Key facts as label/value rows.'),
      confirmLabel: z.string().optional().describe("Verb-first, e.g. 'Send it'. Defaults to 'Approve'."),
      denyLabel: z.string().optional().describe("Defaults to 'Cancel'."),
      intent: z.enum(['default', 'destructive']).optional(),
    }),
  });
  // Numeric parameters via sliders. Output: { values: { [sliderId]: number } }.
  lifted.ask_parameters = aiTool({
    description:
      'Ask the user to tune 1–4 NUMERIC parameters with sliders (budget, radius, count, duration) and WAIT for the confirmed values. Give each slider a sensible min/max/step and a starting value. Output arrives as { values: { [id]: number } }.',
    inputSchema: z.object({
      title: z.string().optional(),
      sliders: z
        .array(
          z.object({
            id: z.string().describe('Stable key for the value, e.g. "budget".'),
            label: z.string(),
            min: z.number(),
            max: z.number(),
            step: z.number().positive().optional(),
            value: z.number().describe('Starting value, within min..max.'),
            unit: z.string().optional().describe("e.g. '$', 'mi', 'min'."),
          }),
        )
        .min(1)
        .max(4),
    }),
  });
  // A compact settings form (switches, toggles, selects). Output:
  // { values: { [itemId]: string | boolean } }.
  lifted.ask_preferences = aiTool({
    description:
      'Ask the user to set several related preferences at once in a compact settings panel and WAIT. Items are switches (boolean), toggles (2–4 exclusive options), or selects (5+ options). Use for "how do you want this to behave" batches — notification choices, defaults, filters. Output arrives as { values: { [itemId]: string | boolean } }.',
    inputSchema: z.object({
      title: z.string().optional(),
      items: z
        .array(
          z.discriminatedUnion('type', [
            z.object({
              type: z.literal('switch'),
              id: z.string(),
              label: z.string(),
              description: z.string().optional(),
              defaultChecked: z.boolean().optional(),
            }),
            z.object({
              type: z.literal('toggle'),
              id: z.string(),
              label: z.string(),
              description: z.string().optional(),
              options: z
                .array(z.object({ value: z.string(), label: z.string() }))
                .min(2)
                .max(4),
              defaultValue: z.string().optional(),
            }),
            z.object({
              type: z.literal('select'),
              id: z.string(),
              label: z.string(),
              description: z.string().optional(),
              selectOptions: z.array(z.object({ value: z.string(), label: z.string() })).min(5),
              defaultSelected: z.string().optional(),
            }),
          ]),
        )
        .min(1)
        .max(8),
    }),
  });
  // A guided multi-step choice flow (one question per screen, no free text).
  // Output: { answers: [{ question, response }] } — same shape as ask_user.
  lifted.ask_question_flow = aiTool({
    description:
      'Walk the user through 2–5 guided choice questions ONE STEP AT A TIME (a stepper with progress) and WAIT for all answers. Every step must have 2–6 options — there is NO free-text escape here, so use ask_user instead when an open answer is plausible. Best for setup/configuration sequences where each step is a clean pick.',
    inputSchema: z.object({
      steps: z
        .array(
          z.object({
            title: z.string().describe('The question for this step.'),
            description: z.string().optional(),
            options: z
              .array(z.object({ label: z.string(), description: z.string().optional() }))
              .min(2)
              .max(6),
            multiSelect: z.boolean().optional(),
          }),
        )
        .min(2)
        .max(5),
    }),
  });
  // On-demand tool groups (lib/ai/tool-groups.ts). The call itself is the
  // signal: prepareStep reads enable_tools calls from earlier steps and widens
  // the active set for the next one.
  lifted[ENABLE_TOOLS_NAME] = aiTool({
    description: enableToolsDescription(),
    inputSchema: enableToolsInputSchema,
    execute: async ({ groups }: { groups: string[] }) => enableToolsResult(groups),
  });
  return lifted;
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return 'Tool call failed';
  }
}

// Auth-failure diagnostics can carry bearer tokens or submitted key material —
// non-Error objects stringify request metadata. Redact before logging.
export function safeAuthErrorText(error: unknown): string {
  return errorText(error)
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/\bsk-(?:or-v1-|ant-)?[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_API_KEY]');
}

export function isRecoverableAgentProviderError(error: any): boolean {
  const message = String(error?.message || error || '');
  const statusCode = Number(error?.statusCode ?? error?.status ?? error?.response?.status);
  const responseBody = String(error?.responseBody || '');
  const looksLikeProviderError =
    error?.provider ||
    error?.statusCode !== undefined ||
    error?.responseBody ||
    error?.isRetryable !== undefined;
  return (
    (/invalid json response|could not parse response/i.test(message) && looksLikeProviderError) ||
    (/unexpected end of json|unexpected token/i.test(message) && responseBody) ||
    statusCode === 429 ||
    statusCode >= 500 ||
    /provider returned error|temporarily unavailable|rate.?limit/i.test(responseBody)
  );
}

// A rejected/missing API key is NOT a transient provider hiccup — retrying or
// falling back can't fix it, and routing it through providerFailureResult hides
// the real problem behind "malformed response". Detect it so we can tell the
// user exactly what to do.
export function isAuthError(error: any): boolean {
  const statusCode = Number(error?.statusCode ?? error?.status ?? error?.response?.status);
  const haystack = `${error?.message || ''} ${error?.responseBody || ''}`.toLowerCase();
  const hasAuthSignal =
    /invalid api key|incorrect api key|invalid_api_key|no auth credentials|unauthorized|authentication (failed|error)|missing.*api key|api key.*(missing|invalid|expired)/.test(
      haystack,
    );
  // 401 is unambiguously auth. A bare 403 is NOT — it can mean model access,
  // billing/project limits, policy, or region — so only treat 403 as an auth
  // failure when the message also looks like a key problem.
  return statusCode === 401 || hasAuthSignal;
}

function authFailureResult(error: any) {
  const text =
    'Your AI provider rejected the API key (auth error). Open Settings → AI and re-enter a valid OpenRouter, OpenAI, or Anthropic key — then retry. Nothing was changed.';
  console.error(`[ai] auth failure: ${safeAuthErrorText(error)}`);
  return {
    text,
    finishReason: 'stop',
    steps: [{ stepNumber: 0, content: [{ type: 'text', text }] }],
  };
}

function providerFailureResult(error: any) {
  const text = /invalid json response/i.test(String(error?.message || ''))
    ? 'The AI provider returned a malformed response after the request started, so I could not produce a reliable final answer. The agent stayed connected; please check whether the requested change is already reflected, then retry only if it is missing.'
    : 'The AI provider failed while finishing that request. The agent stayed connected; please retry the last step if the requested change is not visible.';
  // Keep raw provider diagnostics out of the user-facing text; log for triage.
  console.error(`[ai] provider failure while finishing request: ${errorText(error)}`);
  return {
    text,
    finishReason: 'stop',
    steps: [
      {
        stepNumber: 0,
        content: [{ type: 'text', text }],
      },
    ],
  };
}

type UiChunk = { type: string; [key: string]: any };

/** Chunk types that mean the model produced something the user can see. */
const CONTENT_CHUNK_TYPES = new Set([
  'text-delta',
  'reasoning-delta',
  'tool-input-start',
  'tool-input-delta',
  'tool-input-available',
  'tool-input-error',
  'tool-output-available',
  'tool-output-error',
  'tool-approval-request',
  'source-url',
  'source-document',
  'file',
]);

export interface ForwardAgentStreamResult {
  /** True once at least one content chunk reached the client. */
  forwarded: boolean;
  /** The provider error captured by the stream, if any. */
  error: unknown;
}

/**
 * Forward one runtime's UI message stream to the client writer.
 *
 * Chunks are held back until the first content chunk, so a runtime that fails
 * before it says anything leaves no trace and the caller can try the next
 * runtime. Once content has been forwarded the stream is committed: later
 * errors are written through so the client can show them and offer Continue.
 */
export async function forwardAgentStream(
  writer: UiStreamWriter,
  chunks: AsyncIterable<UiChunk>,
  readError: () => unknown = () => undefined,
  resolveShape: ShapeResolver = resolveToolShape,
): Promise<ForwardAgentStreamResult> {
  const pending: UiChunk[] = [];
  const calls = new Map<string, { toolName: string; input?: unknown }>();
  let forwarded = false;
  const emit = (chunk: UiChunk) => {
    if (!forwarded && CONTENT_CHUNK_TYPES.has(chunk.type)) {
      forwarded = true;
      for (const held of pending) writer.write(held as any);
      pending.length = 0;
    }
    if (forwarded) writer.write(chunk as any);
    else pending.push(chunk);
  };
  for await (const chunk of chunks) {
    if (chunk.type === 'error') {
      if (!forwarded) return { forwarded: false, error: readError() ?? new Error(chunk.errorText) };
      writer.write(chunk as any);
      continue;
    }
    if (chunk.type === 'tool-input-start' && chunk.toolCallId && chunk.toolName) {
      calls.set(chunk.toolCallId, { toolName: chunk.toolName });
    } else if (chunk.type === 'tool-input-available' && chunk.toolCallId && chunk.toolName) {
      calls.set(chunk.toolCallId, { toolName: chunk.toolName, input: chunk.input });
    }
    emit(chunk);
    // Every tool result carries a display shape beside it, so web and native
    // render the same card from the same data without re-deriving it.
    if (chunk.type === 'tool-output-available' && chunk.toolCallId) {
      const call = calls.get(chunk.toolCallId);
      if (!call) continue;
      let shape: ToolShape | null = null;
      try {
        shape = resolveShape(call.toolName, call.input, chunk.output);
      } catch (error) {
        console.warn('[agent] shape resolution failed', { tool: call.toolName, error: errorText(error) });
      }
      if (shape) {
        emit({ type: 'data-tool-shape', id: chunk.toolCallId, data: shape });
      }
    }
  }
  return { forwarded, error: readError() };
}

export type ShapeResolver = (toolName: string, input: unknown, output: unknown) => ToolShape | null;

function writeTextOnly(writer: UiStreamWriter, id: string, text: string) {
  writer.write({ type: 'start-step' });
  writer.write({ type: 'text-start', id });
  writer.write({ type: 'text-delta', id, delta: text });
  writer.write({ type: 'text-end', id });
  writer.write({ type: 'finish-step' });
}

interface AgentStreamOptions {
  userId?: string | null;
  system: string;
  messages: ModelMessage[];
  tools: Record<string, any>;
  /** Tool groups active from the first step (from the chat scope). */
  toolGroups?: string[];
  signal?: AbortSignal;
}

/**
 * The active tool names for a step: core tools plus the scope groups plus any
 * group the model enabled in an earlier step of this turn.
 */
export function activeToolsForStep(
  toolNames: Iterable<string>,
  initialGroups: readonly string[],
  steps: ReadonlyArray<{ content?: unknown }>,
): string[] {
  return activeToolNames(toolNames, [...initialGroups, ...enabledGroupsFromSteps(steps)]);
}

/**
 * Run the agent turn as a live stream. Walks the runtime chain: a runtime that
 * fails (or finishes empty) before any content was forwarded is dropped and
 * the next one starts. Resolves with the completed steps for post-turn work.
 */
async function streamAgentTurn(writer: UiStreamWriter, options: AgentStreamOptions): Promise<any[]> {
  const feature = 'agent';
  const runtimes = await resolveAgentRuntimes({ userId: options.userId, speed: 'primary', feature });
  const promptCacheKey = options.userId ? `agent:${options.userId}` : undefined;
  let lastError: unknown;

  for (let index = 0; index < runtimes.length; index += 1) {
    const runtime = runtimes[index];
    let streamError: unknown;
    const toolNames = Object.keys(options.tools);
    const initialGroups = options.toolGroups ?? [];
    const result = streamText({
      model: runtime.model,
      system: options.system,
      messages: options.messages,
      tools: options.tools,
      activeTools: activeToolsForStep(toolNames, initialGroups, []),
      prepareStep: ({ steps }) => ({ activeTools: activeToolsForStep(toolNames, initialGroups, steps) }),
      abortSignal: options.signal,
      // Multi-step flows (fetch a file → store → attach → send) need headroom
      // beyond the old 6-step cap.
      stopWhen: stepCountIs(20),
      // Tiered per-step ceiling (never unbounded → avoids the 65536 reservation
      // that OpenRouter 402s on); leaves room for reasoning + a reply.
      maxOutputTokens: maxOutputTokensForFeature(feature),
      providerOptions: agentProviderOptions(runtime, promptCacheKey),
      onError: ({ error }) => {
        streamError = streamError ?? error;
      },
    });
    const uiStream = result.toUIMessageStream({
      sendStart: false,
      sendFinish: false,
      sendReasoning: true,
      sendSources: true,
      onError: (error) => {
        streamError = streamError ?? error;
        return errorText(error);
      },
    });
    const outcome = await forwardAgentStream(writer, uiStream as AsyncIterable<UiChunk>, () => streamError);
    const steps = await Promise.resolve(result.steps).catch(() => [] as any[]);
    const usage = await Promise.resolve(result.totalUsage).catch(() => undefined);
    const finishReason = await Promise.resolve(result.finishReason).catch(() => 'error');

    if (outcome.forwarded) {
      await recordAgentUsage(
        runtime,
        feature,
        usage,
        !outcome.error,
        outcome.error ? errorText(outcome.error) : undefined,
      );
      return steps;
    }

    lastError = outcome.error ?? new Error(`empty completion (${finishReason})`);
    await recordAgentUsage(runtime, feature, usage, false, errorText(lastError));
    if (options.signal?.aborted || isAuthError(lastError)) throw lastError;
    const hasNext = index < runtimes.length - 1;
    const eligible = outcome.error ? canFailOverAgentRuntime(outcome.error, feature, runtime) : true;
    if (hasNext && eligible) {
      console.warn('[agent] runtime produced nothing; trying fallback', {
        provider: runtime.provider,
        model: runtime.modelName,
        fallback: runtimes[index + 1]?.modelName,
        error: errorText(lastError),
      });
      continue;
    }
    throw lastError;
  }
  throw lastError ?? new Error('No agent runtime available');
}

export interface AgentRunOpts {
  messages: ModelMessage[];
  /** Bias the system prompt with extra context (selected thread, focused account). */
  extraSystem?: string;
  userId?: string | null;
  userEmail?: string | null;
  userName?: string | null;
  /** IANA timezone reported by the client (e.g. America/New_York). */
  userTimezone?: string;
  narrativeTopics?: string[];
  /** Tool groups active from the first step (lib/ai/tool-groups.ts). */
  toolGroups?: string[];
  signal?: AbortSignal;
}

export interface AgentRun {
  /** Completed generation steps, resolved when the stream finishes (empty on failure). */
  steps: Promise<any[]>;
  toUIMessageStreamResponse(): Response;
}

/** Wall-clock grounding, rounded to the minute so the prompt prefix stays cacheable across steps. */
export function agentTimeContext(timezone: string, now = new Date()): string {
  const rounded = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const localNow = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(rounded);
  return `The user's timezone is ${timezone}. The current time there is ${localNow}. When passing ISO timestamps to tools, either include the correct UTC offset for that timezone or pass a naive timestamp (no Z, no offset) — naive timestamps are interpreted in the user's timezone. Never append Z to a local wall-clock time.`;
}

export async function runAgent({
  messages,
  extraSystem,
  userId,
  userEmail,
  userName,
  userTimezone,
  narrativeTopics,
  toolGroups,
  signal,
}: AgentRunOpts): Promise<AgentRun> {
  if (!hasPlatformAi() && !userId) {
    throw new Error(
      'AI not configured: set OPENROUTER_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, or sign in and add an API key.',
    );
  }
  const requestContext = { userId, userEmail, userName, agent: 'ai' as const };
  // Memories are injected at conversation start so remembered facts and
  // preferences are ALWAYS in play — the recall tool remains for ad-hoc
  // lookups, but the agent never starts blind. Memories and narrative context
  // are independent reads, so they run together.
  // One batch id per agent turn: every mutating tool call inside this run
  // records its operation under it, forming a single undoable change-set.
  const operationBatchId = newOperationBatchId();
  const timezone = userTimezone || 'UTC';
  const tools = liftToolsForAgent(operationBatchId, timezone);

  let resolveSteps: (steps: any[]) => void = () => undefined;
  const steps = new Promise<any[]>((resolve) => {
    resolveSteps = resolve;
  });

  return {
    steps,
    toUIMessageStreamResponse() {
      return createUIMessageStreamResponse({
        stream: createUIMessageStream({
          execute: async ({ writer }) => {
            writer.write({ type: 'start' });
            let completed: any[] = [];
            try {
              const memoryQuery = narrativeQueryFromMessages(messages);
              const [memories, narrative] = await Promise.all([
                userId
                  ? runWithAiRequestContext(requestContext, () => listMemories().catch(() => [])).then(
                      (rows) => rows.slice(0, 30).map((row) => ({ email: row.email, notes: row.notes })),
                    )
                  : Promise.resolve([]),
                boundedAgentNarrativeContext(userId, memoryQuery, narrativePrompt, narrativeTopics, signal),
              ]);
              signal?.throwIfAborted();
              const base = buildSystemPrompt({ name: userName, email: userEmail }, { memories });
              // Static instructions first, per-turn context last: providers cache the
              // shared prefix, so the parts that change every turn sit at the end.
              const system = [base, extraSystem, narrative, agentTimeContext(timezone)]
                .filter(Boolean)
                .join('\n\n');

              completed = await runWithAiRequestContext(requestContext, () =>
                streamAgentTurn(writer, { userId, system, messages, tools, toolGroups, signal }),
              );
              writer.write({ type: 'finish', finishReason: 'stop' });
            } catch (err: any) {
              if (signal?.aborted) {
                writer.write({ type: 'abort' });
                return;
              }
              // Auth errors get a clear "fix your key" message instead of being
              // masked as a transient failure or thrown as an opaque provider string.
              if (isAuthError(err)) {
                console.warn('[agent] auth error; returning key-fix guidance', safeAuthErrorText(err));
                writeTextOnly(writer, 'text-auth', authFailureResult(err).text);
                writer.write({ type: 'finish', finishReason: 'stop' });
              } else if (isRecoverableAgentProviderError(err)) {
                console.warn(
                  '[agent] provider failed after retries; returning text fallback',
                  errorText(err),
                );
                writeTextOnly(writer, 'text-provider', providerFailureResult(err).text);
                writer.write({ type: 'finish', finishReason: 'stop' });
              } else {
                throw err;
              }
            } finally {
              resolveSteps(completed);
            }
          },
          onError: (error) => {
            console.error('[agent]', error);
            return errorText(error);
          },
        }),
      });
    },
  };
}
