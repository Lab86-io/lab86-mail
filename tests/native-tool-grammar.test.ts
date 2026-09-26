import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { liftToolsForAgent } from '../lib/ai/loop';
import { TOOLS } from '../lib/tools';

// The native chat names a tool in its sentence table (AssistantToolGrammar).
// A name the server no longer has is dead weight and hides drift, so every
// name must be a registered tool, or a tool the agent loop adds for the
// native client (ask_* forms and enable_tools).

const GRAMMAR = path.join(
  import.meta.dir,
  '..',
  'apps/ios/Lab86Mail/Features/Assistant/AssistantToolGrammar.swift',
);

export function grammarToolNames(source: string): string[] {
  const table = source.slice(source.indexOf('private static let table'));
  return [...table.matchAll(/^\s*"([a-z0-9_]+)":/gm)].map((match) => match[1]);
}

describe('native tool grammar', () => {
  const names = grammarToolNames(readFileSync(GRAMMAR, 'utf8'));

  test('reads the sentence table', () => {
    expect(names.length).toBeGreaterThan(50);
    expect(names).toContain('archive_thread');
    expect(grammarToolNames('no table here')).toEqual([]);
  });

  test('every tool the native grammar names exists for the native agent', () => {
    for (const platform of ['ios', 'macos'] as const) {
      const lifted = new Set(
        Object.keys(liftToolsForAgent('b', 'UTC', undefined, { clientPlatform: platform })),
      );
      expect(names.filter((name) => !TOOLS[name] && !lifted.has(name))).toEqual([]);
    }
  });

  test('removed tools are gone from the native grammar', () => {
    for (const name of [
      'albatross_area_brief',
      'albatross_capture',
      'albatross_list_work',
      'albatross_work_detail',
      'recent_threads',
      'tasks_list_cards',
      'tasks_search_cards',
    ])
      expect(names).not.toContain(name);
  });
});
