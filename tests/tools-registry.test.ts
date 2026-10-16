import { describe, expect, test } from 'bun:test';
import './tools/harness';
import { z } from 'zod';
import { getTool, listToolMetadata, TOOLS } from '../lib/tools/index';
import { invokeTool, parseToolArgs, ToolValidationError } from '../lib/tools/registry';
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

  test('a list or an object sent as JSON text parses as that JSON', () => {
    const schema = z.object({
      values: z
        .array(z.object({ field: z.string(), value: z.string() }))
        .min(1)
        .max(200),
      options: z.object({ flatten: z.boolean() }).optional(),
      name: z.string().optional(),
    });
    const values = [{ field: 'f1_01', value: 'Dana Example' }];
    // The model sent the list as text, and the text is longer than 200 characters.
    const long = JSON.stringify([
      ...values,
      ...Array.from({ length: 6 }, () => ({ field: 'x'.repeat(30), value: 'y' })),
    ]);
    expect(parseToolArgs(schema, { values: long })).toEqual({ values: JSON.parse(long) });
    expect(parseToolArgs(schema, { values, options: '{"flatten":true}' })).toEqual({
      values,
      options: { flatten: true },
    });
    // A string field keeps its text, even when the text is JSON.
    expect(parseToolArgs(schema, { values, name: '[1]' })).toEqual({ values, name: '[1]' });
    // Text that is not JSON, or JSON of the wrong kind, keeps the first error.
    expect(() => parseToolArgs(schema, { values: 'Dana Example' })).toThrow(z.ZodError);
    expect(() => parseToolArgs(schema, { values: '{"field":"f1"}' })).toThrow(z.ZodError);
    // JSON with the wrong items still fails on the items.
    expect(() => parseToolArgs(schema, { values: '[{"field":1}]' })).toThrow(z.ZodError);
    expect(() => parseToolArgs(schema, 'values')).toThrow(z.ZodError);
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
