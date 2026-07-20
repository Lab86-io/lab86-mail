import { describe, expect, test } from 'bun:test';
import { indexMcpTools } from '../lib/mcp/client';

describe('MCP client tool index', () => {
  test('indexes advertised names and schemas for downstream adaptive calls', () => {
    const meetingsSchema = { type: 'object', properties: { meeting_ids: { type: 'array' } } };
    const indexed = indexMcpTools([
      { name: 'list_meetings' },
      { name: 'get_meetings', inputSchema: meetingsSchema },
    ]);

    expect([...indexed.toolNames]).toEqual(['list_meetings', 'get_meetings']);
    expect(indexed.toolSchemas.get('get_meetings')).toBe(meetingsSchema);
    expect(indexMcpTools(undefined).toolNames.size).toBe(0);
  });
});
