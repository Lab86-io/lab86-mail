import { describe, expect, test } from 'bun:test';
import { getServerDef, MCP_SERVERS, normalizeItems, resolveMcpConnectionConfig } from '../lib/mcp/servers';

describe('MCP server registry and normalizer', () => {
  test('declares direct GitHub/Bitbucket transports and hosted Jira/Slack transports', () => {
    expect(getServerDef('github')).toMatchObject({ transport: 'github-rest', authMode: 'bearer' });
    expect(getServerDef('bitbucket')).toMatchObject({
      transport: 'bitbucket-rest',
      authMode: 'basic-or-bearer',
    });
    expect(getServerDef('jira')?.syncQueries[0]?.tool).toBe('searchJiraIssuesUsingJql');
    expect(getServerDef('slack')?.syncQueries[0]?.tool).toBe('search_messages');
    expect(getServerDef('missing')).toBeNull();
    expect(Object.keys(MCP_SERVERS)).toEqual(['github', 'bitbucket', 'jira', 'slack']);
  });

  test('migrates legacy GitHub MCP connections without rewriting enterprise REST hosts', () => {
    expect(
      resolveMcpConnectionConfig('github', 'https://api.githubcopilot.com/mcp/readonly', [
        'issues:read',
        'pull_requests:read',
      ]),
    ).toEqual({
      serverUrl: 'https://api.github.com',
      scopes: ['metadata:read', 'contents:read', 'issues:read', 'pull_requests:read', 'projects:read'],
      migrated: true,
    });
    expect(
      resolveMcpConnectionConfig('github', 'https://github.enterprise.test/api/v3', [
        'metadata:read',
        'contents:read',
        'issues:read',
        'pull_requests:read',
        'projects:read',
      ]),
    ).toMatchObject({
      serverUrl: 'https://github.enterprise.test/api/v3',
      migrated: false,
    });
  });

  test('normalizes structured arrays with unique IDs and timestamps', () => {
    const items = normalizeItems(
      { tool: 'issues', args: {}, kind: 'ticket' },
      {
        structuredContent: [
          {
            id: 42,
            title: 'Ship Area inbox',
            html_url: 'https://example.test/issues/42',
            state: 'open',
            user: { login: 'jakob' },
            updated_at: 1_760_000_000,
          },
          null,
          { title: 'No identity' },
        ],
      },
    );

    expect(items).toEqual([
      expect.objectContaining({
        externalId: '42',
        title: 'Ship Area inbox',
        state: 'open',
        author: 'jakob',
        updatedAtSource: 1_760_000_000_000,
      }),
    ]);
  });

  test('handles nested Jira and Slack result shapes plus fallback titles', () => {
    const jira = normalizeItems(
      { tool: 'jira', args: {}, kind: 'ticket' },
      {
        structured_content: {
          issues: [
            {
              key: 'ALB-9',
              fields: {
                summary: 'Weighted evidence',
                status: { name: 'In progress' },
                reporter: { displayName: 'Ada' },
                updated: '2026-07-14T12:00:00Z',
              },
              self: 'https://jira.example.test/ALB-9',
            },
          ],
        },
      },
    );
    const slack = normalizeItems(
      { tool: 'slack', args: {}, kind: 'message' },
      {
        content: [
          { type: 'text', text: 'not json' },
          {
            type: 'text',
            text: JSON.stringify({
              messages: {
                matches: [
                  {
                    ts: '1760000000',
                    message: { text: 'Question from product' },
                    permalink: 'https://slack.example.test/archives/1',
                    username: 'Grace',
                  },
                  { iid: 7 },
                ],
              },
            }),
          },
        ],
      },
    );

    expect(jira[0]).toMatchObject({
      externalId: 'ALB-9',
      title: 'Weighted evidence',
      state: 'In progress',
      author: 'Ada',
    });
    expect(slack[0]).toMatchObject({
      title: 'Question from product',
      author: 'Grace',
      updatedAtSource: 1_760_000_000_000,
    });
    expect(slack[1]?.title).toBe('message 7');
    expect(normalizeItems({ tool: 'none', args: {}, kind: 'item' }, {})).toEqual([]);
  });
});
