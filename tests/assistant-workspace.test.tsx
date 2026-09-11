import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import type { ReactNode } from 'react';
import type { Root } from 'react-dom/client';
import type { AssistantPresentation } from '../components/shell/AssistantWorkspace';

if (process.env.ALBATROSS_WORKSPACE_DOM_TEST !== '1') {
  test('assistant workspace DOM suite is independent of server-first React import order', async () => {
    // Other suites can legitimately import react-dom before a window exists.
    // React caches that environment detection; replacing globals cannot reset it.
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      cwd: process.cwd(),
      env: { ...process.env, ALBATROSS_WORKSPACE_DOM_TEST: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [output, error, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exit !== 0) throw new Error(`Isolated workspace suite failed:\n${output}\n${error}`);
    expect(exit).toBe(0);
    expect(error).not.toContain('attachEvent is not a function');
    expect(error).not.toContain('detachEvent is not a function');
    expect(error).toMatch(/\d+ pass/);
  }, 30_000);
} else {
  /* ------------------------------------------------------------------ */
  /* A DOM for the tests that need focus and events                      */
  /* ------------------------------------------------------------------ */

  // react-dom decides at load time whether it has a DOM, so the window must
  // exist before it (and the components) are imported. Every global this file
  // touches is saved by its real key as a property descriptor, so afterAll
  // puts back exactly what was there (including "nothing") and leaves no
  // `IS_REACT_ACT_ENVIRONMENT` or undefined `ResizeObserver` behind for the
  // files bun runs after this one.
  const TOUCHED_GLOBALS = [
    'window',
    'document',
    'HTMLElement',
    'Element',
    'Node',
    'KeyboardEvent',
    'ResizeObserver',
    'IS_REACT_ACT_ENVIRONMENT',
  ] as const;
  const saved = new Map(
    TOUCHED_GLOBALS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const),
  );
  function restoreGlobals() {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
  let reduceMotion = false;
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  dom.window.matchMedia = ((query: string) => ({
    matches: query.includes('reduced-motion') && reduceMotion,
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
    Element: dom.window.Element,
    Node: dom.window.Node,
    KeyboardEvent: dom.window.KeyboardEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;

  const { act, useEffect, useState } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const {
    ASSISTANT_CHAT_LABEL,
    ASSISTANT_CHAT_MIN_PX,
    ASSISTANT_DEFAULT_PAGE_SHARE,
    ASSISTANT_DOUBLE_PRESS_MS,
    ASSISTANT_PAGE_MIN_PX,
    ASSISTANT_SPLIT_MIN_WIDTH_PX,
    AssistantWorkspace,
    clampPageShare,
    escapeClosesAssistant,
    focusTargetOnClose,
    pageShareFromPointer,
    resolveAssistantLayout,
    stepPageShare,
  } = await import('../components/shell/AssistantWorkspace');
  const { ASSISTANT_LAUNCHER_NAME, ASSISTANT_LAUNCHER_PHRASES, AssistantLauncher, nextLauncherPhrase } =
    await import('../components/shell/ShellActions');

  afterAll(() => {
    dom.window.close();
    restoreGlobals();
    expect('IS_REACT_ACT_ENVIRONMENT' in globalThis).toBe(
      saved.get('IS_REACT_ACT_ENVIRONMENT') !== undefined,
    );
    expect('ResizeObserver' in globalThis).toBe(saved.get('ResizeObserver') !== undefined);
  });

  const roots: Root[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) await act(async () => root.unmount());
    document.body.innerHTML = '';
    window.localStorage.clear();
    reduceMotion = false;
  });

  async function mount(element: ReactNode) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => root.render(element));
    return { host, render: (next: ReactNode) => act(async () => root.render(next)) };
  }

  const wait = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  // jsdom has no PointerEvent; React reads the pointer fields off whatever
  // event arrives, so a MouseEvent with the pointer's name is enough. The
  // timestamp is what the seam's double-press window keys off.
  function pointer(target: Element, type: string, init: { clientX: number; timeStamp?: number }) {
    const event = new window.MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: init.clientX,
      button: 0,
    });
    if (init.timeStamp !== undefined) Object.defineProperty(event, 'timeStamp', { value: init.timeStamp });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  }

  function keydown(target: Element, key: string, init: KeyboardEventInit = {}) {
    const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  }

  /* ------------------------------------------------------------------ */
  /* Layout and resize math                                              */
  /* ------------------------------------------------------------------ */

  describe('assistant layout resolution', () => {
    test('closed keeps the page full width whatever was requested', () => {
      for (const presentation of ['corner', 'split', 'full'] as const) {
        expect(resolveAssistantLayout({ open: false, presentation, width: 1400 })).toBe('closed');
        expect(resolveAssistantLayout({ open: false, presentation, mobile: true })).toBe('closed');
      }
    });

    test('a phone is always full-screen chat; desktop follows the request', () => {
      expect(resolveAssistantLayout({ open: true, presentation: 'corner', mobile: true })).toBe('full');
      expect(resolveAssistantLayout({ open: true, presentation: 'split', mobile: true })).toBe('full');
      expect(resolveAssistantLayout({ open: true, presentation: 'corner', width: 1400 })).toBe('corner');
      expect(resolveAssistantLayout({ open: true, presentation: 'split', width: 1400 })).toBe('split');
      expect(resolveAssistantLayout({ open: true, presentation: 'full', width: 1400 })).toBe('full');
    });

    test('a split that cannot honor both minimums paints full instead of overflowing', () => {
      expect(
        resolveAssistantLayout({ open: true, presentation: 'split', width: ASSISTANT_SPLIT_MIN_WIDTH_PX }),
      ).toBe('split');
      expect(
        resolveAssistantLayout({
          open: true,
          presentation: 'split',
          width: ASSISTANT_SPLIT_MIN_WIDTH_PX - 1,
        }),
      ).toBe('full');
      // Unknown width (first paint) trusts the request rather than flashing full.
      expect(resolveAssistantLayout({ open: true, presentation: 'split', width: null })).toBe('split');
      expect(resolveAssistantLayout({ open: true, presentation: 'corner', width: 500 })).toBe('corner');
    });
  });

  describe('split resize math', () => {
    test('the share is clamped so the page keeps 280px and the chat 360px', () => {
      const width = 1206; // 1200 usable after the seam
      expect(clampPageShare(50, width)).toBe(50);
      expect(clampPageShare(5, width)).toBeCloseTo((ASSISTANT_PAGE_MIN_PX / 1200) * 100, 6);
      expect(clampPageShare(95, width)).toBeCloseTo(100 - (ASSISTANT_CHAT_MIN_PX / 1200) * 100, 6);
      expect(clampPageShare(Number.NaN, width)).toBe(ASSISTANT_DEFAULT_PAGE_SHARE);
      // Without a measured width only the percent range is enforced.
      expect(clampPageShare(-10, null)).toBe(0);
      expect(clampPageShare(140, undefined)).toBe(100);
    });

    test('the pointer maps to the seam centre and never leaves the safe range', () => {
      const rect = { left: 100, width: 1206 };
      expect(pageShareFromPointer(100 + 3 + 600, rect)).toBeCloseTo(50, 6);
      expect(pageShareFromPointer(-5000, rect)).toBeCloseTo(clampPageShare(0, rect.width), 6);
      expect(pageShareFromPointer(5000, rect)).toBeCloseTo(clampPageShare(100, rect.width), 6);
      expect(pageShareFromPointer(10, { left: 0, width: 0 })).toBe(ASSISTANT_DEFAULT_PAGE_SHARE);
    });

    test('keys nudge, stride, jump to the ends, reset, and otherwise leave the share alone', () => {
      const width = 1206;
      expect(stepPageShare(50, 'ArrowLeft', { width })).toBe(48);
      expect(stepPageShare(50, 'ArrowRight', { width })).toBe(52);
      expect(stepPageShare(50, 'ArrowLeft', { width, shift: true })).toBe(40);
      expect(stepPageShare(50, 'ArrowRight', { width, shift: true })).toBe(60);
      expect(stepPageShare(50, 'Home', { width })).toBe(clampPageShare(0, width));
      expect(stepPageShare(50, 'End', { width })).toBe(clampPageShare(100, width));
      expect(stepPageShare(31, 'Enter', { width })).toBe(ASSISTANT_DEFAULT_PAGE_SHARE);
      expect(stepPageShare(24, 'ArrowLeft', { width })).toBe(clampPageShare(0, width));
      expect(stepPageShare(50, 'Tab', { width })).toBe(50);
      expect(stepPageShare(50, 'a', { width })).toBe(50);
    });
  });

  describe('escape and focus rules', () => {
    test('Escape closes only when nobody below claimed it and no IME is composing', () => {
      expect(escapeClosesAssistant({ key: 'Escape', defaultPrevented: false })).toBe(true);
      expect(escapeClosesAssistant({ key: 'Escape', defaultPrevented: true })).toBe(false);
      expect(escapeClosesAssistant({ key: 'Escape', defaultPrevented: false, isComposing: true })).toBe(
        false,
      );
      expect(escapeClosesAssistant({ key: 'Enter', defaultPrevented: false })).toBe(false);
    });

    test('focus returns to the opener or launcher only when it was inside the chat', () => {
      const chat = document.createElement('section');
      const inside = document.createElement('button');
      chat.appendChild(inside);
      const opener = document.createElement('button');
      const launcher = document.createElement('button');
      const pageButton = document.createElement('button');
      document.body.append(chat, opener, launcher, pageButton);
      expect(focusTargetOnClose({ activeElement: inside, chat, opener, launcher })).toBe(opener);
      expect(focusTargetOnClose({ activeElement: document.body, chat, opener, launcher })).toBe(opener);
      expect(focusTargetOnClose({ activeElement: null, chat, opener: null, launcher })).toBe(launcher);
      // The opener was unmounted (the launcher hides while the chat is open).
      opener.remove();
      expect(focusTargetOnClose({ activeElement: inside, chat, opener, launcher })).toBe(launcher);
      // A launcher click unmounts the launcher in the opening commit, so the
      // recorded opener is the body; that is never a target.
      expect(focusTargetOnClose({ activeElement: inside, chat, opener: document.body, launcher })).toBe(
        launcher,
      );
      expect(
        focusTargetOnClose({ activeElement: inside, chat, opener: document.documentElement, launcher }),
      ).toBe(launcher);
      expect(
        focusTargetOnClose({ activeElement: inside, chat, opener: document.body, launcher: null }),
      ).toBeNull();
      // Someone working on the page keeps their place.
      expect(focusTargetOnClose({ activeElement: pageButton, chat, opener, launcher })).toBeNull();
      // An opener inside the chat is never a restore target.
      expect(focusTargetOnClose({ activeElement: inside, chat, opener: inside, launcher })).toBe(launcher);
    });
  });

  /* ------------------------------------------------------------------ */
  /* The launcher                                                        */
  /* ------------------------------------------------------------------ */

  describe('assistant launcher', () => {
    test('phrases invite the next action and never describe the person or their mail', () => {
      expect(ASSISTANT_LAUNCHER_PHRASES.length).toBeGreaterThan(1);
      expect(ASSISTANT_LAUNCHER_PHRASES[0]).toBe('Get this off my mind');
      for (const phrase of ASSISTANT_LAUNCHER_PHRASES) {
        expect(phrase).not.toMatch(
          /\b(you'?re|you are|feel|stress|overwhelm|busy|anxious|inbox|email|unread)\b/i,
        );
        expect(phrase).not.toMatch(/[✨⭐★☆]/u);
        expect(phrase.length).toBeLessThanOrEqual(24);
      }
    });

    test('the phrase index advances only while idle and motion is allowed', () => {
      expect(nextLauncherPhrase(0, { idle: true, reduceMotion: false, count: 3 })).toBe(1);
      expect(nextLauncherPhrase(2, { idle: true, reduceMotion: false, count: 3 })).toBe(0);
      expect(nextLauncherPhrase(1, { idle: false, reduceMotion: false, count: 3 })).toBe(1);
      expect(nextLauncherPhrase(1, { idle: true, reduceMotion: true, count: 3 })).toBe(1);
      expect(nextLauncherPhrase(0, { idle: true, reduceMotion: false, count: 1 })).toBe(0);
    });

    test('rotates only while idle, keeps every phrase in the same cell, and pauses on focus', async () => {
      let opened = 0;
      // 250ms is the floor the launcher enforces on any requested cadence.
      const { host } = await mount(
        <AssistantLauncher placement="corner" shortcut="⌘K" onOpen={() => opened++} rotateMs={250} />,
      );
      const button = host.querySelector('button') as HTMLButtonElement;
      expect(button.getAttribute('aria-label')).toBe(ASSISTANT_LAUNCHER_NAME);
      expect(button.getAttribute('aria-keyshortcuts')).toBe('Meta+K Control+K');
      expect(button.dataset.rotating).toBe('true');
      expect(button.dataset.phrase).toBe('0');
      // Every phrase is rendered from the first paint, so width is reserved.
      expect(host.querySelectorAll('.assistant-launcher__measure').length).toBe(
        ASSISTANT_LAUNCHER_PHRASES.length,
      );
      expect(host.querySelector('[aria-live]')).toBeNull();
      await wait(320);
      expect(button.dataset.phrase).toBe('1');
      expect(button.getAttribute('aria-label')).toBe(ASSISTANT_LAUNCHER_NAME);
      expect(host.querySelectorAll('.assistant-launcher__phrase[data-active="true"]').length).toBe(1);

      act(() => button.focus());
      expect(button.dataset.rotating).toBe('false');
      const held = button.dataset.phrase;
      await wait(320);
      expect(button.dataset.phrase).toBe(held);

      act(() => button.click());
      expect(opened).toBe(1);
      act(() => button.blur());
      expect(button.dataset.rotating).toBe('true');
    });

    test('honors prefers-reduced-motion by never rotating', async () => {
      reduceMotion = true;
      const { host } = await mount(
        <AssistantLauncher placement="stacked" shortcut="Ctrl K" onOpen={() => {}} rotateMs={250} />,
      );
      const button = host.querySelector('button') as HTMLButtonElement;
      expect(button.dataset.rotating).toBe('false');
      await wait(320);
      expect(button.dataset.phrase).toBe('0');
      expect(button.dataset.placement).toBe('stacked');
    });
  });

  /* ------------------------------------------------------------------ */
  /* The workspace frame                                                 */
  /* ------------------------------------------------------------------ */

  const mounts = { page: 0, chat: 0 };

  function Page() {
    const [draft, setDraft] = useState('');
    useEffect(() => {
      mounts.page += 1;
    }, []);
    return (
      <div>
        <button type="button" data-page-button="">
          Filter
        </button>
        <textarea aria-label="Draft" value={draft} onChange={(e) => setDraft(e.target.value)} />
      </div>
    );
  }

  function Chat() {
    const [input, setInput] = useState('');
    useEffect(() => {
      mounts.chat += 1;
    }, []);
    return (
      <div>
        <button type="button" data-chat-button="">
          Send
        </button>
        <textarea aria-label="Message" value={input} onChange={(e) => setInput(e.target.value)} />
      </div>
    );
  }

  function frame(
    props: Partial<{
      open: boolean;
      presentation: AssistantPresentation;
      mobile: boolean;
      onClose: () => void;
    }> = {},
  ) {
    return (
      <AssistantWorkspace
        open={props.open ?? false}
        presentation={props.presentation ?? 'corner'}
        onPresentationChange={() => {}}
        onClose={props.onClose ?? (() => {})}
        mobile={props.mobile}
        assistant={<Chat />}
      >
        <Page />
      </AssistantWorkspace>
    );
  }

  function setValue(element: HTMLTextAreaElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(element, value);
      element.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  }

  describe('assistant workspace frame', () => {
    test('page and chat keep one DOM parent and their state through every presentation', async () => {
      mounts.page = 0;
      mounts.chat = 0;
      const { host, render } = await mount(frame({ open: false }));
      const workspace = host.querySelector('[data-assistant-workspace]') as HTMLElement;
      const page = host.querySelector('[data-assistant-page]') as HTMLElement;
      const chat = host.querySelector('[data-assistant-chat]') as HTMLElement;
      const draft = page.querySelector('textarea') as HTMLTextAreaElement;
      const message = chat.querySelector('textarea') as HTMLTextAreaElement;
      setValue(draft, 'half-written reply');
      setValue(message, 'half-typed question');

      // Closed: mounted, hidden from every tree, page full width.
      expect(workspace.dataset.open).toBe('false');
      expect(workspace.dataset.layout).toBe('corner');
      expect(chat.hasAttribute('inert')).toBe(true);
      expect(chat.getAttribute('aria-hidden')).toBe('true');
      expect(page.hasAttribute('inert')).toBe(false);
      expect(chat.getAttribute('aria-label')).toBe(ASSISTANT_CHAT_LABEL);

      const steps: Array<[AssistantPresentation, string, string]> = [
        ['corner', 'corner', 'dialog'],
        ['split', 'split', 'region'],
        ['full', 'full', 'region'],
        ['corner', 'corner', 'dialog'],
      ];
      for (const [presentation, layout, role] of steps) {
        await render(frame({ open: true, presentation }));
        expect(workspace.dataset.layout).toBe(layout);
        expect(chat.getAttribute('role')).toBe(role);
        expect(chat.hasAttribute('inert')).toBe(false);
        expect(chat.hasAttribute('aria-hidden')).toBe(false);
        expect(page.hasAttribute('inert')).toBe(layout === 'full');
        expect(page.getAttribute('aria-hidden')).toBe(layout === 'full' ? 'true' : null);
        expect(!!host.querySelector('[data-assistant-seam]')).toBe(layout === 'split');
        expect(host.querySelector('[data-assistant-page]')).toBe(page);
        expect(host.querySelector('[data-assistant-chat]')).toBe(chat);
        expect(page.querySelector('textarea')).toBe(draft);
        expect(chat.querySelector('textarea')).toBe(message);
      }
      await render(frame({ open: false, presentation: 'split' }));
      expect(workspace.dataset.layout).toBe('corner');
      expect(chat.hasAttribute('inert')).toBe(true);
      expect(host.querySelector('[data-assistant-seam]')).toBeNull();

      expect(draft.value).toBe('half-written reply');
      expect(message.value).toBe('half-typed question');
      expect(mounts).toEqual({ page: 1, chat: 1 });
    });

    test('a phone always gets full-screen chat and keeps the page mounted underneath', async () => {
      const { host, render } = await mount(frame({ open: true, presentation: 'corner', mobile: true }));
      const workspace = host.querySelector('[data-assistant-workspace]') as HTMLElement;
      expect(workspace.dataset.layout).toBe('full');
      expect(workspace.dataset.mobile).toBe('true');
      expect(workspace.dataset.presentation).toBe('corner');
      expect(host.querySelector('[data-assistant-page]')?.hasAttribute('inert')).toBe(true);
      expect(host.querySelector('[data-page-button]')).not.toBeNull();
      await render(frame({ open: false, presentation: 'corner', mobile: true }));
      expect(workspace.dataset.layout).toBe('corner');
      expect(host.querySelector('[data-assistant-page]')?.hasAttribute('inert')).toBe(false);
    });

    test('opening moves focus into the chat and closing returns it to the opener', async () => {
      const launcher = document.createElement('button');
      launcher.setAttribute('data-assistant-launcher', '');
      document.body.appendChild(launcher);
      const { host, render } = await mount(frame({ open: false }));
      const chat = host.querySelector('[data-assistant-chat]') as HTMLElement;
      launcher.focus();
      expect(document.activeElement).toBe(launcher);

      await render(frame({ open: true, presentation: 'corner' }));
      expect(chat.contains(document.activeElement)).toBe(true);

      // Layout changes never move focus once it is in the chat.
      (chat.querySelector('textarea') as HTMLTextAreaElement).focus();
      await render(frame({ open: true, presentation: 'split' }));
      expect(document.activeElement).toBe(chat.querySelector('textarea'));
      await render(frame({ open: true, presentation: 'full' }));
      expect(document.activeElement).toBe(chat.querySelector('textarea'));

      await render(frame({ open: false, presentation: 'full' }));
      expect(document.activeElement).toBe(launcher);
    });

    test('closing never steals focus from someone working on the page', async () => {
      const { host, render } = await mount(frame({ open: true, presentation: 'corner' }));
      const pageButton = host.querySelector('[data-page-button]') as HTMLButtonElement;
      pageButton.focus();
      await render(frame({ open: false, presentation: 'corner' }));
      expect(document.activeElement).toBe(pageButton);
    });

    test('entering full moves focus out of the page it hides', async () => {
      const { host, render } = await mount(frame({ open: true, presentation: 'split' }));
      const pageButton = host.querySelector('[data-page-button]') as HTMLButtonElement;
      const chat = host.querySelector('[data-assistant-chat]') as HTMLElement;
      pageButton.focus();
      await render(frame({ open: true, presentation: 'full' }));
      expect(chat.contains(document.activeElement)).toBe(true);
    });

    test('Escape inside the chat closes it unless a child already handled it; the page is untouched', async () => {
      let closed = 0;
      const { host } = await mount(frame({ open: true, presentation: 'split', onClose: () => closed++ }));
      const chatButton = host.querySelector('[data-chat-button]') as HTMLButtonElement;
      const pageButton = host.querySelector('[data-page-button]') as HTMLButtonElement;

      expect(keydown(pageButton, 'Escape').defaultPrevented).toBe(false);
      expect(closed).toBe(0);

      const consumed = new window.KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      consumed.preventDefault();
      act(() => {
        chatButton.dispatchEvent(consumed);
      });
      expect(closed).toBe(0);

      expect(keydown(chatButton, 'Enter').defaultPrevented).toBe(false);
      expect(closed).toBe(0);

      expect(keydown(chatButton, 'Escape').defaultPrevented).toBe(true);
      expect(closed).toBe(1);
    });

    test('the seam is a focusable separator with keyboard resize and a reset', async () => {
      const { host } = await mount(frame({ open: true, presentation: 'split' }));
      const seam = host.querySelector('[data-assistant-seam]') as HTMLElement;
      const workspace = host.querySelector('[data-assistant-workspace]') as HTMLElement;
      expect(seam.tagName).toBe('HR');
      expect(seam.getAttribute('tabindex')).toBe('0');
      expect(seam.getAttribute('aria-orientation')).toBe('vertical');
      expect(seam.getAttribute('aria-valuenow')).toBe('50');
      // Unitless: the stylesheet multiplies it into the usable width itself.
      expect(workspace.style.getPropertyValue('--assistant-page-share')).toBe('50');

      keydown(seam, 'ArrowLeft');
      expect(seam.getAttribute('aria-valuenow')).toBe('48');
      keydown(seam, 'ArrowRight', { shiftKey: true });
      expect(seam.getAttribute('aria-valuenow')).toBe('58');
      expect(workspace.style.getPropertyValue('--assistant-page-share')).toBe('58');
      expect(window.localStorage.getItem('lab86-mail-assistant-split')).toBe('58');
      keydown(seam, 'Enter');
      expect(seam.getAttribute('aria-valuenow')).toBe('50');
      // Unrelated keys pass through so Tab keeps moving focus.
      expect(keydown(seam, 'Tab').defaultPrevented).toBe(false);
    });

    test('a press that ends where it began leaves the split where it was', async () => {
      const { host } = await mount(frame({ open: true, presentation: 'split' }));
      const seam = host.querySelector('[data-assistant-seam]') as HTMLElement;
      const workspace = host.querySelector('[data-assistant-workspace]') as HTMLElement;
      keydown(seam, 'ArrowRight', { shiftKey: true });
      expect(workspace.style.getPropertyValue('--assistant-page-share')).toBe('60');
      pointer(seam, 'pointerdown', { clientX: 400, timeStamp: 1000 });
      expect(workspace.dataset.resizing).toBe('true');
      pointer(seam, 'pointerup', { clientX: 400 });
      expect(workspace.dataset.resizing).toBe('false');
      // The inline value survives the drag's cleanup; nothing snaps to 50.
      expect(workspace.style.getPropertyValue('--assistant-page-share')).toBe('60');
      expect(seam.getAttribute('aria-valuenow')).toBe('60');
    });

    test('two quick presses on the seam reset the split; slow or distant ones do not', async () => {
      const { host } = await mount(frame({ open: true, presentation: 'split' }));
      const seam = host.querySelector('[data-assistant-seam]') as HTMLElement;
      const workspace = host.querySelector('[data-assistant-workspace]') as HTMLElement;
      keydown(seam, 'ArrowRight', { shiftKey: true });
      expect(seam.getAttribute('aria-valuenow')).toBe('60');
      pointer(seam, 'pointerdown', { clientX: 400, timeStamp: 1000 });
      pointer(seam, 'pointerup', { clientX: 400 });
      pointer(seam, 'pointerdown', { clientX: 400, timeStamp: 1000 + ASSISTANT_DOUBLE_PRESS_MS + 1 });
      pointer(seam, 'pointerup', { clientX: 400 });
      expect(seam.getAttribute('aria-valuenow')).toBe('60');
      pointer(seam, 'pointerdown', { clientX: 420, timeStamp: 1600 });
      pointer(seam, 'pointerup', { clientX: 420 });
      expect(seam.getAttribute('aria-valuenow')).toBe('60');
      pointer(seam, 'pointerdown', { clientX: 422, timeStamp: 1800 });
      expect(seam.getAttribute('aria-valuenow')).toBe('50');
      expect(workspace.dataset.resizing).toBe('false');
      expect(workspace.style.getPropertyValue('--assistant-page-share')).toBe('50');
    });

    test('a drag ends when the seam leaves, so nothing stays pointer-inert', async () => {
      const { host, render } = await mount(frame({ open: true, presentation: 'split' }));
      const seam = host.querySelector('[data-assistant-seam]') as HTMLElement;
      const workspace = host.querySelector('[data-assistant-workspace]') as HTMLElement;
      pointer(seam, 'pointerdown', { clientX: 400, timeStamp: 1000 });
      expect(workspace.dataset.resizing).toBe('true');
      await render(frame({ open: true, presentation: 'full' }));
      expect(host.querySelector('[data-assistant-seam]')).toBeNull();
      expect(workspace.dataset.resizing).toBe('false');
      await render(frame({ open: true, presentation: 'split' }));
      expect(workspace.dataset.resizing).toBe('false');
      // Closing mid-drag ends it the same way.
      const again = host.querySelector('[data-assistant-seam]') as HTMLElement;
      pointer(again, 'pointerdown', { clientX: 400, timeStamp: 3000 });
      expect(workspace.dataset.resizing).toBe('true');
      await render(frame({ open: false, presentation: 'split' }));
      expect(workspace.dataset.resizing).toBe('false');
    });
  });
}
