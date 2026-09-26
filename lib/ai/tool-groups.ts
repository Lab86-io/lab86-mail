// Per-step tool selection for the chat agent.
//
// The agent defines ~175 tools, but a model step should carry far fewer:
// OpenAI's direct Chat Completions API rejects more than 128 tool
// definitions outright, and every definition is prefill the provider bills
// and reads on every step. A CORE set is always active. The rest sits in
// named groups that turn on for the chat scope (a Work or Area context) or
// when the model asks for them through the `enable_tools` tool. The active
// set never exceeds MAX_ACTIVE_TOOLS. Scope groups always stay; when a
// requested group does not fit, the least recently requested group is
// dropped first, and enable_tools reports what it dropped.

import { z } from 'zod';

export const MAX_ACTIVE_TOOLS = 128;
export const ENABLE_TOOLS_NAME = 'enable_tools';

export const TOOL_GROUPS = {
  projects_routines: {
    label: 'Albatross projects, sprints, routines, approvals, and intent plans',
    tools: [
      'albatross_apply_intent_plan',
      'albatross_list_approval_queue',
      'albatross_create_project',
      'albatross_create_routine',
      'albatross_list_routines',
      'albatross_set_routine_consent',
      'albatross_run_routine_now',
      'albatross_get_project_pane',
      'albatross_create_sprint',
      'albatross_list_sprints',
      'albatross_split_work',
    ],
  },
  areas: {
    label: 'Area identity, facts, artifact status, and discovery',
    tools: [
      'area_create',
      'area_update_identity',
      'area_archive',
      'area_artifact_set_status',
      'area_add_fact',
      'area_fact_set_status',
      'area_domain_activity',
      'area_discover_context',
    ],
  },
  smart_labels: {
    label: 'Smart labels, rules, and classification corrections',
    tools: [
      'list_smart_labels',
      'create_smart_label',
      'preview_smart_label',
      'update_smart_label',
      'delete_smart_label',
      'list_smart_rules',
      'create_smart_rule',
      'set_smart_rule_enabled',
      'apply_smart_correction',
    ],
  },
  narrative: {
    label: 'Narrative memory search, reads, and change records',
    tools: [
      'narrative_search',
      'narrative_task_context',
      'narrative_read',
      'narrative_sources',
      'narrative_changes_since',
      'narrative_record_change',
    ],
  },
  documents_more: {
    label: 'Document proposals, broad edits, Google publish, and export',
    tools: [
      'document_suggest_changes',
      'document_apply_instruction',
      'document_review_slides',
      'document_publish_google',
      'document_export',
      'word_document_create',
      'word_document_get',
      'word_document_edit',
    ],
  },
  board_admin: {
    label: 'Task board and column administration, card deletion, and calendar links on cards',
    tools: [
      'tasks_delete_card',
      'tasks_attach_calendar_event_link',
      'tasks_create_board',
      'tasks_rename_board',
      'tasks_delete_board',
      'tasks_create_column',
      'tasks_rename_column',
      'tasks_delete_column',
    ],
  },
  calendar_admin: {
    label: 'Calendar sync, primary lookup, series deletion, and unsubscribe',
    tools: [
      'calendar_sync_now',
      'calendar_get_primary',
      'calendar_delete_recurring_series',
      'calendar_unsubscribe_calendar',
    ],
  },
  mail_more: {
    label:
      "Scheduled send list and cancel, snoozed mail list, undo send, the user's saved replies, natural-language search, bulk triage, bulk archive or trash, translation, critique, action items, thread timeline",
    tools: [
      'bulk_move_threads',
      'list_saved_replies',
      'list_scheduled',
      'cancel_scheduled',
      'list_snoozed',
      'undo_send',
      'nl_search',
      'bulk_triage',
      'translate_thread',
      'pre_send_critique',
      'extract_action_items',
      'thread_timeline',
    ],
  },
  mail_admin: {
    label: 'Label creation, thread mute, memory list and delete, alias expansion',
    tools: ['create_label', 'mute_thread', 'list_memories', 'forget', 'expand_alias'],
  },
  cloud_files: {
    label: 'Google Drive and OneDrive file search, Google document reads and edits, and file import',
    tools: ['cloud_file_search', 'google_document_get', 'google_document_edit', 'google_file_import'],
  },
  ui_extras: {
    label: 'Web app toast notices and mailbox account switch',
    tools: ['ui_toast', 'ui_switch_account'],
  },
  display_media: {
    label:
      'Media and place cards: weather, code diff, terminal, images, video, audio, map, carousel, order summary, social post',
    tools: [
      'show_weather',
      'show_code_diff',
      'show_terminal',
      'show_image',
      'show_image_gallery',
      'show_video',
      'show_audio',
      'show_map',
      'show_carousel',
      'show_order_summary',
      'show_social_post',
    ],
  },
  ask_forms: {
    label: 'Structured asks: sliders, preference panels, and multi-step question flows',
    tools: ['ask_parameters', 'ask_preferences', 'ask_question_flow'],
  },
} as const satisfies Record<string, { label: string; tools: readonly string[] }>;

