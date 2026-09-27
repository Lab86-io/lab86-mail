import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { McpReconnectNote, McpSyncProblemNote } from '../components/settings/McpConnectionNotes';

// AI-7: Settings shows Reconnect only for a failed sign-in, and a sync
// problem as a quiet note.

describe('the connection notes in Settings', () => {
  test('Reconnect shows only for a connection whose sign-in failed', () => {
    const oauth = renderToStaticMarkup(
      <McpReconnectNote
        connection={{ server: 'granola', authKind: 'oauth', status: 'error', error: 'expired' }}
      />,
    );
    expect(oauth).toContain('Reconnect needed. The saved sign-in no longer works.');
    expect(oauth).toContain('href="/api/mcp/oauth/start?server=granola"');
    expect(oauth).toContain('>Reconnect</a>');

    const token = renderToStaticMarkup(
      <McpReconnectNote connection={{ server: 'github', authKind: 'token', status: 'error' }} />,
    );
    expect(token).toContain('Add a new token below.');
    expect(token).not.toContain('<a');

    expect(
      renderToStaticMarkup(
        <McpReconnectNote
          connection={{ server: 'github', status: 'connected', lastSyncError: 'rate limited' }}
        />,
      ),
    ).toBe('');
  });

  test('a sync problem is a quiet note with no Reconnect', () => {
    const partial = renderToStaticMarkup(
      <McpSyncProblemNote
        connection={{
          server: 'granola',
          status: 'connected',
          lastSyncError: 'account check: rate limited.',
          lastSyncErrorAt: 5,
          lastSyncOkAt: 5,
        }}
      />,
    );
    expect(partial).toContain('data-mcp-sync-problem="partial"');
    expect(partial).toContain(
      'Part of the last sync had a problem: account check: rate limited. It will try',
    );
    expect(partial).not.toContain('Reconnect');
    expect(partial).not.toContain('color-danger');

    const failed = renderToStaticMarkup(
      <McpSyncProblemNote
        connection={{
          server: 'jira',
          status: 'connected',
          lastSyncError: 'socket hang up',
          lastSyncErrorAt: 9,
        }}
      />,
    );
    expect(failed).toContain('Last sync had a problem: socket hang up. It will try again.');

    expect(
      renderToStaticMarkup(<McpSyncProblemNote connection={{ server: 'jira', status: 'connected' }} />),
    ).toBe('');
  });
});
