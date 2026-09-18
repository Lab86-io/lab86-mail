import { afterEach, beforeEach, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { watchBrowserThemeColor } from '../components/shell/BrowserThemeColor';

let dom: JSDOM;
let stop: (() => void) | undefined;
let scheduled: Map<number, FrameRequestCallback>;
let nextFrame: number;
let canvasEnabled: boolean;
beforeEach(() => {
  dom = new JSDOM(
    '<!doctype html><html><head><meta name="theme-color" media="(prefers-color-scheme: light)" content="#eeeeee"><meta name="theme-color" media="(prefers-color-scheme: dark)" content="#000000"></head><body></body></html>',
  );
  scheduled = new Map();
  nextFrame = 0;
  canvasEnabled = true;
  dom.window.requestAnimationFrame = (callback) => {
    scheduled.set(++nextFrame, callback);
    return nextFrame;
  };
  dom.window.cancelAnimationFrame = (id) => {
    scheduled.delete(id);
  };
  dom.window.getComputedStyle = () =>
    ({
      backgroundColor:
        dom.window.document.documentElement.style.getPropertyValue('--fixture-color') ||
        (dom.window.document.documentElement.classList.contains('dark')
          ? 'rgb(25, 33, 28)'
          : 'rgb(210, 224, 214)'),
    }) as CSSStyleDeclaration;
  dom.window.HTMLCanvasElement.prototype.getContext = (() =>
    canvasEnabled
      ? {
          fillStyle: '',
          clearRect() {},
          fillRect() {},
          getImageData() {
            return { data: new Uint8ClampedArray([...this.fillStyle.match(/\d+/g)!.map(Number), 255]) };
          },
        }
      : null) as any;
});
afterEach(() => {
  stop?.();
  stop = undefined;
  dom.window.close();
});
async function flush() {
  await Promise.resolve(); // MutationObserver delivery.
  const callbacks = [...scheduled.values()];
  scheduled.clear();
  for (const callback of callbacks) callback(0);
  await Promise.resolve();
}
const meta = () => dom.window.document.head.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!;

test('browser color follows app mode and palette edits without depending on OS mode', async () => {
  const doc = dom.window.document;
  stop = watchBrowserThemeColor(doc);
  expect(meta().content).toBe('#d2e0d6');
  expect(meta().hasAttribute('media')).toBe(false);
  doc.documentElement.classList.add('dark');
  await flush();
  expect(meta().content).toBe('#19211c');
  doc.documentElement.style.setProperty('--fixture-color', 'rgb(40, 50, 60)');
  await flush();
  expect(meta().content).toBe('#28323c');
  doc.documentElement.style.removeProperty('--fixture-color');
  doc.documentElement.classList.remove('dark');
  await flush();
  expect(meta().content).toBe('#d2e0d6');
  expect(doc.querySelectorAll('[data-app-theme-color]')).toHaveLength(1);
});

test('navigation metadata cannot override the live color or create an observer loop', async () => {
  const doc = dom.window.document;
  stop = watchBrowserThemeColor(doc);
  await flush();
  const replacement = doc.createElement('meta');
  replacement.name = 'theme-color';
  replacement.content = '#ffffff';
  doc.head.prepend(replacement);
  await flush();
  expect(meta().content).toBe('#d2e0d6');
  expect(meta().hasAttribute('data-app-theme-color')).toBe(true);
  await flush();
  expect(scheduled.size).toBe(0);
  meta().remove();
  await flush();
  expect(meta().content).toBe('#d2e0d6');
  expect(doc.querySelectorAll('[data-app-theme-color]')).toHaveLength(1);
});

test('cleanup cancels pending work, disconnects observers, and restores server fallbacks', async () => {
  const doc = dom.window.document;
  stop = watchBrowserThemeColor(doc);
  doc.documentElement.classList.add('dark');
  await Promise.resolve();
  expect(scheduled.size).toBe(1);
  stop();
  stop = undefined;
  expect(scheduled.size).toBe(0);
  expect(doc.querySelectorAll('[data-app-theme-color]')).toHaveLength(0);
  expect(doc.body.children.length).toBe(0);
  expect(meta().content).toBe('#eeeeee');
  doc.documentElement.classList.remove('dark');
  await flush();
  expect(scheduled.size).toBe(0);
  expect(doc.querySelectorAll('meta[name="theme-color"]')).toHaveLength(2);
});

test('without canvas the resolved CSS color remains usable; missing styles keep the fallback', async () => {
  canvasEnabled = false;
  const doc = dom.window.document;
  doc.documentElement.style.setProperty('--fixture-color', 'rgba(0, 0, 0, 0)');
  stop = watchBrowserThemeColor(doc);
  expect(meta().content).toBe('#eeeeee');
  doc.documentElement.style.setProperty('--fixture-color', 'rgb(12, 34, 56)');
  await flush();
  expect(meta().content).toBe('rgb(12, 34, 56)');
});
