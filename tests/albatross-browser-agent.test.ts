import { describe, expect, test } from 'bun:test';
import {
  AgentBrowser,
  type AgentPage,
  BrowserHandoffRequired,
  compactSnapshot,
  elementForRef,
  enterMaySubmit,
  isFinalAction,
  isSecretField,
  SNAPSHOT_MAX_CHARS,
  safeBrowserUrl,
} from '../lib/albatross/browser-agent';

const SNAPSHOT = [
  '- generic [ref=e1]:',
  '  - banner [ref=e2]:',
  '    - link "Home" [ref=e3] [cursor=pointer]:',
  '      - /url: /',
  '  - button "Accept cookies" [ref=e4] [cursor=pointer]',
  '  - textbox "Email" [ref=e5]',
  '  - textbox "Password" [ref=e6]',
  '  - textbox "Notes" [ref=e7]',
  '  - searchbox "Search the site" [ref=e8]',
  '  - button "Pay now" [ref=e9] [cursor=pointer]',
  '  - combobox "Country" [ref=e10]',
  '  - button "Continue" [ref=e11]',
  '  - textbox "Card holder" [ref=f1e2]',
].join('\n');

type Call = [string, ...unknown[]];

function fakePage(overrides: Partial<AgentPage> = {}, snapshot = SNAPSHOT) {
  const calls: Call[] = [];
  const page: AgentPage = {
    goto: async (url) => {
      calls.push(['goto', url]);
    },
    url: () => 'https://county.example/form',
    title: async () => 'County form',
    snapshot: async () => snapshot,
    click: async (ref) => {
      calls.push(['click', ref]);
    },
    fill: async (ref, text) => {
      calls.push(['fill', ref, text]);
    },
    select: async (ref, values) => {
      calls.push(['select', ref, values]);
    },
    press: async (key) => {
      calls.push(['press', key]);
    },
    back: async () => {
      calls.push(['back']);
    },
    wait: async (ms) => {
      calls.push(['wait', ms]);
    },
    inputKind: async () => null,
    text: async () => '  Your   reference\n\n is  AB-1234.  ',
    ...overrides,
  };
  return { page, calls };
}

async function readyBrowser(overrides: Partial<AgentPage> = {}, snapshot = SNAPSHOT) {
  const { page, calls } = fakePage(overrides, snapshot);
  const browser = new AgentBrowser(page);
  await browser.snapshot();
  return { browser, calls };
}

async function handoffReason(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BrowserHandoffRequired);
    expect((error as BrowserHandoffRequired).name).toBe('BrowserHandoffRequired');
    return (error as BrowserHandoffRequired).reason;
  }
  throw new Error('expected a handoff');
}

describe('elementForRef', () => {
  test('reads the role and the name on the line of the ref', () => {
    expect(elementForRef(SNAPSHOT, 'e9')).toEqual({ role: 'button', name: 'Pay now' });
    expect(elementForRef(SNAPSHOT, 'f1e2')).toEqual({ role: 'textbox', name: 'Card holder' });
  });

  test('matches the whole ref, so e1 never matches e10', () => {
    expect(elementForRef(SNAPSHOT, 'e1')).toEqual({ role: 'generic', name: '' });
    expect(elementForRef(SNAPSHOT, 'e10')).toEqual({ role: 'combobox', name: 'Country' });
  });

  test('a missing ref is null and a line without a role is generic', () => {
    expect(elementForRef(SNAPSHOT, 'e99')).toBeNull();
    expect(elementForRef('  [ref=e30] loose text', 'e30')).toEqual({ role: 'generic', name: '' });
  });

  test('unescapes quotes in the name and lowercases the role', () => {
    expect(elementForRef('- Button "Say \\"hi\\"" [ref=e1]', 'e1')).toEqual({
      role: 'button',
      name: 'Say "hi"',
    });
  });
});

describe('isSecretField', () => {
  test('password type and secret autocomplete values are secret', () => {
    expect(isSecretField({ role: 'textbox', name: 'Login' }, { type: 'PASSWORD' })).toBe(true);
    expect(isSecretField({ role: 'textbox', name: 'Code' }, { autocomplete: 'one-time-code' })).toBe(true);
    expect(isSecretField({ role: 'textbox', name: 'Number' }, { autocomplete: 'cc-number' })).toBe(true);
    expect(isSecretField({ role: 'textbox', name: 'x' }, { autocomplete: 'current-password' })).toBe(true);
  });

  test('secret names are secret without input data', () => {
    for (const name of [
      'Password',
      'Verification code',
      'One-time code',
      '2FA',
      'CVV',
      'Card number',
      'PIN',
      'SSN',
      'Routing number',
    ])
      expect(isSecretField({ role: 'textbox', name })).toBe(true);
  });

  test('ordinary fields are not secret', () => {
    expect(isSecretField({ role: 'textbox', name: 'Email' }, { type: 'email', autocomplete: 'email' })).toBe(
      false,
    );
    expect(isSecretField({ role: 'textbox', name: 'Shipping address' }, null)).toBe(false);
    expect(isSecretField(null)).toBe(false);
  });
});

