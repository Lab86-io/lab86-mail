import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConnectionLogo, ProviderLogo, providerDisplayName } from '../components/icons/provider-logos';
import { McpConnectionIdentity, McpConnectionTitle } from '../components/settings/McpConnectionNotes';
import { connectedItemReason } from '../lib/mail/brief-connected';
import { briefServiceIdForMcpItem, briefServicesFromIds } from '../lib/mail/brief-services';
import {
  isConfluencePage,
  MCP_ADD_ANOTHER_HELP,
  mcpConnectionDisplay,
  mcpConnectionLabel,
  mcpConnectionsCountLine,
  mcpConnectRowCopy,
  mcpConnectRows,
  mcpItemSourceLabel,
} from '../lib/mcp/connection-display';

// Settings > Connections names each tool by its product name and shows the
// account behind it. A Confluence page from the Atlassian sign-in reads as
// Confluence everywhere, but keeps the `jira` server id.

const SERVERS_WITH_APPS = [
  { id: 'github', label: 'GitHub' },
  { id: 'bitbucket', label: 'Bitbucket' },
  { id: 'jira', label: 'Atlassian' },
  { id: 'slack', label: 'Slack' },
  { id: 'granola', label: 'Granola' },
];

describe('the connection label', () => {
  test('the label from the status route comes first', () => {
    expect(mcpConnectionLabel({ server: 'jira', authKind: 'oauth' }, SERVERS_WITH_APPS)).toBe('Atlassian');
    expect(
      mcpConnectionLabel({ server: 'jira', authKind: 'token' }, [{ id: 'jira', label: 'Atlassian / Jira' }]),
    ).toBe('Atlassian / Jira');
  });

  test('without the status label, an Atlassian sign-in reads Atlassian and a token reads Jira', () => {
    expect(mcpConnectionLabel({ server: 'jira', authKind: 'oauth' })).toBe('Atlassian');
    expect(mcpConnectionLabel({ server: 'jira', authKind: 'token' })).toBe('Jira');
    expect(mcpConnectionLabel({ server: 'jira' })).toBe('Jira');
    expect(mcpConnectionLabel({ server: 'github' })).toBe('GitHub');
    expect(mcpConnectionLabel({ server: 'bitbucket' })).toBe('Bitbucket');
    expect(mcpConnectionLabel({ server: 'slack' })).toBe('Slack');
    expect(mcpConnectionLabel({ server: 'granola' })).toBe('Granola');
    expect(mcpConnectionLabel({ server: 'linear' })).toBe('linear');
    expect(mcpConnectionLabel({ server: 'github' }, [{ id: 'github', label: '  ' }])).toBe('GitHub');
  });
});

