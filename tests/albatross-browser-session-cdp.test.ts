import { beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * The default connector path: playwright-core over CDP. The module is mocked
 * at the loader level, so the lazy import inside the connector resolves to
 * this fake and the real network is never touched.
 */

const visited: string[] = [];
let innerTextThrows = false;
let closed = 0;

const backgroundPage = {
  goto: async () => null,
  url: () => 'https://stale.example/first-tab',
  title: async () => 'Stale first tab',
  innerText: async () => 'stale',
};

const fakePage = {
  goto: async (url: string) => {
    visited.push(url);
    return null;
  },
  url: () => 'https://county.example/confirmation',
  title: async () => 'Application received',
  innerText: async () => {
    if (innerTextThrows) throw new Error('detached');
    return '  reference   AB-1234  ';
  },
};

mock.module('playwright-core', () => ({
  chromium: {
    connectOverCDP: async () => ({
      // Two open tabs: the connector must act on the LAST one, where the
      // user is working, never the first.
      contexts: () => [{ pages: () => [backgroundPage, fakePage] }],
      close: async () => {
        closed += 1;
      },
    }),
  },
}));

const { navigateSession, readSessionPage } = await import('../lib/albatross/browser-session');

beforeEach(() => {
  visited.length = 0;
  innerTextThrows = false;
  closed = 0;
});

describe('default CDP connector', () => {
  test('navigate drives the last open page and closes the connection', async () => {
    await navigateSession('wss://connect.example/bb', 'https://county.example/form');
    expect(visited).toEqual(['https://county.example/form']);
    expect(closed).toBe(1);
  });

  test('read acts on the last open page, collapses whitespace, and tolerates a detached body', async () => {
    const state = await readSessionPage('wss://connect.example/bb');
    expect(state.url).not.toBe('https://stale.example/first-tab');
    expect(state).toEqual({
      url: 'https://county.example/confirmation',
      title: 'Application received',
      text: 'reference AB-1234',
    });

    innerTextThrows = true;
    const empty = await readSessionPage('wss://connect.example/bb');
    expect(empty.text).toBe('');
    expect(closed).toBe(2);
  });
});