describe('isFinalAction', () => {
  test('controls that pay, buy, sign, accept, send, submit, or delete are final', () => {
    for (const name of [
      'Pay now',
      'Place order',
      'Checkout',
      'Book now',
      'I agree',
      'Submit',
      'Delete',
      'Send',
      'Cancel my subscription',
      'Unsubscribe',
      'Start free trial',
      'File the dispute',
    ])
      expect(isFinalAction({ role: 'button', name })).toBe(true);
    expect(isFinalAction({ role: 'checkbox', name: 'Accept the terms' })).toBe(true);
    expect(isFinalAction({ role: 'link', name: 'Transfer' })).toBe(true);
  });

  test('cookie banners, code requests, search, filter, and sort are harmless', () => {
    for (const name of [
      'Accept cookies',
      'Send me a code',
      'Send me a link',
      'Resend code',
      'Search',
      'Filter results',
      'Sort by price',
    ])
      expect(isFinalAction({ role: 'button', name })).toBe(false);
  });

  test('a harmless word does not hide a pay, buy, purchase, submit, or agree word', () => {
    expect(isFinalAction({ role: 'button', name: 'Submit search' })).toBe(true);
    expect(isFinalAction({ role: 'button', name: 'Accept all cookies and pay' })).toBe(true);
  });

  test('ordinary controls, non-clickable roles, empty names, and null are not final', () => {
    expect(isFinalAction({ role: 'button', name: 'Continue' })).toBe(false);
    expect(isFinalAction({ role: 'button', name: 'Booking details' })).toBe(false);
    expect(isFinalAction({ role: 'textbox', name: 'Pay' })).toBe(false);
    expect(isFinalAction({ role: 'button', name: '' })).toBe(false);
    expect(isFinalAction(null)).toBe(false);
  });
});

describe('enterMaySubmit', () => {
  test('search boxes and search-like names may submit', () => {
    expect(enterMaySubmit({ role: 'searchbox', name: '' })).toBe(true);
    expect(enterMaySubmit({ role: 'textbox', name: 'Find a store' })).toBe(true);
    expect(enterMaySubmit({ role: 'textbox', name: 'ZIP code' })).toBe(true);
    expect(enterMaySubmit({ role: 'combobox', name: 'City' })).toBe(true);
  });

  test('other fields and null may not submit', () => {
    expect(enterMaySubmit({ role: 'textbox', name: 'Notes' })).toBe(false);
    expect(enterMaySubmit(null)).toBe(false);
  });
});

describe('safeBrowserUrl', () => {
  test('accepts public http and https pages and normalizes them', () => {
    expect(safeBrowserUrl('  https://example.com  ')).toBe('https://example.com/');
    expect(safeBrowserUrl('http://example.com/a b')).toBe('http://example.com/a%20b');
  });

  test('rejects other schemes', () => {
    for (const raw of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,hi',
      'chrome://settings',
      'ftp://example.com/file',
    ])
      expect(safeBrowserUrl(raw)).toBeNull();
  });

  test('rejects localhost and private addresses', () => {
    for (const raw of [
      'http://localhost:3000/',
      'http://LOCALHOST/',
      'http://127.0.0.1/',
      'http://2130706433/',
      'http://10.0.0.5/',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/',
    ])
      expect(safeBrowserUrl(raw)).toBeNull();
  });

  test('rejects text that is not a URL', () => {
    expect(safeBrowserUrl('not a url')).toBeNull();
    expect(safeBrowserUrl('')).toBeNull();
  });
});

