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
  'calendar_rsvp_event',
  'calendar_get_primary',
  'list_recent_operations',
  'undo_operation',
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

function liftToolsForAgent(operationBatchId?: string): Record<string, any> {
  const lifted: Record<string, any> = {};
  for (const [name, t] of Object.entries(TOOLS)) {
    if (!AGENT_TOOL_NAMES.has(name)) continue;
    lifted[name] = aiTool({
      description: t.description + (t.mutating ? ' (mutating — surfaces a confirmation in the UI)' : ''),
      inputSchema: ((t.input as unknown) ?? z.object({})) as any,
      execute: async (args: unknown) => {
        const context = getAiRequestContext();
        const result = await invokeTool(t, args ?? {}, {
          agent: 'ai',
          userId: context.userId,
          userEmail: context.userEmail,
          userName: context.userName,
          operationBatchId,
        });
        return result;
      },
    });
  }
  return lifted;
}

export interface AgentRunOpts {
  messages: ModelMessage[];
  /** Bias the system prompt with extra context (selected thread, focused account). */
  extraSystem?: string;
  userId?: string | null;
  userEmail?: string | null;
  userName?: string | null;
}

export async function runAgent({ messages, extraSystem, userId, userEmail, userName }: AgentRunOpts) {
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
  const system = extraSystem ? `${base}\n\n${extraSystem}` : base;
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
    tools: liftToolsForAgent(operationBatchId),
    stopWhen: stepCountIs(6),
    onError: (event: any) => {
      // Best-effort logging; don't crash the stream.
      console.error('[agent]', event.error);
    },
  });
  return stream;
}
