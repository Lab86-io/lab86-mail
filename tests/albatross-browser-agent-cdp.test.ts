import { beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * The step runner's default connector: playwright-core over CDP. The module
 * is mocked at the loader level, so the lazy import inside the connector
 * resolves to this fake and no real browser or network is touched.
 */

type Event = unknown[];
const events: Event[] = [];
let pages: any[] = [];
let contexts: any[] = [];
let closed = 0;
let settleFails = false;
let innerTextFails = false;
let evaluateFails = false;
let element: Record<string, unknown> = {};

function makePage(name: string) {
  return {
    goto: async (url: string, options: unknown) => {
      events.push([name, 'goto', url, options]);
    },
    url: () => `https://${name}.example/`,
    title: async () => `${name} title`,
    ariaSnapshot: async (options: unknown) => {
      events.push([name, 'snapshot', options]);
      return `- button "${name}" [ref=e1]`;
    },
    locator: (selector: string) => ({
      click: async (options: unknown) => {
        events.push([name, 'click', selector, options]);
      },
      fill: async (text: string, options: unknown) => {
        events.push([name, 'fill', selector, text, options]);
      },
      selectOption: async (values: string[], options: unknown) => {
        events.push([name, 'select', selector, values, options]);
      },
      evaluate: async (read: (target: unknown) => unknown) => {
        if (evaluateFails) throw new Error('detached');
        return read(element);
      },
    }),
    keyboard: {
      press: async (key: string) => {
        events.push([name, 'press', key]);
      },
    },
    waitForLoadState: async (state: string) => {
      events.push([name, 'settle', state]);
      if (settleFails) throw new Error('timeout');
    },
    goBack: async (options: unknown) => {
      events.push([name, 'back', options]);
    },
    waitForTimeout: async (ms: number) => {
      events.push([name, 'wait', ms]);
    },
    innerText: async (selector: string) => {
      if (innerTextFails) throw new Error('detached');
      return `${name} ${selector} text`;
    },
  };
}

const context = {
  pages: () => pages,
  newPage: async () => {
    const page = makePage('blank');
    pages.push(page);
    return page;
  },
};

mock.module('playwright-core', () => ({
  chromium: {
    connectOverCDP: async (url: string) => {
      events.push(['connect', url]);
      return {
        contexts: () => contexts,
        close: async () => {
          closed += 1;
        },
      };
    },
  },
}));

const { playwrightAgentConnector } = await import('../lib/albatross/browser-agent');

beforeEach(() => {
  events.length = 0;
  pages = [makePage('first'), makePage('newest')];
  contexts = [context];
  closed = 0;
  settleFails = false;
  innerTextFails = false;
  evaluateFails = false;
  element = {};
});

describe('playwrightAgentConnector', () => {
  test('connects over CDP and acts on the newest tab', async () => {
    const connection = await playwrightAgentConnector('wss://connect.example/bb-1');
    const page = await connection.page();
    expect(events[0]).toEqual(['connect', 'wss://connect.example/bb-1']);
    expect(page?.url()).toBe('https://newest.example/');
    expect(await page?.title()).toBe('newest title');
    expect(await page?.snapshot()).toBe('- button "newest" [ref=e1]');
    expect(events.at(-1)).toEqual(['newest', 'snapshot', { mode: 'ai', timeout: 12_000 }]);
  });

  test('opens a tab when the context has none, and is null without a context', async () => {
    pages = [];
    const connection = await playwrightAgentConnector('wss://connect.example/bb-1');
    expect((await connection.page())?.url()).toBe('https://blank.example/');

    contexts = [];
    const empty = await playwrightAgentConnector('wss://connect.example/bb-2');
    expect(await empty.page()).toBeNull();
  });

  test('goto, fill, select, back, and wait use the page with their timeouts', async () => {
    const page = await (await playwrightAgentConnector('wss://c')).page();
    await page?.goto('https://county.example/form');
    await page?.fill('e3', 'Ada');
    await page?.select('e4', ['US']);
    await page?.back();
    await page?.wait(2_000);
    expect(events.slice(1)).toEqual([
      ['newest', 'goto', 'https://county.example/form', { waitUntil: 'domcontentloaded', timeout: 25_000 }],
      ['newest', 'fill', 'aria-ref=e3', 'Ada', { timeout: 12_000 }],
      ['newest', 'select', 'aria-ref=e4', ['US'], { timeout: 12_000 }],
      ['newest', 'back', { waitUntil: 'domcontentloaded', timeout: 25_000 }],
      ['newest', 'wait', 2_000],
    ]);
  });

  test('click and press settle the page, and a popup becomes the page', async () => {
    const page = await (await playwrightAgentConnector('wss://c')).page();
    await page?.click('e1');
    expect(events.slice(1)).toEqual([
      ['newest', 'click', 'aria-ref=e1', { timeout: 12_000 }],
      ['newest', 'settle', 'domcontentloaded'],
    ]);

    // The click opened a popup: later calls follow the new newest tab.
    pages.push(makePage('popup'));
    settleFails = true;
    await page?.press('Tab');
    expect(events.slice(-2)).toEqual([
      ['popup', 'press', 'Tab'],
      ['popup', 'settle', 'domcontentloaded'],
    ]);
    expect(page?.url()).toBe('https://popup.example/');
    expect(await page?.title()).toBe('popup title');
  });

  test('inputKind reads the type and autocomplete, and is null when the element is gone', async () => {
    const page = await (await playwrightAgentConnector('wss://c')).page();
    element = {
      type: 'password',
      getAttribute: (name: string) => (name === 'autocomplete' ? 'current-password' : null),
    };
    expect(await page?.inputKind('e2')).toEqual({ type: 'password', autocomplete: 'current-password' });
    element = { type: 'text', autocomplete: 'email' };
    expect(await page?.inputKind('e2')).toEqual({ type: 'text', autocomplete: 'email' });
    element = {};
    expect(await page?.inputKind('e2')).toEqual({ type: '', autocomplete: '' });
    evaluateFails = true;
    expect(await page?.inputKind('e2')).toBeNull();
  });

  test('text reads the body and is empty when the body is gone', async () => {
    const page = await (await playwrightAgentConnector('wss://c')).page();
    expect(await page?.text()).toBe('newest body text');
    innerTextFails = true;
    expect(await page?.text()).toBe('');
  });

  test('close disconnects the client', async () => {
    const connection = await playwrightAgentConnector('wss://c');
    await connection.close();
    expect(closed).toBe(1);
  });
});