export type ToolGroupName = keyof typeof TOOL_GROUPS;
export const TOOL_GROUP_NAMES = Object.keys(TOOL_GROUPS) as ToolGroupName[];

const GROUPED_TOOL_NAMES = new Set<string>(TOOL_GROUP_NAMES.flatMap((name) => [...TOOL_GROUPS[name].tools]));

export function isToolGroupName(value: unknown): value is ToolGroupName {
  return typeof value === 'string' && value in TOOL_GROUPS;
}

/** Every defined tool name that is not in a group is core and always active. */
export function coreToolNames(allToolNames: Iterable<string>): string[] {
  return [...allToolNames].filter((name) => !GROUPED_TOOL_NAMES.has(name));
}

/** Which groups are active for one step, and which requested groups were dropped. */
export interface ToolGroupPlan {
  active: string[];
  groups: ToolGroupName[];
  evicted: ToolGroupName[];
}

/**
 * The active tool names for one step: core, then the scope groups, then the
 * requested groups. Scope groups are never dropped. When the total would pass
 * MAX_ACTIVE_TOOLS, the newest requests that fit stay and older ones drop.
 */
export function planToolGroups(
  allToolNames: Iterable<string>,
  requestedGroups: readonly string[],
  scopeGroups: readonly string[] = [],
): ToolGroupPlan {
  const defined = new Set(allToolNames);
  const core = coreToolNames(defined);
  const scope = dedupe(scopeGroups.filter(isToolGroupName));
  const requested = dedupe(requestedGroups.filter(isToolGroupName)).filter((name) => !scope.includes(name));
  const sizeOf = (name: ToolGroupName) => TOOL_GROUPS[name].tools.filter((tool) => defined.has(tool)).length;
  let budget = MAX_ACTIVE_TOOLS - core.length - scope.reduce((sum, name) => sum + sizeOf(name), 0);
  // Keep the newest requests that fit, walking back from the most recent one.
  const kept: ToolGroupName[] = [];
  const evicted: ToolGroupName[] = [];
  for (let index = requested.length - 1; index >= 0; index -= 1) {
    const name = requested[index];
    const size = sizeOf(name);
    if (size <= budget) {
      kept.unshift(name);
      budget -= size;
    } else evicted.unshift(name);
  }
  const groups = [...scope, ...kept];
  const active = new Set(core);
  for (const name of groups)
    for (const tool of TOOL_GROUPS[name].tools) if (defined.has(tool)) active.add(tool);
  return { active: [...active], groups, evicted };
}

/** The active tool names for one step (see planToolGroups). */
export function activeToolNames(
  allToolNames: Iterable<string>,
  requestedGroups: readonly string[],
  scopeGroups: readonly string[] = [],
): string[] {
  return planToolGroups(allToolNames, requestedGroups, scopeGroups).active;
}

function dedupe(names: ToolGroupName[]): ToolGroupName[] {
  const out: ToolGroupName[] = [];
  for (const name of names) {
    const index = out.indexOf(name);
    if (index !== -1) out.splice(index, 1);
    out.push(name);
  }
  return out;
}