describe('the connection display', () => {
  test('a saved default name does not repeat the tool name', () => {
    expect(
      mcpConnectionDisplay({ server: 'github', displayName: 'GitHub' }, SERVERS_WITH_APPS).nickname,
    ).toBe(null);
    // A token connection from before the sign-in kept the old form label.
    expect(
      mcpConnectionDisplay(
        { server: 'jira', authKind: 'token', displayName: 'Atlassian / Jira' },
        SERVERS_WITH_APPS,
      ).nickname,
    ).toBe(null);
    expect(
      mcpConnectionDisplay({ server: 'jira', authKind: 'oauth', displayName: 'atlassian' }, SERVERS_WITH_APPS)
        .nickname,
    ).toBe(null);
    expect(mcpConnectionDisplay({ server: 'slack', displayName: '   ' }).nickname).toBe(null);
  });

  test('a name the user gave stays', () => {
    expect(mcpConnectionDisplay({ server: 'github', displayName: ' Work ' }, SERVERS_WITH_APPS)).toEqual({
      label: 'GitHub',
      nickname: 'Work',
      identity: null,
    });
  });

  test('every tool shows the account behind it after a sync', () => {
    expect(
      mcpConnectionDisplay(
        {
          server: 'jira',
          authKind: 'oauth',
          displayName: 'Atlassian',
          workspaceName: 'acme, beta',
          accountEmail: 'ada@acme.com',
        },
        SERVERS_WITH_APPS,
      ),
    ).toEqual({ label: 'Atlassian', nickname: null, identity: 'acme, beta · ada@acme.com' });
    expect(mcpConnectionDisplay({ server: 'slack', workspaceName: 'Acme HQ' }).identity).toBe('Acme HQ');
    expect(mcpConnectionDisplay({ server: 'bitbucket', workspaceName: 'acme, tools' }).identity).toBe(
      'acme, tools',
    );
    expect(
      mcpConnectionDisplay({ server: 'granola', workspaceName: 'Acme', accountEmail: 'ada@acme.com' })
        .identity,
    ).toBe('Acme · ada@acme.com');
    expect(
      mcpConnectionDisplay({ server: 'granola', workspaceName: 'ada@acme.com', accountEmail: 'ada@acme.com' })
        .identity,
    ).toBe('ada@acme.com');
    expect(mcpConnectionDisplay({ server: 'github', workspaceName: ' ', accountEmail: '' }).identity).toBe(
      null,
    );
  });

  test('the row title shows the label, not the server id', () => {
    const atlassian = renderToStaticMarkup(
      <McpConnectionTitle
        display={mcpConnectionDisplay(
          { server: 'jira', authKind: 'oauth', displayName: 'Atlassian' },
          SERVERS_WITH_APPS,
        )}
      />,
    );
    expect(atlassian).toContain('>Atlassian</span>');
    expect(atlassian).not.toContain('jira');
    expect(atlassian).not.toContain('capitalize');
    expect(atlassian).not.toContain('·');

    const named = renderToStaticMarkup(
      <McpConnectionTitle display={mcpConnectionDisplay({ server: 'github', displayName: 'Work' })} />,
    );
    expect(named).toContain('>GitHub</span>');
    expect(named).toContain('>· Work</span>');
  });

  test('the identity line shows only when the sync found an account', () => {
    const slack = renderToStaticMarkup(
      <McpConnectionIdentity display={mcpConnectionDisplay({ server: 'slack', workspaceName: 'Acme HQ' })} />,
    );
    expect(slack).toContain('data-mcp-identity');
    expect(slack).toContain('Acme HQ');
    expect(
      renderToStaticMarkup(<McpConnectionIdentity display={mcpConnectionDisplay({ server: 'github' })} />),
    ).toBe('');
  });
});

// Settings > Connections lists a connect row for each tool that the user can
// add. Slack allows one connection for each workspace, so its row stays after
// the first sign-in and reads as an add-another row.

const CONNECT_SERVERS = [
  { id: 'github', label: 'GitHub', tokenHelp: 'Sign in with GitHub.' },
  { id: 'jira', label: 'Atlassian', tokenHelp: 'Sign in with Atlassian.', multipleAccounts: false },
  { id: 'slack', label: 'Slack', tokenHelp: 'Sign in with Slack.', multipleAccounts: true },
];

function rowSummary(rows: ReturnType<typeof mcpConnectRows>) {
  return rows.map((row) => `${row.server.id}${row.addAnother ? ' +' : ''}`);
}

