import { tool as aiTool, type ModelMessage, stepCountIs } from 'ai';
import { z } from 'zod';
import { listMemories } from '../store/memories';
import { TOOLS } from '../tools';
import { invokeTool } from '../tools/registry';
import { getAiRequestContext, runWithAiRequestContext } from './context';
import { hasPlatformAi, streamTextForUser } from './gateway';
import { newOperationBatchId } from './operations';
import { buildSystemPrompt } from './system-prompt';

const AGENT_TOOL_NAMES = new Set([
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
  'tasks_add_comment',
  'tasks_attach_link',
  'tasks_attach_file',
  'tasks_attach_calendar_event_link',
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
]);

const AGENT_TOOL_TIMEOUT_MS = 75_000;

async function withToolTimeout<T>(promise: Promise<T>, toolName: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${toolName} timed out after ${Math.round(AGENT_TOOL_TIMEOUT_MS / 1000)}s`));
    }, AGENT_TOOL_TIMEOUT_MS);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function liftToolsForAgent(operationBatchId?: string, userTimezone?: string): Record<string, any> {
  const lifted: Record<string, any> = {};
  for (const [name, t] of Object.entries(TOOLS)) {
    if (!AGENT_TOOL_NAMES.has(name)) continue;
    lifted[name] = aiTool({
      description: t.description + (t.mutating ? ' (mutating — surfaces a confirmation in the UI)' : ''),
      inputSchema: ((t.input as unknown) ?? z.object({})) as any,
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
  // Human-in-the-loop question. Deliberately has NO execute: the stream pauses
  // on this tool call until the client renders the choices and supplies the
  // answer via addToolResult, after which the agent continues with it.
  lifted.ask_user = aiTool({
    description:
      "Ask the user up to 4 questions at once and WAIT for their answers before continuing. Each question MAY offer 2–4 quick options, but the user can ALWAYS also type a free-text answer — so include options only when there is a clear, finite set of choices, and OMIT options for open-ended questions (times, names, amounts). Never pack several distinct questions into one question's options — give each its own entry in `questions`. Reach for this whenever you are unsure, must choose between approaches, or want to offer to dive deeper.",
    inputSchema: z.object({
      questions: z
        .array(
          z.object({
            question: z.string().describe('The question to ask.'),
            options: z
              .array(z.object({ label: z.string(), description: z.string().optional() }))
              .min(2)
              .max(4)
              .optional()
              .describe('Optional 2–4 quick choices. Omit entirely for a free-text question.'),
            multiSelect: z.boolean().optional().describe('Allow choosing more than one option.'),
          }),
        )
        .min(1)
        .max(4)
        .describe('1–4 distinct questions, asked together. Each can be choice-based or free-text.'),
    }),
  });
  return lifted;
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
}

export async function runAgent({
  messages,
  extraSystem,
  userId,
  userEmail,
  userName,
  userTimezone,
}: AgentRunOpts) {
  if (!hasPlatformAi() && !userId) {
    throw new Error(
      'AI not configured: set OPENROUTER_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, or sign in and add an API key.',
    );
  }
  // Memories are injected at conversation start so remembered facts and
  // preferences are ALWAYS in play — the recall tool remains for ad-hoc
  // lookups, but the agent never starts blind.
  const memories = userId
    ? await runWithAiRequestContext({ userId, userEmail, userName, agent: 'ai' }, () =>
        listMemories().catch(() => []),
      ).then((rows) => rows.slice(0, 30).map((row) => ({ email: row.email, notes: row.notes })))
    : [];
  const base = buildSystemPrompt({ name: userName, email: userEmail }, { memories });
  // Wall-clock grounding: without this the model guesses UTC and "2:30"
  // lands hours off on the user's real calendar.
  const timezone = userTimezone || 'UTC';
  const localNow = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    dateStyle: 'full',
    timeStyle: 'long',
  }).format(new Date());
  const timeContext = `The user's timezone is ${timezone}. The current time there is ${localNow}. When passing ISO timestamps to tools, either include the correct UTC offset for that timezone or pass a naive timestamp (no Z, no offset) — naive timestamps are interpreted in the user's timezone. Never append Z to a local wall-clock time.`;
  const system = `${base}\n\n${timeContext}${extraSystem ? `\n\n${extraSystem}` : ''}`;
  // One batch id per agent turn: every mutating tool call inside this run
  // records its operation under it, forming a single undoable change-set.
  const operationBatchId = newOperationBatchId();
  const stream = await streamTextForUser({
    userId,
    userEmail,
    userName,
    feature: 'agent',
    speed: 'fast',
    system,
    messages,
    tools: liftToolsForAgent(operationBatchId, timezone),
    // Multi-step flows (fetch a file → store → attach → send) need headroom
    // beyond the old 6-step cap.
    stopWhen: stepCountIs(20),
    onError: (event: any) => {
      // Best-effort logging; don't crash the stream.
      console.error('[agent]', event.error);
    },
  });
  return stream;
}