describe('compactSnapshot', () => {
  test('removes cursor hints, bare generic lines, blank lines, and trailing space', () => {
    const raw = [
      '- generic',
      '- button "Go" [ref=e1] [cursor=pointer]   ',
      '',
      '   ',
      '- generic [ref=e2]:',
    ].join('\n');
    expect(compactSnapshot(raw)).toEqual({
      text: '- button "Go" [ref=e1]\n- generic [ref=e2]:',
      truncated: false,
    });
  });

  test('shortens a long link target to 120 characters and keeps a short one', () => {
    const long = `https://example.com/${'a'.repeat(200)}`;
    const short = 'https://example.com/short';
    const { text } = compactSnapshot(`  - /url: ${long}\n  - /url: ${short}`);
    const [first, second] = text.split('\n');
    expect(first).toBe(`  - /url: ${long.slice(0, 120)}…`);
    expect(second).toBe(`  - /url: ${short}`);
  });

  test('find keeps only lines with one of its words and ignores one-letter words', () => {
    const { text } = compactSnapshot(SNAPSHOT, { find: 'PAY, country x' });
    expect(text).toBe('  - button "Pay now" [ref=e9]\n  - combobox "Country" [ref=e10]');
    expect(compactSnapshot(SNAPSHOT, { find: 'a' }).text).toContain('[ref=e11]');
  });

  test('a cut snapshot says so and keeps the lines that fit', () => {
    const raw = ['- button "One" [ref=e1]', '- button "Two" [ref=e2]', '- button "Three" [ref=e3]'].join(
      '\n',
    );
    const result = compactSnapshot(raw, { maxChars: 50 });
    expect(result.truncated).toBe(true);
    expect(result.text).toBe(
      '- button "One" [ref=e1]\n- button "Two" [ref=e2]\n… The page continues. Call browser_snapshot with find to read a part.',
    );
  });

  test('the default limit is SNAPSHOT_MAX_CHARS', () => {
    const line = '- button "Item" [ref=e1]';
    const raw = Array.from({ length: Math.ceil(SNAPSHOT_MAX_CHARS / line.length) + 5 }, () => line).join(
      '\n',
    );
    expect(compactSnapshot(raw).truncated).toBe(true);
    expect(compactSnapshot(raw.slice(0, 1_000)).truncated).toBe(false);
  });
});

