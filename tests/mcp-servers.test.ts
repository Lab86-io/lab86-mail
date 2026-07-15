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
    expect(getServerDef('granola')).toMatchObject({
      transport: 'mcp',
      connectMode: 'oauth',
      defaultUrl: 'https://mcp.granola.ai/mcp',
    });
    expect(getServerDef('missing')).toBeNull();
    expect(Object.keys(MCP_SERVERS)).toEqual(['github', 'bitbucket', 'jira', 'slack', 'granola']);
  });

  test('normalizes Granola meetings with attendees into searchable evidence', () => {
    const meetings = normalizeItems(
      { tool: 'list_meetings', args: {}, kind: 'meeting' },
      {
        structuredContent: {
          meetings: [
            {
              id: 'meeting_1',
              title: 'Albatross planning',
              date: '2026-07-15T14:00:00Z',
              attendees: [{ name: 'Ada' }, { email: 'grace@example.com' }],
            },
          ],
        },
      },
    );

    expect(meetings[0]).toMatchObject({
      externalId: 'meeting_1',
      kind: 'meeting',
      title: 'Albatross planning',
      summary: 'Attendees: Ada, grace@example.com',
      updatedAtSource: Date.parse('2026-07-15T14:00:00Z'),
    });
    expect(meetings[0]?.searchText).toContain('Ada, grace@example.com');
  });

  test('normalizes the XML-like meeting payload returned by the live Granola MCP', () => {
    const meetings = normalizeItems(
      { tool: 'list_meetings', args: {}, kind: 'meeting' },
      {
        content: [
          {
            type: 'text',
            text: `<meetings_data count="2">
              <meeting id="meeting_live_1" title="CardHunt &amp; Lab86" date="2026-07-14T17:00:00Z">
                <known_participants>Ada Lovelace, grace@example.com</known_participants>
                <summary>Reviewed GitHub pull requests &amp; staging.</summary>
              </meeting>
              <meeting id="meeting_live_2" title="One-on-one" date="2026-07-13T16:00:00Z">
                <private_notes>Follow up next week.</private_notes>
              </meeting>
            </meetings_data>`,
          },
        ],
      },
    );

    expect(meetings).toHaveLength(2);
    expect(meetings[0]).toMatchObject({
      externalId: 'meeting_live_1',
      title: 'CardHunt & Lab86',
      summary: 'Reviewed GitHub pull requests & staging.',
      updatedAtSource: Date.parse('2026-07-14T17:00:00Z'),
    });
    expect(meetings[0]?.searchText).toContain('grace@example.com');
    expect(meetings[1]?.summary).toBe('Follow up next week.');
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
    expect(resolveMcpConnectionConfig('github', 'not a URL', ['issues:read'])).toMatchObject({
      serverUrl: 'https://api.github.com',
      migrated: true,
    });
    expect(resolveMcpConnectionConfig('unknown', 'https://example.test/mcp', ['custom:read'])).toEqual({
      serverUrl: 'https://example.test/mcp',
      scopes: ['custom:read'],
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
