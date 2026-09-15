import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import type { ReactNode } from 'react';
import type { Root } from 'react-dom/client';

/**
 * The slide editor in a DOM: selection, the inspector by kind, drag and
 * resize through pointer events, keyboard shortcuts, the insert menu with
 * and without version 2 authoring, image upload through the assets route,
 * the theme panel, and undo. Runs in a child process so react-dom sees a
 * window before it loads, without touching the other suites.
 */
if (process.env.ALBATROSS_DECK_EDITOR_DOM_TEST !== '1') {
  test('deck editor DOM suite runs isolated from server-first React import order', async () => {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      cwd: process.cwd(),
      env: { ...process.env, ALBATROSS_DECK_EDITOR_DOM_TEST: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [output, error, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exit !== 0) throw new Error(`Isolated deck editor suite failed:\n${output}\n${error}`);
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
    'File',
    'FormData',
    'ResizeObserver',
    'IntersectionObserver',
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
  class IntersectionObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
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
    File: dom.window.File,
    FormData: dom.window.FormData,
    ResizeObserver: ResizeObserverStub,
    IntersectionObserver: IntersectionObserverStub,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
  // The canvas has a real size in the tests: 960 by 540 at (100, 50).
  const CANVAS = { left: 100, top: 50, width: 960, height: 540 };
  const nativeRect = dom.window.HTMLElement.prototype.getBoundingClientRect;
  dom.window.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.hasAttribute('data-slide-canvas')) {
      return {
        ...CANVAS,
        x: CANVAS.left,
        y: CANVAS.top,
        right: CANVAS.left + CANVAS.width,
        bottom: CANVAS.top + CANVAS.height,
        toJSON: () => ({}),
      } as DOMRect;
    }
    return nativeRect.call(this);
  };
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};

  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { PresentationEditor } = await import('../components/files/editors/PresentationEditor');
  const { insertMenuItems } = await import('../components/files/editors/deck/insert-menu');
  const { referenceDeck, DECK_THEMES } = await import('../lib/documents/deck-fixtures');
  const { createDefaultDocumentModel } = await import('../lib/documents/model');
  const { deckModelForSave, deckModelsEqual, upgradeDeckModel } = await import(
    '../lib/documents/deck-versions'
  );
  type Model = import('../lib/documents/model').AlbatrossDocumentModel;
  type Deck = import('../lib/documents/deck-versions').AnyDeckModel;

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
  });

  async function mount(element: ReactNode) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => root.render(element));
    return { host, render: (next: ReactNode) => act(async () => root.render(next)) };
  }

  const { useState } = await import('react');

  /** The editor under a stateful parent that stores every change, as the document page does. */
  async function mountEditor(initial: Deck, options: { richAuthoring?: boolean; upload?: any } = {}) {
    const changes: Model[] = [];
    let model: Deck = initial;
    function Host() {
      const [stored, setStored] = useState<Deck>(initial);
      model = stored;
      return (
        <PresentationEditor
          model={stored}
          richAuthoring={options.richAuthoring ?? true}
          upload={options.upload}
          onChange={(next) => {
            changes.push(next);
            if (next.kind === 'deck') setStored(next);
          }}
        />
      );
    }
    const view = await mount(<Host />);
    return { changes, latest: () => upgradeDeckModel(model), stored: () => model, ...view };
  }

  const q = <T extends Element>(selector: string) => {
    const found = document.querySelector<T>(selector);
    if (!found) throw new Error(`Missing ${selector}`);
    return found;
  };
  const byLabel = <T extends Element>(label: string) => q<T>(`[aria-label="${label}"]`);
  const elementButton = (id: string) => q<HTMLButtonElement>(`button[data-element-id="${id}"]`);
  const setValue = (input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) => {
    const proto =
      input instanceof dom.window.HTMLTextAreaElement
        ? dom.window.HTMLTextAreaElement.prototype
        : input instanceof dom.window.HTMLSelectElement
          ? dom.window.HTMLSelectElement.prototype
          : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(input, value);
    act(() => {
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
  };
  const choice = (group: string, option: string) => {
    const fieldset = [...document.querySelectorAll('fieldset.deck-choice')].find(
      (node) => node.querySelector('legend')?.textContent === group,
    );
    const button =
      fieldset && [...fieldset.querySelectorAll('button')].find((node) => node.textContent === option);
    if (!button) throw new Error(`Missing choice ${group} / ${option}`);
    return button;
  };
  const click = (target: Element) =>
    act(() =>
      target.dispatchEvent(
        new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }),
      ),
    );
  // jsdom has no PointerEvent; React reads pointer fields off any event with the pointer's name.
  const pointer = (target: Element | Window, type: string, clientX: number, clientY: number) =>
    act(() => {
      target.dispatchEvent(
        new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX, clientY }),
      );
    });
  const keydown = (target: Element, key: string, init: KeyboardEventInit = {}) =>
    act(() => {
      target.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
      );
    });

  const editorial = () => referenceDeck('editorial');

  describe('selection and the inspector', () => {
    test('the shell renders the filmstrip, the canvas, the notes and the slide panel', async () => {
      await mountEditor(editorial());
      expect(document.querySelectorAll('nav[aria-label="Slides"] button')).toHaveLength(6);
      expect(q('[data-slide-canvas]')).toBeTruthy();
      expect(byLabel('Speaker notes')).toBeTruthy();
      expect(q('aside[aria-label="Inspector"]').textContent).toContain('Deck theme');
      expect(q('aside[aria-label="Inspector"]').textContent).toContain(
        'Applies to every slide. Slide edits stay.',
      );
      expect(document.body.textContent).not.toMatch(/\bAI\b/);
    });

    test('a click selects; the inspector follows the kind; Escape clears', async () => {
      await mountEditor(editorial());
      click(elementButton('cover-title'));
      const inspector = q('aside[aria-label="Inspector"]');
      expect(elementButton('cover-title').getAttribute('data-selected')).toBe('true');
      expect(inspector.textContent).toContain('Tracking');
      expect(byLabel<HTMLInputElement>('Size').value).toBe('68');
      expect(document.querySelectorAll('.deck-handle')).toHaveLength(8);
      click(elementButton('cover-image'));
      expect(inspector.textContent).toContain('Focal X');
      expect(byLabel<HTMLInputElement>('Alt text').value).toContain('Painted valley');
      keydown(elementButton('cover-image'), 'Escape');
      expect(document.querySelector('[data-selected="true"]')).toBeNull();
      expect(inspector.textContent).toContain('Deck theme');
    });

    test('a chart shows its data as lines and reads edits back on blur', async () => {
      const editor = await mountEditor(editorial());
      click(q('nav[aria-label="Slides"] button[aria-label^="Slide 4:"]'));
      click(elementButton('m-chart'));
      const data = byLabel<HTMLTextAreaElement>('Chart data');
      expect(data.value).toBe('Q1, 180\nQ2, 240\nQ3, 310\nQ4 plan, 420');
      expect(q('aside[aria-label="Inspector"]').textContent).toContain('Use theme colors');
      setValue(data, 'Q1, 100\nQ2, 200');
      act(() => {
        data.dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true }));
      });
      const chart = editor.latest().slides[3].elements.find((element) => element.id === 'm-chart');
      expect(chart?.type === 'chart' && chart.categories).toEqual(['Q1', 'Q2']);
      expect(chart?.type === 'chart' && chart.series[0]).toEqual({ name: 'Spend', values: [100, 200] });
      setValue(data, 'Q1, many');
      act(() => {
        data.dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true }));
      });
      expect(q('[role="alert"]').textContent).toContain('is not a number');
    });

    test('inspector fields patch the element and keep the rest of the slide', async () => {
      const editor = await mountEditor(editorial());
      const before = editor.latest().slides[0];
      click(elementButton('cover-title'));
      setValue(byLabel<HTMLInputElement>('Size'), '40');
      click(choice('Align', 'Right'));
      const after = editor.latest().slides[0];
      const title = after.elements.find((element) => element.id === 'cover-title');
      expect(title?.type === 'text' && title.fontSize).toBe(40);
      expect(title?.type === 'text' && title.align).toBe('right');
      expect(after.elements.filter((element) => element.id !== 'cover-title')).toEqual(
        before.elements.filter((element) => element.id !== 'cover-title'),
      );
    });
  });

  describe('canvas interaction', () => {
    test('a drag moves the element by slide percent, snaps to a guide and makes one undo step', async () => {
      const editor = await mountEditor(editorial());
      const target = elementButton('cover-sub'); // x 6, y 66, w 38, h 12
      pointer(target, 'pointerdown', 300, 400);
      pointer(window, 'pointermove', 301, 400); // under the drag threshold: nothing moves
      expect(document.querySelector('.deck-overlay')).toBeTruthy();
      expect(editor.changes).toHaveLength(0);
      // 96px right is 10 percent of 960; 27px down is 5 percent of 540. No edge lands near a guide.
      pointer(window, 'pointermove', 300 + 96, 400 + 27);
      expect(document.querySelector('.deck-guide')).toBeNull();
      expect(editor.changes).toHaveLength(0); // the drag previews; the model changes on release
      pointer(window, 'pointerup', 300 + 96, 400 + 27);
      const sub = editor.latest().slides[0].elements.find((element) => element.id === 'cover-sub');
      expect(sub?.x).toBe(16);
      expect(sub?.y).toBe(71);
      expect(editor.changes).toHaveLength(1);
      keydown(elementButton('cover-sub'), 'z', { metaKey: true });
      const restored = editor.latest().slides[0].elements.find((element) => element.id === 'cover-sub');
      expect(restored?.x).toBe(6);
      expect(restored?.y).toBe(66);
    });

    test('a move that ends on a guide snaps within one percent', async () => {
      const editor = await mountEditor(editorial());
      // cover-foot: x 6, w 40. Move it 5.6 percent right: the right edge reaches 51.6, within 1 of the image edge at 52.
      const target = elementButton('cover-foot');
      pointer(target, 'pointerdown', 300, 500);
      pointer(window, 'pointermove', 300 + 53.76, 500);
      expect(
        [...document.querySelectorAll('.deck-guide')].map((guide) => guide.getAttribute('data-axis')),
      ).toContain('x');
      pointer(window, 'pointerup', 300 + 53.76, 500);
      const foot = editor.latest().slides[0].elements.find((element) => element.id === 'cover-foot');
      expect(foot?.x).toBe(12);
    });

    test('a handle resizes from its own edge', async () => {
      const editor = await mountEditor(editorial());
      click(elementButton('cover-sub'));
      const handle = q('.deck-handle[data-handle="se"]');
      pointer(handle, 'pointerdown', 500, 400);
      pointer(window, 'pointermove', 500 + 96, 400 + 54);
      pointer(window, 'pointerup', 500 + 96, 400 + 54);
      const sub = editor.latest().slides[0].elements.find((element) => element.id === 'cover-sub');
      expect(sub).toMatchObject({ x: 6, y: 66, width: 48, height: 22 });
    });

    test('a line end handle moves one end and keeps the other', async () => {
      const editor = await mountEditor(editorial());
      click(q('nav[aria-label="Slides"] button[aria-label^="Slide 5:"]'));
      click(elementButton('p-line')); // x 6, y 56, w 88, h 0
      expect(document.querySelectorAll('.deck-handle')).toHaveLength(2);
      pointer(q('.deck-handle[data-handle="end"]'), 'pointerdown', 900, 350);
      pointer(window, 'pointermove', 900 - 96, 350 - 54);
      pointer(window, 'pointerup', 900 - 96, 350 - 54);
      const line = editor.latest().slides[4].elements.find((element) => element.id === 'p-line');
      // The end lands at 83.2, the center of the fourth step title, and rises to the right.
      expect(line).toMatchObject({ x: 6, y: 46, width: 77.2, height: 10, flip: true });
    });

    test('keys: arrows nudge, Shift nudges by five, Cmd+D duplicates, Delete removes, locked elements stay', async () => {
      const editor = await mountEditor(editorial());
      const target = elementButton('cover-foot');
      click(target);
      keydown(target, 'ArrowRight');
      keydown(target, 'ArrowDown', { shiftKey: true });
      let foot = editor.latest().slides[0].elements.find((element) => element.id === 'cover-foot');
      expect(foot).toMatchObject({ x: 7, y: 95 });
      keydown(target, 'd', { metaKey: true });
      expect(editor.latest().slides[0].elements).toHaveLength(editorial().slides[0].elements.length + 1);
      const copy = editor.latest().slides[0].elements.at(-1)!;
      expect(copy).toMatchObject({ type: 'text', text: 'Prepared for the Parks Board', x: 9 });
      keydown(elementButton(copy.id), 'Delete');
      expect(editor.latest().slides[0].elements.map((element) => element.id)).not.toContain(copy.id);
      click(elementButton('cover-foot'));
      click(byLabel('Lock'));
      keydown(elementButton('cover-foot'), 'ArrowRight');
      keydown(elementButton('cover-foot'), 'Delete');
      foot = editor.latest().slides[0].elements.find((element) => element.id === 'cover-foot');
      expect(foot).toMatchObject({ x: 7, locked: true });
      expect(document.querySelectorAll('.deck-handle')).toHaveLength(0);
    });

    test('a double-click edits text in place and keeps the slide title in step', async () => {
      const editor = await mountEditor(editorial());
      act(() => {
        elementButton('cover-title').dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }));
      });
      const field = q<HTMLTextAreaElement>('textarea[data-editing="true"]');
      setValue(field, 'A new title');
      keydown(field, 'Escape');
      expect(document.querySelector('textarea[data-editing="true"]')).toBeNull();
      expect(editor.latest().slides[0].title).toBe('A new title');
    });
  });

  describe('insert, upload, theme and the authoring gate', () => {
    // The Radix menu opens in JSDOM but leaves its focus-scope timers starving the
    // event loop, so the gate is asserted on the pure item list and on the chrome.
    test('with rich authoring off the menu offers text and shape and the inspector stays basic', async () => {
      const stored = createDefaultDocumentModel('deck', 'old');
      if (stored.kind !== 'deck') throw new Error('fixture');
      const editor = await mountEditor(stored, { richAuthoring: false });
      expect(insertMenuItems(false).map((item) => item.label)).toEqual(['Text', 'Shape']);
      expect(byLabel('Insert')).toBeTruthy();
      const inspector = q('aside[aria-label="Inspector"]');
      expect(inspector.textContent).not.toContain('Deck theme');
      expect(inspector.textContent).not.toContain('Rotation');
      expect(inspector.textContent).not.toContain('Kind');
      click(elementButton(editor.latest().slides[0].elements[0].id));
      expect(inspector.textContent).not.toContain('Tracking');
      expect(inspector.textContent).not.toContain('Lock');
      expect(inspector.textContent).toContain('Size');
      setValue(byLabel<HTMLInputElement>('Size'), '44');
      expect(editor.stored().version).toBe(1);
      const title = editor.latest().slides[0].elements[0];
      expect(title.type === 'text' && title.fontSize).toBe(44);
    });

    test('with rich authoring on the menu adds line, image and chart', async () => {
      await mountEditor(editorial());
      expect(insertMenuItems(true).map((item) => item.label)).toEqual([
        'Text',
        'Shape',
        'Line',
        'Image',
        'Chart',
      ]);
      expect(insertMenuItems(true).map((item) => item.type)).toEqual([
        'text',
        'shape',
        'line',
        'image',
        'chart',
      ]);
      expect(q('aside[aria-label="Inspector"]').textContent).toContain('Deck theme');
    });

    test('an image upload posts the file to the assets route and inserts the owned asset', async () => {
      const calls: { url: string; init: RequestInit }[] = [];
      const upload = async (file: File) => {
        const body = new FormData();
        body.append('file', file, file.name);
        const response = await fetchStub('/api/documents/assets', { method: 'POST', body });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error);
        return payload;
      };
      const fetchStub = async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        const file = (init.body as FormData).get('file') as File;
        if (file.name === 'bad.png')
          return new Response(JSON.stringify({ error: 'That file is not an image we accept.' }), {
            status: 415,
          });
        return new Response(
          JSON.stringify({
            assetId: 'asset-1',
            src: '/assets/asset-1.png',
            width: 800,
            height: 600,
            aspect: 4 / 3,
            mime: 'image/png',
          }),
          { status: 200 },
        );
      };
      const editor = await mountEditor(editorial(), { upload });
      const input = byLabel<HTMLInputElement>('Image file');
      const choose = async (name: string) => {
        Object.defineProperty(input, 'files', {
          configurable: true,
          value: [new dom.window.File(['x'], name, { type: 'image/png' })],
        });
        await act(async () => {
          input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 10));
        });
      };
      await choose('bad.png');
      expect(q('[role="alert"]').textContent).toBe('That file is not an image we accept.');
      expect(editor.changes).toHaveLength(0);
      await choose('hills.png');
      expect(calls).toHaveLength(2);
      expect(calls[1].url).toBe('/api/documents/assets');
      expect((calls[1].init.body as FormData).get('file')).toBeInstanceOf(dom.window.File);
      const image = editor.latest().slides[0].elements.at(-1)!;
      expect(image).toMatchObject({
        type: 'image',
        assetId: 'asset-1',
        src: '/assets/asset-1.png',
        alt: 'hills',
        aspect: 4 / 3,
      });
      expect(document.querySelector('[role="alert"]')).toBeNull();
    });

    test('the built-in upload surfaces the server message on failure', async () => {
      const { uploadDeckAsset } = await import('../components/files/editors/deck/assets');
      const failing = async () => new Response(JSON.stringify({ error: 'Too large.' }), { status: 413 });
      await expect(
        uploadDeckAsset(new dom.window.File(['x'], 'a.png', { type: 'image/png' }), failing as any),
      ).rejects.toThrow('Too large.');
      const ok = async () =>
        new Response(JSON.stringify({ assetId: 'a', src: '/a.png', width: 20, height: 10 }), { status: 200 });
      await expect(
        uploadDeckAsset(new dom.window.File(['x'], 'a.png', { type: 'image/png' }), ok as any),
      ).resolves.toMatchObject({ assetId: 'a', src: '/a.png', aspect: 2 });
    });

    test('a theme preset applies deck-wide, keeps slide edits and survives save and undo', async () => {
      const editor = await mountEditor(editorial());
      click(elementButton('cover-title'));
      setValue(byLabel<HTMLInputElement>('Size'), '40');
      keydown(elementButton('cover-title'), 'Escape');
      click(
        [...document.querySelectorAll('.deck-theme-preset')].find((node) =>
          node.textContent?.includes('Signal'),
        )!,
      );
      const themed = editor.latest();
      expect(themed.theme).toEqual(DECK_THEMES.signal);
      const title = themed.slides[0].elements.find((element) => element.id === 'cover-title');
      expect(title?.type === 'text' && title.fontSize).toBe(40);
      expect(deckModelForSave(themed, 2)).toEqual(themed);
      setValue(byLabel<HTMLInputElement>('Display'), 'Fraunces');
      expect(editor.latest().theme.fonts.display).toEqual({
        family: 'Fraunces',
        exportFamily: 'Georgia',
        fallback: 'serif',
      });
      expect(editor.latest().theme.name).toBe('Custom');
      click(byLabel('Undo'));
      click(byLabel('Undo'));
      expect(editor.latest().theme).toEqual(DECK_THEMES.editorial);
      expect(deckModelsEqual(editor.latest(), editorial())).toBe(false);
      expect(
        editor.latest().slides[0].elements.find((element) => element.id === 'cover-title'),
      ).toMatchObject({ fontSize: 40 });
    });
  });
}