describe('the connect rows', () => {
  test('with no connection, every tool has a first-connection row', () => {
    const rows = mcpConnectRows(CONNECT_SERVERS, []);
    expect(rowSummary(rows)).toEqual(['github', 'jira', 'slack']);
    expect(rows[0]?.server).toBe(CONNECT_SERVERS[0]);
    expect(mcpConnectRowCopy(rows[2]!)).toEqual({ title: 'Slack', help: 'Sign in with Slack.' });
  });

  test('a working connection removes a single-account tool from the list', () => {
    const rows = mcpConnectRows(CONNECT_SERVERS, [
      { server: 'github', status: 'connected' },
      { server: 'jira', status: 'disconnected' },
    ]);
    expect(rowSummary(rows)).toEqual(['slack']);
  });

  test('a single-account tool whose only connection failed stays, so a new sign-in replaces it', () => {
    expect(rowSummary(mcpConnectRows(CONNECT_SERVERS, [{ server: 'github', status: 'error' }]))).toEqual([
      'github',
      'jira',
      'slack',
    ]);
    expect(
      rowSummary(
        mcpConnectRows(CONNECT_SERVERS, [
          { server: 'github', status: 'error' },
          { server: 'github', status: 'connected' },
        ]),
      ),
    ).toEqual(['jira', 'slack']);
  });

  test('a connected Slack stays as a row that adds one more workspace', () => {
    for (const status of ['connected', 'error', undefined]) {
      const rows = mcpConnectRows(CONNECT_SERVERS, [{ server: 'slack', status }]);
      expect(rowSummary(rows)).toEqual(['github', 'jira', 'slack +']);
    }
    const twoWorkspaces = mcpConnectRows(CONNECT_SERVERS, [
      { server: 'slack', status: 'connected' },
      { server: 'slack', status: 'connected' },
    ]);
    expect(rowSummary(twoWorkspaces)).toEqual(['github', 'jira', 'slack +']);
  });

  test('an add-another row names the workspace and keeps the same tool', () => {
    const [row] = mcpConnectRows([CONNECT_SERVERS[2]!], [{ server: 'slack', status: 'connected' }]);
    expect(row?.server.id).toBe('slack');
    expect(mcpConnectRowCopy(row!)).toEqual({
      title: 'Add another Slack workspace',
      help: 'Sign in to one more workspace. Each workspace is its own connection.',
    });
    expect(MCP_ADD_ANOTHER_HELP).toBe('Sign in to one more workspace. Each workspace is its own connection.');
    expect(
      mcpConnectRowCopy({ server: { id: 'teams', label: 'Teams', multipleAccounts: true }, addAnother: true })
        .title,
    ).toBe('Add another Teams workspace');
    expect(mcpConnectRowCopy({ server: { id: 'linear', label: 'Linear' }, addAnother: false })).toEqual({
      title: 'Linear',
      help: '',
    });
  });

  test('the heading count does not count an add-another row as available', () => {
    expect(mcpConnectionsCountLine(0, mcpConnectRows(CONNECT_SERVERS, []))).toBe('3 available');
    expect(
      mcpConnectionsCountLine(1, mcpConnectRows(CONNECT_SERVERS, [{ server: 'slack', status: 'connected' }])),
    ).toBe('1 connected · 2 available');
    const everything = [
      { server: 'github', status: 'connected' },
      { server: 'jira', status: 'connected' },
      { server: 'slack', status: 'connected' },
      { server: 'slack', status: 'connected' },
    ];
    expect(mcpConnectionsCountLine(everything.length, mcpConnectRows(CONNECT_SERVERS, everything))).toBe(
      '4 connected · 0 available',
    );
    expect(mcpConnectionsCountLine(0, [])).toBe('0 available');
  });
});

describe('Confluence pages from the Atlassian sign-in', () => {
  test('a jira page reads as Confluence and a jira ticket stays Jira', () => {
    expect(isConfluencePage({ server: 'jira', kind: 'page' })).toBe(true);
    expect(isConfluencePage({ server: 'jira', kind: 'ticket' })).toBe(false);
    expect(isConfluencePage({ server: 'github', kind: 'page' })).toBe(false);
    expect(mcpItemSourceLabel({ server: 'jira', kind: 'page' })).toBe('Confluence');
    expect(mcpItemSourceLabel({ server: 'jira', kind: 'ticket' })).toBe('Jira');
    expect(mcpItemSourceLabel({ server: 'github', kind: 'pull_request' })).toBe('GitHub');
    expect(mcpItemSourceLabel({ server: 'linear', kind: 'issue' })).toBe('linear');
  });

  test('the brief reason line and the footer service name Confluence', () => {
    expect(connectedItemReason({ server: 'jira', kind: 'page', title: 'Launch plan' })).toBe(
      'Confluence page',
    );
    expect(
      connectedItemReason({ server: 'slack', kind: 'message', title: 'Hi', state: 'mentioned you' }),
    ).toBe('Slack message, mentioned you');
    expect(briefServiceIdForMcpItem({ server: 'jira', kind: 'page' })).toBe('confluence');
    expect(briefServiceIdForMcpItem({ server: 'jira', kind: 'ticket' })).toBe('jira');
    const services = briefServicesFromIds(['jira', 'confluence', 'Confluence']);
    expect(services.map((service) => service.label)).toEqual(['Jira', 'Confluence']);
    expect(services[1]?.logoSvg).toContain('aria-label="Confluence"');
  });

  test('the Confluence logo and name render for the confluence display id', () => {
    expect(renderToStaticMarkup(<ConnectionLogo server="confluence" />)).toContain('aria-label="Confluence"');
    expect(renderToStaticMarkup(<ProviderLogo provider="confluence" />)).toContain('aria-label="Confluence"');
    expect(renderToStaticMarkup(<ConnectionLogo server="jira" />)).toContain('aria-label="Jira"');
    expect(providerDisplayName('confluence')).toBe('Confluence');
  });
});
