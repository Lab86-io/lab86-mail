import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import type { ReactNode } from 'react';
import type { Root } from 'react-dom/client';

/**
 * A menu item that opens a dialog. The menu and the dialog each set
 * `pointer-events: none` on the body while they are open. When the dialog
 * opens before the menu has closed, the dialog saves the menu's "none" as
 * the value to put back, and after both close the page takes no clicks
 * until a reload. The dialog must open only after the menu has closed.
 * Runs in a child process so react-dom sees a window before it loads.
 */
if (process.env.ALBATROSS_MENU_DIALOG_DOM_TEST !== '1') {
  test('menu to dialog DOM suite runs isolated from server-first React import order', async () => {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      cwd: process.cwd(),
      env: { ...process.env, ALBATROSS_MENU_DIALOG_DOM_TEST: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [output, error, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exit !== 0) throw new Error(`Isolated menu to dialog suite failed:\n${output}\n${error}`);
    expect(exit).toBe(0);
    expect(error).toMatch(/\d+ pass/);
  }, 60_000);
} else {
  const TOUCHED_GLOBALS = [
    'window',
    'document',
    'HTMLElement',
    'Element',
    'Node',
    'KeyboardEvent',
    'MouseEvent',
    'Event',
    'CustomEvent',
    'FocusEvent',
    'MutationObserver',
    'NodeFilter',
    'HTMLInputElement',
    'DocumentFragment',
    'ResizeObserver',
    'IS_REACT_ACT_ENVIRONMENT',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'getComputedStyle',
    'navigator',
  ] as const;
  const saved = new Map(
    TOUCHED_GLOBALS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const),
  );
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    FocusEvent: dom.window.FocusEvent,
    MutationObserver: dom.window.MutationObserver,
    NodeFilter: dom.window.NodeFilter,
    HTMLInputElement: dom.window.HTMLInputElement,
    DocumentFragment: dom.window.DocumentFragment,
    ResizeObserver: ResizeObserverStub,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  // The menu's positioner asks whether an ancestor is in the top layer with
  // `:modal` and `:popover-open`. jsdom's selector engine recurses without end
  // on those, and nothing in jsdom is ever in the top layer.
  const nativeMatches = dom.window.Element.prototype.matches;
  dom.window.Element.prototype.matches = function (this: Element, selector: string) {
    if (selector === ':modal' || selector === ':popover-open') return false;
    return nativeMatches.call(this, selector);
  };

  const { act, useState } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { MailNavView } = await import('../components/inbox/MailNav');
  const { FileLocationPicker } = await import('../components/files/FileLocationPicker');
  const { Dialog, DialogContent, DialogDescription, DialogTitle } = await import('../components/ui/dialog');
  const { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } = await import(
    '../components/ui/dropdown-menu'
  );

  afterAll(() => {
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  });

  const roots: Root[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) await act(async () => root.unmount());
    document.body.innerHTML = '';
    document.body.removeAttribute('style');
  });

  async function mount(element: ReactNode) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => root.render(element));
    return host;
  }

  const wait = (ms = 20) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  function q<T extends Element>(selector: string) {
    const found = document.querySelector<T>(selector);
    if (!found) throw new Error(`Missing ${selector}`);
    return found;
  }

  function menuItem(label: string) {
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (node) => node.textContent?.trim() === label,
    );
    if (!item) throw new Error(`Missing menu item ${label}`);
    return item;
  }

  async function openMenu(trigger: HTMLElement) {
    await act(async () => {
      trigger.focus();
      trigger.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await wait();
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
  }

  async function choose(label: string) {
    await act(async () => menuItem(label).click());
    await wait();
  }

  async function closeDialog() {
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    await wait();
  }

  /** The body takes clicks again: no lock is left behind. */
  function pageTakesClicks() {
    return document.body.style.pointerEvents === '';
  }

  function MailNavHarness({ opened }: { opened: string[] }) {
    const [open, setOpen] = useState<string | null>(null);
    return (
      <>
        <MailNavView
          query=""
          smartCategory="main"
          customLabels={[]}
          onCategory={() => {}}
          onFolder={() => {}}
          onCompose={() => {}}
          onSettings={() => {
            opened.push(`settings:${document.querySelector('[role="menu"]') ? 'menu open' : 'menu closed'}`);
            setOpen('Category settings');
          }}
          onList={(id) => {
            opened.push(`${id}:${document.querySelector('[role="menu"]') ? 'menu open' : 'menu closed'}`);
            setOpen(id);
          }}
        />
        <Dialog open={open !== null} onOpenChange={(next) => setOpen(next ? open : null)}>
          <DialogContent>
            <DialogTitle>{open}</DialogTitle>
            <DialogDescription>A list from the More menu.</DialogDescription>
          </DialogContent>
        </Dialog>
      </>
    );
  }

  describe('Mail, More', () => {
    test('the menu takes the height below its trigger and scrolls, so every item is reachable', async () => {
      await mount(<MailNavHarness opened={[]} />);
      await openMenu(q<HTMLElement>('button[aria-label^="More mail views"]'));
      const menu = q<HTMLElement>('[role="menu"]');
      expect(menu.className).toContain('max-h-(--radix-dropdown-menu-content-available-height)');
      expect(menu.className).toContain('overflow-y-auto');
      expect(menu.className).not.toMatch(/max-h-\[\d+vh\]/);
      expect(menu.textContent).toContain('Category settings');
    });

    for (const label of ['Scheduled', 'Snoozed', 'Sender cleanup', 'Category settings']) {
      test(`${label} opens after the menu closes, and the page takes clicks after the dialog closes`, async () => {
        const opened: string[] = [];
        await mount(<MailNavHarness opened={opened} />);
        await openMenu(q<HTMLElement>('button[aria-label^="More mail views"]'));
        await choose(label);
        expect(opened).toHaveLength(1);
        expect(opened[0]).toEndWith('menu closed');
        expect(document.querySelector('[role="dialog"]')).not.toBeNull();
        await closeDialog();
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(pageTakesClicks()).toBe(true);
      });
    }
  });

  describe('the menu item that opens a dialog', () => {
    test('runs after the menu content is gone, and the page takes clicks after the dialog closes', async () => {
      const seen: boolean[] = [];
      const focusAtAction: boolean[] = [];
      const trigger = () =>
        [...document.querySelectorAll<HTMLElement>('button')].find((node) => node.textContent === 'Actions');
      function Harness() {
        const [open, setOpen] = useState(false);
        return (
          <>
            <DropdownMenu>
              <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem
                  onSelectAfterClose={() => {
                    seen.push(Boolean(document.querySelector('[role="menu"]')));
                    focusAtAction.push(document.activeElement === trigger());
                    setOpen(true);
                  }}
                >
                  Rename
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogContent>
                <DialogTitle>Rename</DialogTitle>
                <DialogDescription>Give it a new name.</DialogDescription>
              </DialogContent>
            </Dialog>
          </>
        );
      }
      await mount(<Harness />);
      const button = trigger();
      if (!button) throw new Error('Missing trigger');
      await openMenu(button);
      await choose('Rename');
      expect(seen).toEqual([false]);
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      // Focus was back on the trigger before the dialog opened.
      expect(focusAtAction).toEqual([true]);
      await closeDialog();
      expect(pageTakesClicks()).toBe(true);
    });

    test('an item without a dialog still runs at once', async () => {
      const calls: string[] = [];
      await mount(
        <DropdownMenu>
          <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={() => calls.push('select')}>Archive</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>,
      );
      const trigger = [...document.querySelectorAll<HTMLElement>('button')].find(
        (node) => node.textContent === 'Actions',
      );
      if (!trigger) throw new Error('Missing trigger');
      await openMenu(trigger);
      await act(async () => menuItem('Archive').click());
      expect(calls).toEqual(['select']);
      await wait();
      expect(pageTakesClicks()).toBe(true);
    });
  });

  describe('Files, Add a drive', () => {
    test('opens the drive dialog after the location menu closes', async () => {
      const opened: boolean[] = [];
      function Harness() {
        const [open, setOpen] = useState(false);
        return (
          <>
            <FileLocationPicker
              locations={[{ id: 'all', label: 'All files' }]}
              value="all"
              onChange={() => {}}
              onManage={() => {
                opened.push(Boolean(document.querySelector('[role="menu"]')));
                setOpen(true);
              }}
            />
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogContent>
                <DialogTitle>File locations</DialogTitle>
                <DialogDescription>Drives.</DialogDescription>
              </DialogContent>
            </Dialog>
          </>
        );
      }
      await mount(<Harness />);
      await openMenu(q<HTMLElement>('button[aria-label="File location"]'));
      await choose('Add a drive');
      expect(opened).toEqual([false]);
      await closeDialog();
      expect(pageTakesClicks()).toBe(true);
    });
  });
}
