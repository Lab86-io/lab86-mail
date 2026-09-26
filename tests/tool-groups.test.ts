import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  AGENT_TOOL_NAMES,
  activeToolsForStep,
  liftToolsForAgent,
  modelInputSchema,
  stripPatterns,
} from '../lib/ai/loop';
import { buildSystemPrompt } from '../lib/ai/system-prompt';
import {
  activeToolNames,
  coreToolNames,
  ENABLE_TOOLS_NAME,
  enabledGroupsFromSteps,
  enableToolsResult,
  initialToolGroups,
  MAX_ACTIVE_TOOLS,
  planToolGroups,
  TOOL_GROUP_NAMES,
  TOOL_GROUPS,
} from '../lib/ai/tool-groups';
import { resolveToolShape } from '../lib/ai/tool-shapes';
import { toolActivityLine } from '../lib/albatross/teach-ui';

const lifted = liftToolsForAgent('batch', 'UTC');
const allNames = Object.keys(lifted);

describe('tool groups', () => {
  test('every grouped tool is a real lifted tool and no tool is in two groups', () => {
    const seen = new Map<string, string>();
    for (const group of TOOL_GROUP_NAMES) {
      for (const tool of TOOL_GROUPS[group].tools) {
        expect(allNames).toContain(tool);
        expect(seen.get(tool)).toBeUndefined();
        seen.set(tool, group);
      }
    }
  });

  test('the agent allow-list still covers every grouped registry tool', () => {
    for (const group of TOOL_GROUP_NAMES) {
      for (const tool of TOOL_GROUPS[group].tools) {
        if (tool.startsWith('ask_') || tool.startsWith('show_')) continue;
        expect(AGENT_TOOL_NAMES.has(tool)).toBe(true);
      }
    }
  });

  test('the core set stays well under the OpenAI 128-tool cap and includes enable_tools', () => {
    const core = coreToolNames(allNames);
    expect(core.length).toBeLessThanOrEqual(110);
    expect(core).toContain(ENABLE_TOOLS_NAME);
    expect(core).toContain('search_threads');
    expect(core).toContain('calendar_create_event');
    expect(core).toContain('tasks_create_card');
    expect(core).toContain('show_plan');
    expect(core).toContain('ask_user');
    expect(core).not.toContain('create_smart_label');
    expect(core).not.toContain('show_weather');
  });

  test('every group combination stays within the cap, dropping the oldest group first', () => {
    const everything = activeToolNames(allNames, TOOL_GROUP_NAMES);
    expect(everything.length).toBeLessThanOrEqual(MAX_ACTIVE_TOOLS);
    const last = TOOL_GROUP_NAMES[TOOL_GROUP_NAMES.length - 1];
    for (const tool of TOOL_GROUPS[last].tools) expect(everything).toContain(tool);
    const first = TOOL_GROUP_NAMES[0];
    expect(everything.some((tool) => (TOOL_GROUPS[first].tools as readonly string[]).includes(tool))).toBe(
      false,
    );
  });

  test('scope groups are never unloaded, and the result reports what was dropped', async () => {
    // Work and Area chats start with their scope groups loaded.
    for (const scope of [
      initialToolGroups({ hasWorkContext: true, narrativeEnabled: true }),
      initialToolGroups({ hasAreaContext: true, narrativeEnabled: true }),
      initialToolGroups({ hasWorkContext: true, hasAreaContext: true, narrativeEnabled: true }),
    ]) {
      const everything = planToolGroups(allNames, TOOL_GROUP_NAMES, scope);
      expect(everything.active.length).toBeLessThanOrEqual(MAX_ACTIVE_TOOLS);
      for (const group of scope)
        for (const tool of TOOL_GROUPS[group].tools) expect(everything.active).toContain(tool);
      expect(everything.evicted.some((group) => scope.includes(group))).toBe(false);
    }
    // The headroom fits the largest on-demand group in a Work or an Area chat.
    const largest = Math.max(...TOOL_GROUP_NAMES.map((name) => TOOL_GROUPS[name].tools.length));
    for (const scope of [
      initialToolGroups({ hasWorkContext: true, narrativeEnabled: true }),
      initialToolGroups({ hasAreaContext: true, narrativeEnabled: true }),
    ])
      expect(activeToolNames(allNames, [], scope).length + largest).toBeLessThanOrEqual(MAX_ACTIVE_TOOLS);

    // Every requested group that does not fit shows in the enable_tools result.
    const scoped = liftToolsForAgent('batch', 'UTC', undefined, {
      scopeGroups: ['narrative', 'areas', 'projects_routines'],
    });
    const first = await scoped[ENABLE_TOOLS_NAME].execute(
      { groups: ['calendar_admin', 'display_media'] },
      {} as any,
    );
    expect(first.enabled).toEqual(['calendar_admin']);
    expect(first.evicted).toEqual(['display_media']);
    expect(first.summary).toContain('Could not load display_media');
    const second = await scoped[ENABLE_TOOLS_NAME].execute({ groups: ['cloud_files'] }, {} as any);
    expect(second.enabled).toEqual(['cloud_files']);
    expect(second.evicted).toEqual(['calendar_admin', 'display_media']);
    expect(second.summary).toBe(
      'Loaded cloud_files. Those tools are available from the next step. Unloaded calendar_admin to make room; enable it again if you still need it.',
    );
  });

  test('re-enabling a group moves it to most recent', () => {
    const active = activeToolNames(allNames, ['smart_labels', 'areas', 'smart_labels']);
    expect(active).toContain('create_smart_label');
    expect(active).toContain('area_create');
    expect(activeToolNames(allNames, ['nope', 'areas'] as string[])).toContain('area_create');
  });

  test('scope decides the initial groups', () => {
    expect(initialToolGroups({})).toEqual([]);
    expect(initialToolGroups({ hasWorkContext: true })).toEqual(['projects_routines']);
    expect(initialToolGroups({ hasAreaContext: true, narrativeEnabled: true })).toEqual([
      'narrative',
      'areas',
    ]);
  });

  test('enable_tools calls in earlier steps widen the next step', () => {
    const steps = [
      {
        content: [
          { type: 'tool-call', toolName: ENABLE_TOOLS_NAME, input: { groups: ['board_admin', 'bogus'] } },
        ],
      },
      { content: [{ type: 'text', text: 'x' }] },
    ];
    expect(enabledGroupsFromSteps(steps)).toEqual(['board_admin']);
    const active = activeToolsForStep(allNames, ['areas'], steps);
    expect(active).toContain('tasks_create_board');
    expect(active).toContain('area_create');
    expect(active).not.toContain('create_smart_label');
    expect(activeToolsForStep(allNames, [], [])).not.toContain('tasks_create_board');
  });

  test('the enable_tools tool executes and reports the loaded tools', async () => {
    const result = await lifted[ENABLE_TOOLS_NAME].execute({ groups: ['calendar_admin'] }, {} as any);
    expect(result).toMatchObject({ ok: true, enabled: ['calendar_admin'], evicted: [] });
    expect(result.tools).toContain('calendar_sync_now');
    expect(result.summary).toContain('calendar_admin');
    expect(enableToolsResult(['nope']).enabled).toEqual([]);
    expect(lifted[ENABLE_TOOLS_NAME].description).toContain('smart_labels');
  });

  test('presentation questions are unavailable after delegation, cancellation or a pending question', () => {
    expect(activeToolsForStep(allNames, [], [], {})).toContain('ask_presentation_choices');
    for (const session of [{ delegate: true }, { cancelled: true }])
      expect(activeToolsForStep(allNames, [], [], session)).not.toContain('ask_presentation_choices');
    const call = { type: 'tool-call', toolName: 'ask_presentation_choices' };
    expect(activeToolsForStep(allNames, [], [{ content: [call] }])).not.toContain('ask_presentation_choices');
    expect(activeToolsForStep(allNames, [], [{ content: [{ ...call, invalid: true }] }])).toContain(
      'ask_presentation_choices',
    );
  });

  test('enable_tools has a sentence and no card', () => {
    expect(toolActivityLine(ENABLE_TOOLS_NAME, { groups: ['areas'] }, 'input-available').text).toBe(
      'Loading areas tools…',
    );
    expect(
      resolveToolShape(ENABLE_TOOLS_NAME, { groups: ['areas'] }, enableToolsResult(['areas'])),
    ).toBeNull();
  });

  test('model-facing input schemas carry no regex patterns (OpenAI Responses rejects lookarounds)', () => {
    const schema = modelInputSchema(
      z.object({ attendees: z.array(z.object({ email: z.email(), name: z.string().optional() })) }),
    );
    const json = JSON.stringify(schema.jsonSchema);
    expect(json).toContain('attendees');
    expect(json).not.toContain('pattern');
    expect(stripPatterns({ a: { pattern: '(?=x)', type: 'string' }, b: [{ pattern: 'y' }] })).toEqual({
      a: { type: 'string' },
      b: [{}],
    });
    const tools = liftToolsForAgent('b', 'UTC');
    for (const name of allNames) {
      const lifted = tools[name];
      const text = JSON.stringify(lifted.inputSchema.jsonSchema ?? {});
      expect(text.includes('(?=') || text.includes('(?!') || text.includes('(?<')).toBe(false);
    }
  });

  test('the system prompt names every group', () => {
    const prompt = buildSystemPrompt();
    for (const group of TOOL_GROUP_NAMES) expect(prompt).toContain(group);
    expect(prompt).toContain('call enable_tools with the group first');
  });

  test('agent deck creation advertises only the modern native chart/table contract', () => {
    const schema = JSON.stringify(lifted.document_create.inputSchema.jsonSchema);
    expect(schema).toContain('"role"');
    expect(schema).toContain('"chart"');
    expect(schema).toContain('"table"');
    expect(schema).not.toContain('"layout"');
    const planner = JSON.stringify(lifted.presentation_plan.inputSchema.jsonSchema);
    expect(planner).toContain('"recovery"');
    expect(planner).toContain('"completedSlides"');
  });
});
