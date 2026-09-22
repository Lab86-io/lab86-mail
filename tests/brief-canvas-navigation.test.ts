import { describe, expect, test } from 'bun:test';
import { navigateBriefAction } from '../components/report/brief-canvas/BriefCanvas';

function harness() {
  const opened: Array<[string, string, string]> = [];
  return {
    opened,
    navigation: {
      setSelectedThread: () => {},
      setThreadAccount: () => {},
      setPrimaryView: () => {},
      setSelectedAreaId: () => {},
      setSelectedWorkId: () => {},
      setPendingReplyBody: () => {},
      setChatScope: () => {},
      setAiBarOpen: () => {},
      openExternal: (url: string, target: '_blank', features: 'noopener,noreferrer') =>
        opened.push([url, target, features]),
    },
  };
}

describe('BriefCanvas navigation', () => {
  test('open_url uses the shared HTTPS-and-host gate before opening a new tab', () => {
    const target = harness();

    navigateBriefAction('open_url', { url: 'https://example.com/action' }, target.navigation);
    expect(target.opened).toEqual([['https://example.com/action', '_blank', 'noopener,noreferrer']]);

    for (const url of ['http://example.com/action', 'javascript:alert(1)', 'not a url', 'https:///']) {
      navigateBriefAction('open_url', { url }, target.navigation);
    }
    expect(target.opened).toHaveLength(1);
  });
});

describe('BriefCanvas action guard', () => {
  test('an action the executor does not know fails with the visible copy', async () => {
    const { BRIEF_UNKNOWN_ACTION_COPY, executeBriefAction } = await import(
      '../components/report/brief-canvas/BriefCanvas'
    );
    expect(BRIEF_UNKNOWN_ACTION_COPY).toBe('The brief cannot run this action yet.');
    await expect(executeBriefAction('summon_dragon', {}, () => {})).rejects.toThrow(
      BRIEF_UNKNOWN_ACTION_COPY,
    );
  });
});
