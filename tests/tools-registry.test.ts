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

  test('invokeTool records successful audit entries', async () => {
    const remember = getTool('remember');
    const listAudit = getTool('list_audit');
    expect(remember && listAudit).toBeTruthy();
    await withToolContext(async () => {
      await invokeTool(
        remember!,
        { email: 'audit@example.test', notes: 'likes concise replies' },
        toolContext(),
      );
      const audit = await invokeTool(listAudit!, { limit: 20 }, toolContext());
      expect(audit.entries.some((entry: any) => entry.tool === 'remember')).toBe(true);
    });
  });
});
