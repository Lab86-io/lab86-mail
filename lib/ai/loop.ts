import { tool as aiTool, streamText, stepCountIs, type ModelMessage } from 'ai';
import { z } from 'zod';
import { TOOLS } from '../tools';
import { invokeTool } from '../tools/registry';
import { fastModel, hasAi } from './client';
import { SYSTEM_PROMPT } from './system-prompt';

const AGENT_TOOL_NAMES = new Set([
  'list_accounts',
  'search_threads',
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

function liftToolsForAgent(): Record<string, any> {
  const lifted: Record<string, any> = {};
  for (const [name, t] of Object.entries(TOOLS)) {
    if (!AGENT_TOOL_NAMES.has(name)) continue;
    lifted[name] = aiTool({
      description: t.description + (t.mutating ? ' (mutating — surfaces a confirmation in the UI)' : ''),
      inputSchema: ((t.input as unknown) ?? z.object({})) as any,
      execute: async (args: unknown) => {
        const result = await invokeTool(t, args ?? {}, { agent: 'ai' });
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
}

export function runAgent({ messages, extraSystem }: AgentRunOpts) {
  if (!hasAi()) {
    throw new Error('AI not configured: set OPENAI_API_KEY (or ANTHROPIC_API_KEY).');
  }
  const system = extraSystem ? `${SYSTEM_PROMPT}\n\n${extraSystem}` : SYSTEM_PROMPT;
  const stream = streamText({
    model: fastModel(),
    system,
    messages,
    tools: liftToolsForAgent(),
    stopWhen: stepCountIs(6),
    onError: (event) => {
      // Best-effort logging; don't crash the stream.
      console.error('[agent]', event.error);
    },
  });
  return stream;
}
