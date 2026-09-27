import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { APPROVAL_GATED_TOOLS } from '../lib/ai/approval';
import { AGENT_TOOL_NAMES, liftToolsForAgent } from '../lib/ai/loop';
import { buildSystemPrompt, type ClientPlatform } from '../lib/ai/system-prompt';
import { TOOL_GROUP_NAMES, TOOL_GROUPS } from '../lib/ai/tool-groups';
import { SHAPED_TOOL_NAMES } from '../lib/ai/tool-shapes';
import { TOOLS } from '../lib/tools';

// One cross-check over every place that names a tool. A name that drifts from
// the registry fails here instead of as "tried to call unavailable tool" at
// run time, or as a native button that always errors.

const ROOT = path.join(import.meta.dir, '..');

function files(dir: string, keep: (file: string) => boolean, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue;
    const file = path.join(dir, entry);
    if (statSync(file).isDirectory()) files(file, keep, out);
    else if (keep(file)) out.push(file);
  }
  return out;
}

// snake_case words in the prompt that are not tool names.
const PROMPT_WORDS_THAT_ARE_NOT_TOOLS = new Set([
  ...TOOL_GROUP_NAMES,
  'google_meet',
  'needs_input',
  'needs_review',
  'newer_than',
  'spreadsheet_command',
  'slide_insert',
  'slide_update',
]);

describe('tool names agree across the prompt, groups, shapes, and clients', () => {
  for (const platform of ['web', 'ios', 'macos'] as ClientPlatform[]) {
    test(`every tool the ${platform} prompt names is registered and given to the agent`, () => {
      const lifted = new Set(
        Object.keys(liftToolsForAgent('b', 'UTC', undefined, { clientPlatform: platform })),
      );
      const prompt = buildSystemPrompt({ email: 'u@example.test' }, { clientPlatform: platform });
      const named = [...new Set(prompt.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? [])].filter(
        (word) => !PROMPT_WORDS_THAT_ARE_NOT_TOOLS.has(word),
      );
      expect(named.length).toBeGreaterThan(50);
      const missing = named.filter((name) => !lifted.has(name));
      expect(missing).toEqual([]);
      for (const name of named) {
        if (name.startsWith('ask_') || name === 'enable_tools') continue;
        expect(TOOLS[name]).toBeTruthy();
        expect(AGENT_TOOL_NAMES.has(name)).toBe(true);
      }
    });
  }

  test('the prompt never names a send tool the agent does not have', () => {
    expect(buildSystemPrompt()).not.toContain('send_message');
    expect(AGENT_TOOL_NAMES.has('send_message')).toBe(false);
  });

  test('the agent list, tool groups, approval gate, and shape mappers name registered tools', () => {
    for (const name of AGENT_TOOL_NAMES) expect(TOOLS[name]).toBeTruthy();
    const lifted = new Set(Object.keys(liftToolsForAgent('b', 'UTC')));
    for (const group of TOOL_GROUP_NAMES)
      for (const name of TOOL_GROUPS[group].tools) expect(lifted.has(name)).toBe(true);
    for (const name of APPROVAL_GATED_TOOLS) expect(AGENT_TOOL_NAMES.has(name)).toBe(true);
    for (const name of SHAPED_TOOL_NAMES) {
      expect(TOOLS[name]).toBeTruthy();
      expect(AGENT_TOOL_NAMES.has(name)).toBe(true);
    }
  });

  test('the agent can find Work and Areas by name', () => {
    for (const name of ['work_list', 'area_home', 'area_list', 'albatross_get_work_context'])
      expect(AGENT_TOOL_NAMES.has(name)).toBe(true);
    expect(buildSystemPrompt()).toContain('call work_list to find its Work id');
    // Tools with no agent path and no client caller are gone from the registry.
    for (const name of [
      'albatross_preview_undo_unresolved',
      'albatross_undo_approval',
      'classify_threads',
      'get_smart_category_stats',
      'get_tracked_thread',
      'list_audit',
      'list_tracked_threads',
      'mark_sender_human',
      'recent_threads',
      'track_thread',
    ])
      expect(TOOLS[name]).toBeUndefined();
  });

  test('every tool the native apps call by name is registered', () => {
    const swift = files(path.join(ROOT, 'apps/ios'), (file) => file.endsWith('.swift'));
    const called = new Set<string>();
    for (const file of swift)
      for (const match of readFileSync(file, 'utf8').matchAll(/\b(?:invoke|callTool)\(\s*"([a-z0-9_]+)"/g))
        called.add(match[1]);
    expect(called.size).toBeGreaterThan(20);
    expect([...called].filter((name) => !TOOLS[name])).toEqual([]);
  });

  test('every tool the web app calls by name is registered', () => {
    const sources = ['app', 'components', 'lib'].flatMap((dir) =>
      files(path.join(ROOT, dir), (file) => /\.tsx?$/.test(file)),
    );
    const called = new Set<string>();
    for (const file of sources)
      for (const match of readFileSync(file, 'utf8').matchAll(/\bcallTool\(\s*['"]([a-z0-9_]+)['"]/g))
        called.add(match[1]);
    expect(called.size).toBeGreaterThan(10);
    expect([...called].filter((name) => !TOOLS[name])).toEqual([]);
  });
});
