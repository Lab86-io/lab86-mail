import { afterEach, describe, expect, test } from 'bun:test';
import {
  closePipWindow,
  getPipWindow,
  openPipWindow,
  pipSupported,
  subscribePipWindow,
} from '../lib/albatross/pip-window';

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const originalMutationObserver = globalThis.MutationObserver;
const originalGetComputedStyle = globalThis.getComputedStyle;

afterEach(() => {
  closePipWindow();
  Object.assign(globalThis, {
    window: originalWindow,
    document: originalDocument,
    MutationObserver: originalMutationObserver,
    getComputedStyle: originalGetComputedStyle,
  });
});

function installPipEnvironment({ reject = false }: { reject?: boolean } = {}) {
  const appended: any[] = [];
  const handlers = new Map<string, () => void>();
  let requestCount = 0;
  let disconnectCount = 0;
  let capturedOptions: any;
  const target = {
    closed: false,
    document: {
      createElement: (tag: string) => ({ tag, rel: '', href: '', textContent: '' }),
      head: { appendChild: (node: any) => appended.push(node) },
      documentElement: { className: '', style: {} as any, setAttribute: () => undefined },
      body: { style: {} as any },
      title: '',
    },
    addEventListener: (type: string, listener: () => void) => handlers.set(type, listener),
    close() {
      this.closed = true;
    },
  } as any;
  const externalSheet: any = { ownerNode: { href: 'https://example.test/app.css' } };
  Object.defineProperty(externalSheet, 'cssRules', {
    get() {
      throw new Error('cross-origin stylesheet');
    },
  });
  const sourceDocument = {
    styleSheets: [{ cssRules: [{ cssText: ':root{--color-bg:white}' }] }, externalSheet],
    documentElement: {
      className: 'dark',
      style: { colorScheme: 'dark' },
      getAttribute: (name: string) => (name === 'style' ? '--accent: green' : null),
    },
  } as any;
  class Observer {
    constructor(private readonly listener: () => void) {}
    observe() {
      this.listener();
    }
    disconnect() {
      disconnectCount += 1;
    }
  }
  const api = {
    window: null,
    requestWindow: async (options: any) => {
      requestCount += 1;
      capturedOptions = options;
      if (reject) throw new Error('denied');
      return target;
    },
  };
  Object.assign(globalThis, {
    window: { documentPictureInPicture: api },
    document: sourceDocument,
    MutationObserver: Observer,
    getComputedStyle: () => ({ colorScheme: 'light' }),
  });
  return {
    appended,
    capturedOptions: () => capturedOptions,
    handlers,
    target,
    requestCount: () => requestCount,
    disconnectCount: () => disconnectCount,
  };
}

describe('Document Picture-in-Picture host', () => {
  test('opens once, mirrors theme, notifies subscribers, and handles pagehide', async () => {
    const env = installPipEnvironment();
    let notifications = 0;
    const unsubscribe = subscribePipWindow(() => {
      notifications += 1;
    });
    expect(pipSupported()).toBe(true);
    await expect(openPipWindow()).resolves.toBe(env.target);
    expect(getPipWindow()).toBe(env.target);
    expect(env.requestCount()).toBe(1);
    expect(env.capturedOptions()).toEqual({ width: 360, height: 150 });
    expect(env.appended.map((node) => node.tag)).toEqual(['style', 'link']);
    expect(env.target.document.documentElement.className).toBe('dark');
    expect(env.target.document.title).toBe('Albatross');
    await expect(openPipWindow()).resolves.toBe(env.target);
    expect(env.requestCount()).toBe(1);

    env.handlers.get('pagehide')?.();
    expect(getPipWindow()).toBeNull();
    expect(env.disconnectCount()).toBeGreaterThan(0);
    expect(notifications).toBe(2);
    unsubscribe();
  });

  test('closes explicitly', async () => {
    const env = installPipEnvironment();
    await openPipWindow();
    closePipWindow();
    expect(env.target.closed).toBe(true);
    expect(getPipWindow()).toBeNull();
  });

  test('returns null when a request is denied', async () => {
    const denied = installPipEnvironment({ reject: true });
    await expect(openPipWindow()).resolves.toBeNull();
    expect(denied.requestCount()).toBe(1);
    expect(denied.capturedOptions()).toEqual({ width: 360, height: 150 });
  });

  test('returns null and reports unsupported when the host API is absent', async () => {
    Object.assign(globalThis, { window: {} });
    expect(pipSupported()).toBe(false);
    await expect(openPipWindow()).resolves.toBeNull();
  });
});