/** Groups the chat scope turns on before the first step. */
export function initialToolGroups(scope: {
  hasWorkContext?: boolean;
  hasAreaContext?: boolean;
  narrativeEnabled?: boolean;
}): ToolGroupName[] {
  const groups: ToolGroupName[] = [];
  if (scope.narrativeEnabled) groups.push('narrative');
  if (scope.hasAreaContext) groups.push('areas');
  if (scope.hasWorkContext) groups.push('projects_routines');
  return groups;
}

/** Groups the model enabled through `enable_tools` calls in earlier steps, in call order. */
export function enabledGroupsFromSteps(steps: ReadonlyArray<{ content?: unknown }>): ToolGroupName[] {
  const groups: ToolGroupName[] = [];
  for (const step of steps) {
    const content = Array.isArray(step.content) ? step.content : [];
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const record = part as { type?: string; toolName?: string; input?: { groups?: unknown } };
      if (record.type !== 'tool-call' || record.toolName !== ENABLE_TOOLS_NAME) continue;
      const requested = Array.isArray(record.input?.groups) ? record.input.groups : [];
      for (const name of requested) if (isToolGroupName(name)) groups.push(name);
    }
  }
  return groups;
}

export const enableToolsInputSchema = z.object({
  groups: z
    .array(z.enum(TOOL_GROUP_NAMES as [ToolGroupName, ...ToolGroupName[]]))
    .min(1)
    .max(4)
    .describe('Tool groups to load for the next steps.'),
});

export function enableToolsDescription(groups: readonly ToolGroupName[] = TOOL_GROUP_NAMES): string {
  const lines = groups.map((name) => `${name}: ${TOOL_GROUPS[name].label}`);
  return `Load an on-demand tool group for the rest of this turn. The core tools are always available; call this first when the task needs one of these groups, then call the loaded tools in your next step. Groups — ${lines.join('; ')}.`;
}

/**
 * The result the model sees after enabling groups. With the full picture
 * (every tool name, the chat's scope groups, and the groups requested before
 * this call), it also reports the groups that no longer fit.
 */
export function enableToolsResult(
  groups: readonly string[],
  context?: { allToolNames: Iterable<string>; scopeGroups: readonly string[]; earlier: readonly string[] },
) {
  const requested = dedupe(groups.filter(isToolGroupName));
  const plan = context
    ? planToolGroups(context.allToolNames, [...context.earlier, ...requested], context.scopeGroups)
    : null;
  const enabled = plan ? requested.filter((name) => plan.groups.includes(name)) : requested;
  const evicted = plan ? plan.evicted : [];
  const notLoaded = requested.filter((name) => evicted.includes(name));
  // Groups this call pushed out: loaded before it, not loaded after it.
  const before = context
    ? planToolGroups(context.allToolNames, context.earlier, context.scopeGroups).groups
    : [];
  const dropped = evicted.filter((name) => before.includes(name) && !requested.includes(name));
  const parts = [
    enabled.length
      ? `Loaded ${enabled.join(', ')}. Those tools are available from the next step.`
      : requested.length
        ? ''
        : 'No known groups were requested.',
    notLoaded.length ? `Could not load ${notLoaded.join(', ')}: the tool limit is full.` : '',
    dropped.length
      ? `Unloaded ${dropped.join(', ')} to make room; enable ${dropped.length > 1 ? 'them' : 'it'} again if you still need it.`
      : '',
  ];
  return {
    ok: true,
    enabled,
    tools: enabled.flatMap((name) => [...TOOL_GROUPS[name].tools]),
    evicted,
    summary: parts.filter(Boolean).join(' '),
  };
}

/** The prompt paragraph that tells the model which groups exist. */
export function toolGroupsPromptLine(groups: readonly ToolGroupName[] = TOOL_GROUP_NAMES): string {
  return `- A core tool set is always loaded. These groups load on demand through enable_tools: ${groups.join(', ')}. When a request needs one (smart labels, board or column admin, project routines, Area facts, document publishing or export, Drive or Google document files, media cards, structured asks), call enable_tools with the group first, in the same step as any independent lookups, then use the loaded tools.`;
}
