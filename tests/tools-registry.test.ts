import { describe, expect, test } from 'bun:test';
import './tools/harness';
import { getTool, listToolMetadata, TOOLS } from '../lib/tools/index';
import { invokeTool, ToolValidationError } from '../lib/tools/registry';
import { toolContext, withToolContext } from './tools/harness';

describe('tool registry', () => {
  test('registers every exported tool with unique names', () => {
    const metadata = listToolMetadata();
    const names = metadata.map((tool) => tool.name);
    expect(metadata.length).toBeGreaterThan(100);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of metadata) {
      expect(tool.description.length).toBeGreaterThan(10);
      expect([
        'mail',
        'compose',
        'ai',
        'memory',
        'calendar',
        'tasks',
        'contacts',
        'web',
        'audit',
        'mcp',
        'meta',
        'documents',
      ]).toContain(tool.category);
    }
  });

  test('getTool resolves registered handlers', () => {
    expect(getTool('remember')?.name).toBe('remember');
    expect(getTool('missing_tool_xyz')).toBeNull();
    expect(Object.keys(TOOLS).length).toBe(listToolMetadata().length);
  });

  test('invokeTool validates args before running handlers', async () => {
    const remember = getTool('remember');
    expect(remember).toBeTruthy();
    await withToolContext(async () => {
      await expect(
        invokeTool(remember!, { email: 'person@example.test' }, toolContext()),
      ).rejects.toBeInstanceOf(ToolValidationError);
    });
  });

  test('invokeTool audits a failed call as an error without its detail', async () => {
    const update = getTool('update_tracked_thread');
    expect(update).toBeTruthy();
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      await withToolContext(async () => {
        await expect(invokeTool(update!, { id: 'missing_tracked' }, toolContext())).rejects.toThrow(
          'Tracked thread not found',
        );
      });
    } finally {
      console.log = original;
    }
    const entries = lines
      .filter((line) => line.startsWith('[audit] '))
      .map((line) => JSON.parse(line.slice(8)));
    expect(entries).toContainEqual(
      expect.objectContaining({ tool: 'update_tracked_thread', result: 'error', detail: '[REDACTED]' }),
    );
  });
});
