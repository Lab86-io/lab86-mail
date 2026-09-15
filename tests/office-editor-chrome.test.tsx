import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { JSDOM, VirtualConsole } from 'jsdom';
import type { Root } from 'react-dom/client';

/**
 * The themed document editor chrome in a DOM: the frame applies the URL
 * parameters and the post-load messages only when the session enables the
 * chrome, the title row exposes All tools, and the Albatross click reaches
 * the host. The suite runs in its own process because react-dom decides at
 * load time whether a window exists.
 */
if (process.env.OFFICE_EDITOR_CHROME_DOM_TEST !== '1') {
  test('office editor chrome DOM suite runs isolated from server-first React imports', async () => {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      cwd: process.cwd(),
      env: { ...process.env, OFFICE_EDITOR_CHROME_DOM_TEST: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [output, error, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exit !== 0) throw new Error(`Isolated office editor chrome suite failed:\n${output}\n${error}`);
    expect(exit).toBe(0);
    expect(error).toMatch(/\d+ pass/);
  }, 60_000);
} else {
  const TOUCHED_GLOBALS = [
    'window',
    'document',
    'HTMLElement',
    'HTMLIFrameElement',
    'Element',
    'Node',
    'MessageEvent',
    'navigator',
    'IS_REACT_ACT_ENVIRONMENT',
  ] as const;
  const saved = new Map(
    TOUCHED_GLOBALS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const),
  );
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => {
    // form.submit() is not implemented in jsdom; the frame calls it once per session.
    if (!/not implemented/i.test(String(error?.message))) console.error(error);
  });
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://app.test/',
    pretendToBeVisual: true,
    virtualConsole,
  });
  dom.window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    HTMLIFrameElement: dom.window.HTMLIFrameElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    MessageEvent: dom.window.MessageEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });

  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { CollaboraFrame } = await import('../components/files/CollaboraFrame');
  const { OfficeEditor } = await import('../components/files/OfficeEditor');
  const { useClientStore } = await import('../lib/client-state');
  const { collaboraCssVariables, collaboraUiDefaults } = await import('../lib/documents/collabora-chrome');

  const SERVER = 'https://documents.test';
  const EDITOR_URL = `${SERVER}/browser/abc/cool.html?WOPISrc=https%3A%2F%2Fapp.test%2Fapi%2Foffice%2Fwopi%2Fdoc-1&lang=en-US`;
  const originalFetch = globalThis.fetch;

  function session(chrome: boolean) {
    return {
      provider: 'collabora' as const,
      sessionId: 'session-1',
      documentId: 'doc-1',
      serverUrl: SERVER,
      editorUrl: EDITOR_URL,
      accessToken: 'token-0123456789abcdef',
      accessTokenTtl: Date.now() + 60_000,
      extension: 'docx' as const,
      chrome: { enabled: chrome },
    };
  }
  const metadata = {
    title: 'Plan.docx',
    extension: 'docx',
    currentRevision: 1,
    versions: [{ revision: 1, recovery: false, createdAt: 1 }],
  };

  /** Posted host messages, captured from the frame's content window. */
  let posted: Array<{ MessageId: string; Values: Record<string, unknown>; origin: string }> = [];
  /** The ids of the posted messages without the readiness pings, which jsdom's iframe load also triggers. */
  const postedIds = () =>
    posted
      .filter((message) => message.MessageId !== 'Host_PostmessageReady')
      .map((message) => message.MessageId);
  function frameElement() {
    const frame = document.querySelector('iframe[title="Document editor"]') as HTMLIFrameElement | null;
    if (frame?.contentWindow && !(frame as any).__captured) {
      (frame as any).__captured = true;
      (frame.contentWindow as any).postMessage = (data: string, origin: string) => {
        const message = JSON.parse(data);
        posted.push({ MessageId: message.MessageId, Values: message.Values, origin });
      };
    }
    return frame;
  }
  async function tick(ms = 5) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  }
  async function until<T>(read: () => T | null | undefined | false, label: string, attempts = 200) {
    for (let index = 0; index < attempts; index += 1) {
      const value = read();
      if (value) return value;
      await tick();
    }
    throw new Error(`Timed out: ${label}`);
  }
  async function editorSends(MessageId: string, Values: Record<string, unknown> = {}) {
    const frame = frameElement();
    if (!frame?.contentWindow) throw new Error('No editor frame');
    await act(async () => {
      window.dispatchEvent(
        new window.MessageEvent('message', {
          data: JSON.stringify({ MessageId, Values }),
          origin: SERVER,
          source: frame.contentWindow,
        }),
      );
    });
  }
  function formAction() {
    return (document.querySelector('form[target^="collabora-"]') as HTMLFormElement | null)?.getAttribute(
      'action',
    );
  }
  function button(name: string) {
    return Array.from(document.querySelectorAll('button')).find(
      (element) => element.textContent?.trim() === name || element.getAttribute('aria-label') === name,
    ) as HTMLButtonElement | undefined;
  }

  const roots: Root[] = [];
  const clients: InstanceType<typeof QueryClient>[] = [];
  function mountEditor(chrome: boolean) {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/session') && init?.method === 'POST')
        return Response.json({ ok: true, ...session(chrome) });
      if (url.includes('/api/office/doc-1')) return Response.json({ document: metadata });
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    clients.push(client);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <OfficeEditor documentId="doc-1" onClose={() => {}} />
        </QueryClientProvider>,
      );
    });
  }

  afterEach(async () => {
    for (const root of roots.splice(0)) await act(async () => root.unmount());
    for (const client of clients.splice(0)) client.clear();
    document.body.innerHTML = '';
    posted = [];
    globalThis.fetch = originalFetch;
    useClientStore.setState({ assistantPresentation: 'corner', aiBarOpen: false });
  });
  afterAll(() => {
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  });

  describe('CollaboraFrame with the themed chrome', () => {
    test('adds the URL parameters, posts the ordered messages after load, and routes the button and mode', async () => {
      const events: string[] = [];
      let handle: any = null;
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      roots.push(root);
      act(() => {
        root.render(
          <CollaboraFrame
            ref={(value) => {
              handle = value;
            }}
            session={session(true)}
            theme="dark"
            onReady={(ready) => events.push(`ready:${ready}`)}
            onModified={() => {}}
            onError={(error) => events.push(`error:${error}`)}
            onUiMode={(mode) => events.push(`mode:${mode}`)}
            onAlbatross={() => events.push('albatross')}
          />,
        );
      });
      await until(frameElement, 'frame mounted');
      const action = new URL(formAction()!);
      expect(action.origin).toBe(SERVER);
      expect(action.searchParams.get('ui_defaults')).toBe(collaboraUiDefaults('docx', 'dark'));
      expect(action.searchParams.get('css_variables')).toBe(collaboraCssVariables('dark'));
      expect(action.searchParams.get('WOPISrc')).toBe('https://app.test/api/office/wopi/doc-1');

      await editorSends('App_LoadingStatus', { Status: 'Frame_Ready' });
      expect(posted.map((message) => message.MessageId)).toContain('Host_PostmessageReady');
      expect(postedIds()).toEqual([]);
      await editorSends('App_LoadingStatus', { Status: 'Document_Loaded' });
      expect(postedIds()).toEqual([
        'Hide_Menubar',
        'Hide_Command',
        'Hide_Command',
        'Insert_Button',
        'Send_UNO_Command',
      ]);
      const chrome = posted.filter((message) => message.MessageId !== 'Host_PostmessageReady');
      expect(chrome[1].Values).toEqual({ id: '.uno:Save' });
      expect(chrome[2].Values).toEqual({ id: '.uno:Print' });
      expect(chrome[3].Values).toMatchObject({
        id: 'albatross',
        imgurl: 'https://app.test/office/albatross-toolbar.svg',
        insertBefore: 'undo',
      });
      expect(chrome[4].Values).toMatchObject({ Command: '.uno:ChangeTheme' });
      expect(posted.every((message) => message.origin === SERVER)).toBe(true);
      expect(events).toEqual(['ready:true']);

      // A second Document_Loaded does not repeat the chrome messages.
      await editorSends('App_LoadingStatus', { Status: 'Document_Loaded' });
      expect(posted.filter((message) => message.MessageId === 'Insert_Button')).toHaveLength(1);

      await editorSends('Clicked_Button', { Id: 'albatross' });
      await editorSends('Clicked_Button', { Id: 'other' });
      expect(events.filter((event) => event === 'albatross')).toHaveLength(1);

      expect(handle.uiMode).toBe('classic');
      act(() => handle.setUiMode('notebookbar'));
      expect(posted.at(-1)).toMatchObject({
        MessageId: 'Action_ChangeUIMode',
        Values: { Mode: 'notebookbar' },
      });
      // The mode follows the reply, not the request.
      expect(handle.uiMode).toBe('classic');
      await editorSends('Action_ChangeUIMode_Resp', { Mode: 'notebookbar' });
      expect(handle.uiMode).toBe('notebookbar');
      expect(events.at(-1)).toBe('mode:notebookbar');
      await editorSends('Action_ChangeUIMode_Resp', { Mode: 'sideways' });
      expect(handle.uiMode).toBe('notebookbar');

      // Messages from another origin are ignored.
      await act(async () => {
        window.dispatchEvent(
          new window.MessageEvent('message', {
            data: JSON.stringify({ MessageId: 'Clicked_Button', Values: { Id: 'albatross' } }),
            origin: 'https://attacker.test',
            source: frameElement()!.contentWindow,
          }),
        );
      });
      expect(events.filter((event) => event === 'albatross')).toHaveLength(1);
    });

    test('with the chrome disabled the URL and the post-load traffic are unchanged', async () => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      roots.push(root);
      act(() => {
        root.render(
          <CollaboraFrame
            session={session(false)}
            theme="dark"
            onReady={() => {}}
            onModified={() => {}}
            onError={() => {}}
          />,
        );
      });
      await until(frameElement, 'frame mounted');
      expect(formAction()).toBe(EDITOR_URL);
      await editorSends('App_LoadingStatus', { Status: 'Document_Loaded' });
      expect(posted.length).toBeGreaterThan(0);
      expect(postedIds()).toEqual([]);
    });
  });

  describe('OfficeEditor title row', () => {
    test('shows All tools only for a themed session, enables it after load, and follows the reply', async () => {
      mountEditor(true);
      await until(frameElement, 'editor frame');
      expect(new URL(formAction()!).searchParams.get('ui_defaults')).toContain('UIMode=classic');
      for (const name of ['Back to Files', 'Save', 'Download the saved copy', 'History', 'All tools'])
        expect(button(name) ?? document.querySelector(`[aria-label="${name}"]`)).toBeTruthy();
      await until(() => button('Albatross'), 'Albatross button after metadata');
      const allTools = button('All tools')!;
      expect(allTools.disabled).toBe(true);
      expect(allTools.getAttribute('aria-pressed')).toBe('false');

      await editorSends('App_LoadingStatus', { Status: 'Document_Loaded' });
      expect(postedIds()).toEqual(['Hide_Menubar', 'Hide_Command', 'Hide_Command', 'Insert_Button']);
      await until(() => !button('All tools')!.disabled, 'All tools enabled');
      act(() => button('All tools')!.click());
      expect(posted.at(-1)).toMatchObject({
        MessageId: 'Action_ChangeUIMode',
        Values: { Mode: 'notebookbar' },
      });
      expect(button('All tools')!.getAttribute('aria-pressed')).toBe('false');
      await editorSends('Action_ChangeUIMode_Resp', { Mode: 'notebookbar' });
      const compact = await until(() => button('Compact tools'), 'label after the reply');
      expect(compact.getAttribute('aria-pressed')).toBe('true');
      act(() => compact.click());
      expect(posted.at(-1)).toMatchObject({ MessageId: 'Action_ChangeUIMode', Values: { Mode: 'classic' } });
      await editorSends('Action_ChangeUIMode_Resp', { Mode: 'classic' });
      await until(() => button('All tools'), 'label back to All tools');

      // The editor's Albatross button opens the assistant beside the document.
      expect(useClientStore.getState().assistantPresentation).not.toBe('split');
      await editorSends('Clicked_Button', { Id: 'albatross' });
      expect(useClientStore.getState().assistantPresentation).toBe('split');
      expect(document.body.textContent).not.toMatch(/\bAI\b/);
    });

    test('without the chrome the row has no All tools and the editor URL is untouched', async () => {
      mountEditor(false);
      await until(frameElement, 'editor frame');
      expect(formAction()).toBe(EDITOR_URL);
      expect(button('All tools')).toBeUndefined();
      await editorSends('App_LoadingStatus', { Status: 'Document_Loaded' });
      expect(postedIds()).toEqual([]);
      expect(button('History')).toBeTruthy();
    });
  });
}
