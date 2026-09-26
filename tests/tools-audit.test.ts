import { describe, expect, test } from 'bun:test';
import './tools/harness';
import { invokeTool } from '../lib/tools/registry';
import { toolContext, withToolContext } from './tools/harness';

async function auditLines(run: () => Promise<unknown>) {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    await run().catch(() => undefined);
  } finally {
    console.log = original;
  }
  return lines.filter((line) => line.startsWith('[audit] ')).map((line) => JSON.parse(line.slice(8)));
}

describe('audit tools', () => {
  test('invokeTool writes a redacted audit line for the active user', async () => {
    const { getTool } = await import('../lib/tools/index');
    const remember = getTool('remember');
    expect(remember).toBeTruthy();
    const entries = await auditLines(() =>
      withToolContext(() =>
        invokeTool(remember!, { email: 'audit@example.test', notes: 'private note' }, toolContext()),
      ),
    );
    const entry = entries.find((row) => row.tool === 'remember');
    expect(entry).toMatchObject({
      userId: 'test_user_tools',
      result: 'ok',
      agent: 'codex',
      args: '[REDACTED]',
    });
    expect(JSON.stringify(entries)).not.toContain('private note');
  });
});
