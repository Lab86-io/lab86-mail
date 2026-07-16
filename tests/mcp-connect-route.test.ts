import { describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createMcpConnectPost } from '../app/api/mcp/connect/route';
import { getServerDef } from '../lib/mcp/servers';

function request(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/mcp/connect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('MCP token connect route', () => {
  test('rejects OAuth-only servers before accepting a pasted token', async () => {
    const post = createMcpConnectPost({
      requireCurrentUser: async () => ({ userId: 'user_1', email: 'user@example.com', name: 'User' }) as any,
      enforceUserRateLimit: async () => ({ ok: true }) as any,
      getServerDef,
      saveTokenConnection: async () => {
        throw new Error('must not save');
      },
      syncConnection: async () => {
        throw new Error('must not sync');
      },
    } as any);

    const response = await post(request({ server: 'granola', token: 'pasted-token' }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'Granola must be connected through browser authorization.',
    });
  });
});