describe('AgentBrowser', () => {
  test('open refuses a bad URL and never navigates', async () => {
    const { page, calls } = fakePage();
    const browser = new AgentBrowser(page);
    await expect(browser.open('file:///etc/passwd')).rejects.toThrow(
      'Only public http and https pages can be opened.',
    );
    await expect(browser.open('http://localhost:3000')).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  test('open navigates and returns the page view', async () => {
    const { page, calls } = fakePage();
    const view = await new AgentBrowser(page).open('https://county.example/form');
    expect(calls).toEqual([['goto', 'https://county.example/form']]);
    expect(view.url).toBe('https://county.example/form');
    expect(view.title).toBe('County form');
    expect(view.truncated).toBe(false);
    expect(view.snapshot).toContain('- button "Pay now" [ref=e9]');
    expect(view.snapshot).not.toContain('[cursor=pointer]');
  });

  test('a failed title becomes empty and a long title is cut', async () => {
    const failed = await new AgentBrowser(
      fakePage({ title: async () => Promise.reject(new Error('detached')) }).page,
    ).snapshot();
    expect(failed.title).toBe('');
    const long = await new AgentBrowser(fakePage({ title: async () => 'T'.repeat(500) }).page).snapshot();
    expect(long.title).toHaveLength(300);
  });

  test('snapshot passes find through', async () => {
    const { page } = fakePage();
    const view = await new AgentBrowser(page).snapshot('continue');
    expect(view.snapshot).toBe('  - button "Continue" [ref=e11]');
  });

  test('click on a final action hands off and never clicks', async () => {
    const { browser, calls } = await readyBrowser();
    expect(await handoffReason(browser.click('e9'))).toBe('final_action');
    await expect(browser.click('e9')).rejects.toThrow('"Pay now" commits the user.');
    expect(calls).toEqual([]);
  });

  test('click on an ordinary control clicks and reads the page again', async () => {
    const { browser, calls } = await readyBrowser();
    const view = await browser.click('e11');
    expect(calls).toEqual([['click', 'e11']]);
    expect(view.url).toBe('https://county.example/form');
    await browser.click('e4');
    expect(calls.at(-1)).toEqual(['click', 'e4']);
  });

  test('refs must look like refs and must be in the latest snapshot', async () => {
    const { page } = fakePage();
    const fresh = new AgentBrowser(page);
    await expect(fresh.click('e11')).rejects.toThrow('Ref e11 is not in the latest snapshot.');
    const { browser } = await readyBrowser();
    await expect(browser.click('button')).rejects.toThrow('"button" is not a ref from the snapshot.');
    await expect(browser.click('e99')).rejects.toThrow('Call browser_snapshot first.');
    await expect(browser.type('x1', 'hi')).rejects.toThrow('is not a ref');
  });

  test('type refuses a secret field by name', async () => {
    const { browser, calls } = await readyBrowser();
    expect(await handoffReason(browser.type('e6', 'hunter2'))).toBe('secret');
    expect(calls).toEqual([]);
  });

  test('type refuses a secret field by input type password', async () => {
    const { browser, calls } = await readyBrowser({ inputKind: async () => ({ type: 'password' }) });
    expect(await handoffReason(browser.type('e5', 'hunter2'))).toBe('secret');
    expect(calls).toEqual([]);
  });

  test('type with submit refuses a field that is not search-like', async () => {
    const { browser, calls } = await readyBrowser();
    expect(await handoffReason(browser.type('e7', 'a note', true))).toBe('submit');
    expect(calls).toEqual([]);
  });

  test('type with submit in a search field fills and presses Enter', async () => {
    const { browser, calls } = await readyBrowser();
    await browser.type('e8', 'dispute form', true);
    expect(calls).toEqual([
      ['fill', 'e8', 'dispute form'],
      ['press', 'Enter'],
    ]);
  });

  test('type without submit only fills, also inside a frame', async () => {
    const { browser, calls } = await readyBrowser();
    await browser.type('e5', 'me@example.com');
    await browser.type('f1e2', 'Ada Lovelace');
    expect(calls).toEqual([
      ['fill', 'e5', 'me@example.com'],
      ['fill', 'f1e2', 'Ada Lovelace'],
    ]);
  });

  test('select caps the values at 10', async () => {
    const { browser, calls } = await readyBrowser();
    const values = Array.from({ length: 14 }, (_, index) => `v${index}`);
    await browser.select('e10', values);
    expect(calls).toEqual([['select', 'e10', values.slice(0, 10)]]);
    await expect(browser.select('e77', ['x'])).rejects.toThrow('not in the latest snapshot');
  });

  test('press allows only safe keys', async () => {
    const { browser, calls } = await readyBrowser();
    await browser.press('Tab');
    await browser.press('Shift+Tab');
    await expect(browser.press('Enter')).rejects.toThrow('Key Enter is not allowed.');
    await expect(browser.press('Control+A')).rejects.toThrow('Allowed: Tab, Shift+Tab');
    expect(calls).toEqual([
      ['press', 'Tab'],
      ['press', 'Shift+Tab'],
    ]);
  });

  test('back goes back and reads the page', async () => {
    const { browser, calls } = await readyBrowser();
    const view = await browser.back();
    expect(calls).toEqual([['back']]);
    expect(view.title).toBe('County form');
  });

  test('wait clamps to 1 to 10 seconds', async () => {
    const { browser, calls } = await readyBrowser();
    await browser.wait(0);
    await browser.wait(3);
    await browser.wait(60);
    expect(calls).toEqual([
      ['wait', 1_000],
      ['wait', 3_000],
      ['wait', 10_000],
    ]);
  });

  test('readText collapses white space and trims', async () => {
    const { page } = fakePage();
    expect(await new AgentBrowser(page).readText()).toEqual({
      url: 'https://county.example/form',
      title: 'County form',
      text: 'Your reference is AB-1234.',
    });
  });

  test('readText survives a failed title and cuts long text', async () => {
    const { page } = fakePage({
      title: async () => Promise.reject(new Error('gone')),
      text: async () => 'word '.repeat(3_000),
    });
    const result = await new AgentBrowser(page).readText();
    expect(result.title).toBe('');
    expect(result.text).toHaveLength(6_000);
  });
});

describe('private hosts and keys (review fixes)', () => {
  test('refuses every private, loopback, link-local, and unspecified host', async () => {
    const { isPrivateHost, safeBrowserUrl } = await import('../lib/albatross/browser-agent');
    for (const url of [
      'http://172.16.0.1/',
      'http://172.31.255.255/',
      'http://0.0.0.0/',
      'http://100.64.0.1/',
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:7f00:1]/',
      'http://foo.localhost/',
      'http://printer.local/',
      'http://[fd00::1]/',
      'http://[fe80::1]/',
      'http://[::]/',
    ])
      expect(safeBrowserUrl(url)).toBeNull();
    for (const url of [
      'https://172.32.0.1/',
      'https://8.8.8.8/',
      'https://[2606:4700::1111]/',
      'https://example.com/',
    ])
      expect(safeBrowserUrl(url)).not.toBeNull();
    expect(isPrivateHost('::ffff:abc')).toBe(true);
    expect(isPrivateHost('::ffff:808:808')).toBe(false);
    expect(isPrivateHost('1.2.3')).toBe(false);
  });
});

test('Space is not a navigation key: it would press a focused button', async () => {
  const { AgentBrowser } = await import('../lib/albatross/browser-agent');
  const pressed: string[] = [];
  const browser = new AgentBrowser({
    goto: async () => undefined,
    url: () => 'https://shop.example/checkout',
    title: async () => 'Checkout',
    snapshot: async () => '- button "Pay now" [ref=e1]',
    click: async () => undefined,
    fill: async () => undefined,
    select: async () => undefined,
    press: async (key) => {
      pressed.push(key);
    },
    back: async () => undefined,
    wait: async () => undefined,
    inputKind: async () => null,
    text: async () => '',
  });
  await expect(browser.press('Space')).rejects.toThrow('Key Space is not allowed');
  await browser.press('Tab');
  expect(pressed).toEqual(['Tab']);
});
