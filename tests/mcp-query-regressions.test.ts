import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (relativePath: string) => readFileSync(path.join(process.cwd(), relativePath), 'utf8');

describe('MCP query ordering contracts', () => {
  test('brief retrieval limits each connection by source update time', () => {
    const schema = read('convex/schema.ts');
    const queries = read('convex/mcp.ts');
    expect(schema).toContain(
      ".index('by_user_connection_updated', ['userId', 'connectionId', 'updatedAtSource'])",
    );
    expect(queries).toContain(".withIndex('by_user_connection_updated'");
  });
});
