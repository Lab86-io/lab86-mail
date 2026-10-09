import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConnectionLogo, ProviderLogo, providerDisplayName } from '../components/icons/provider-logos';
import { McpConnectionIdentity, McpConnectionTitle } from '../components/settings/McpConnectionNotes';
import { connectedItemReason } from '../lib/mail/brief-connected';
import { briefServiceIdForMcpItem, briefServicesFromIds } from '../lib/mail/brief-services';
import {
  isConfluencePage,
  mcpConnectionDisplay,
  mcpConnectionLabel,
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
