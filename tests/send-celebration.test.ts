import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { fireSendEffect } from '../lib/effects/send-effect';
import { launchSendFireworks } from '../lib/effects/send-fireworks';

const globalKeys = ['window', 'document', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;
const originals = new Map(globalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
let dom: JSDOM;
let frames: Map<number, FrameRequestCallback>;
let timers: Map<number, () => void>;
let nextId: number;
let reducedMotion: boolean;
let context: {
  scale: ReturnType<typeof mock>;
  arc: ReturnType<typeof mock>;
  stroke: ReturnType<typeof mock>;
};
let cancelStamp: ReturnType<typeof mock>;

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body><button>Compose</button></body></html>');
  frames = new Map();
  timers = new Map();
  nextId = 0;
  reducedMotion = false;
  context = {
    scale: mock(() => {}),
    arc: mock(() => {}),
    stroke: mock(() => {}),
    ...Object.fromEntries(
      ['save', 'restore', 'beginPath', 'fill', 'moveTo', 'lineTo', 'clearRect'].map((name) => [
        name,
        () => {},
      ]),
    ),
  };
  cancelStamp = mock(() => {});
  dom.window.HTMLCanvasElement.prototype.getContext = (() => context) as any;
  dom.window.HTMLElement.prototype.animate = (() => ({ cancel: cancelStamp })) as any;
  dom.window.matchMedia = (() => ({ matches: reducedMotion })) as any;
  dom.window.setTimeout = ((callback: () => void) => {
    timers.set(++nextId, callback);
    return nextId;
  }) as any;
  dom.window.clearTimeout = (id) => {
    timers.delete(id!);
  };
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++nextId, callback);
      return nextId;
    },
    cancelAnimationFrame: (id: number) => {
      frames.delete(id);
    },
  }))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
});

function hideDocument() {
  Object.defineProperty(dom.window.document, 'hidden', { configurable: true, value: true });
  dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
}

afterEach(() => {
  hideDocument();
  dom.window.close();
  for (const key of globalKeys) {
    const descriptor = originals.get(key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

function advance(now: number) {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(now);
}

test('confirmed sends celebrate without intercepting input and finish without leaving work behind', () => {
  Object.defineProperty(dom.window, 'devicePixelRatio', { value: 3 });
  fireSendEffect();
  const canvas = document.querySelector<HTMLCanvasElement>('[data-send-celebration]')!;
  const stamp = document.querySelector<HTMLElement>('[data-send-stamp]')!;
  expect(stamp.textContent).toContain('SENT!');
  for (const overlay of [canvas, stamp]) {
    expect(overlay.style.pointerEvents).toBe('none');
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
  }
  expect(canvas.width).toBe(window.innerWidth * 2);
  expect(context.scale).toHaveBeenCalledWith(2, 2);
  const start = performance.now();
  for (let time = 0; time <= 3200 && frames.size; time += 17) advance(start + time);
  expect(context.stroke.mock.calls.length).toBeGreaterThan(0);
  expect(context.arc.mock.calls.length).toBeGreaterThan(0);
  expect(document.querySelector('[data-send-celebration]')).toBeNull();
  expect(document.querySelector('[data-send-stamp]')).toBeNull();
  expect(document.querySelector('button')?.textContent).toBe('Compose');
  expect(frames.size).toBe(0);
  expect(timers.size).toBe(0);
  expect(cancelStamp).toHaveBeenCalledTimes(1);
});

test('another confirmed send replaces the previous celebration and hiding the tab stops it', () => {
  launchSendFireworks();
  const oldCanvas = document.querySelector('[data-send-celebration]')!;
  const staleFrame = [...frames.values()][0];
  launchSendFireworks();
  expect(oldCanvas.isConnected).toBe(false);
  expect(document.querySelectorAll('[data-send-celebration]')).toHaveLength(1);
  expect(document.querySelectorAll('[data-send-stamp]')).toHaveLength(1);
  expect(frames.size).toBe(1);
  staleFrame(performance.now());
  expect(frames.size).toBe(1);
  hideDocument();
  expect(frames.size).toBe(0);
  expect(timers.size).toBe(0);
  expect(document.querySelector('[data-send-stamp]')).toBeNull();
  expect(cancelStamp).toHaveBeenCalledTimes(2);
});

test('the deadline removes overlays even when animation frames stop arriving', () => {
  Object.defineProperty(dom.window, 'innerWidth', { value: 390 });
  Object.defineProperty(dom.window, 'devicePixelRatio', { value: 0 });
  Reflect.deleteProperty(dom.window.HTMLElement.prototype, 'animate');
  launchSendFireworks();
  expect(context.scale).toHaveBeenCalledWith(1, 1);
  advance(performance.now() + 17);
  for (const callback of [...timers.values()]) callback();
  expect(document.querySelector('[data-send-celebration]')).toBeNull();
  expect(document.querySelector('[data-send-stamp]')).toBeNull();
  expect(frames.size).toBe(0);
  expect(timers.size).toBe(0);
});

test('reduced motion and unavailable canvas avoid creating a celebration', () => {
  reducedMotion = true;
  fireSendEffect();
  expect(document.querySelector('[data-send-stamp]')).toBeNull();
  reducedMotion = false;
  dom.window.HTMLCanvasElement.prototype.getContext = (() => null) as any;
  fireSendEffect();
  expect(document.querySelector('[data-send-celebration]')).toBeNull();
  expect(frames.size).toBe(0);
  expect(timers.size).toBe(0);
});
