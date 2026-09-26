import { describe, expect, test } from 'bun:test';
import './tools/harness';
import { invokeTool } from '../lib/tools/registry';
import { toolContext, withToolContext } from './tools/harness';

describe('audit tools', () => {
  test('invokeTool audit entries are scoped to the active user', async () => {
    const { getTool } = await import('../lib/tools/index');
    const remember = getTool('remember');
    const listAudit = getTool('list_audit');
    expect(remember && listAudit).toBeTruthy();
    await withToolContext(async () => {
      await invokeTool(remember!, { email: 'audit@example.test', notes: 'note' }, toolContext());
      const audit = await invokeTool(listAudit!, { limit: 20 }, toolContext());
      expect(audit.entries.some((entry: any) => entry.tool === 'remember')).toBe(true);
    });
  });
});
