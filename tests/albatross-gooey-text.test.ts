import { describe, expect, test } from 'bun:test';
import {
  type GooeyMorphState,
  initialMorphState,
  morphBlurPx,
  morphFrameOf,
  morphOpacity,
  nextMorphState,
} from '../components/albatross/GooeyMorphText';

const CONFIG = { morphTime: 1.2, cooldownTime: 4, wordCount: 5 };

function run(state: GooeyMorphState, steps: number, dt: number): GooeyMorphState {
  let current = state;
  for (let i = 0; i < steps; i += 1) current = nextMorphState(current, dt);
  return current;
}

describe('morphBlurPx', () => {
  test('is sharp (0px) when fully resolved', () => {
    expect(morphBlurPx(1)).toBe(0);
  });

  test('follows 8/fraction - 8 mid-morph', () => {
    expect(morphBlurPx(0.5)).toBe(8);
    expect(morphBlurPx(0.25)).toBe(24);
  });

  test('caps at 100px near and at zero', () => {
    expect(morphBlurPx(0.05)).toBe(100);
    expect(morphBlurPx(0)).toBe(100);
    expect(morphBlurPx(-0.2)).toBe(100);
  });
});

describe('morphOpacity', () => {
  test('is fraction^0.4 with clamped ends', () => {
    expect(morphOpacity(0)).toBe(0);
    expect(morphOpacity(1)).toBe(1);
    expect(morphOpacity(0.5)).toBeCloseTo(0.5 ** 0.4, 10);
    expect(morphOpacity(-1)).toBe(0);
    expect(morphOpacity(2)).toBe(1);
  });
});

describe('initialMorphState', () => {
  test('starts on the last word so the visible text2 shows texts[0]', () => {
    const state = initialMorphState(CONFIG);
    expect(state.wordIndex).toBe(CONFIG.wordCount - 1);
    expect((state.wordIndex + 1) % CONFIG.wordCount).toBe(0);
    expect(state.cooldown).toBe(CONFIG.cooldownTime);
    expect(state.morph).toBe(0);
  });

  test('is safe for a single word', () => {
    const state = initialMorphState({ ...CONFIG, wordCount: 1 });
    expect(state.wordIndex).toBe(0);
  });
});

describe('nextMorphState', () => {
  test('cooldown counts down without touching the word index', () => {
    const state = nextMorphState(initialMorphState(CONFIG), 1);
    expect(state.cooldown).toBe(3);
    expect(state.wordIndex).toBe(CONFIG.wordCount - 1);
    expect(morphFrameOf(state)).toEqual({ phase: 'cooldown' });
  });

  test('cooldown expiry advances the word once and seeds morph with the overflow', () => {
    const nearEnd: GooeyMorphState = { ...initialMorphState(CONFIG), cooldown: 0.1 };
    const state = nextMorphState(nearEnd, 0.3);
    expect(state.wordIndex).toBe(0); // wrapped from last word to texts[0]
    expect(state.cooldown).toBe(0);
    expect(state.morph).toBeCloseTo(0.2, 10);
  });

  test('word index does not advance again on subsequent morph frames', () => {
    const nearEnd: GooeyMorphState = { ...initialMorphState(CONFIG), cooldown: 0.1 };
    const morphing = nextMorphState(nearEnd, 0.2);
    const later = nextMorphState(morphing, 0.2);
    expect(later.wordIndex).toBe(morphing.wordIndex);
    expect(later.morph).toBeGreaterThan(morphing.morph);
  });

  test('morph progress maps to a clamped fraction', () => {
    const nearEnd: GooeyMorphState = { ...initialMorphState(CONFIG), cooldown: 0.1 };
    let state = nextMorphState(nearEnd, 0.1 + 0.6); // 0.6s into a 1.2s morph
    let frame = morphFrameOf(state);
    expect(frame).toEqual({ phase: 'morph', fraction: 0.5 });
    state = run(state, 3, 0.25); // 0.6 + 0.75 = 1.35s > 1.2s: finishes the morph
    frame = morphFrameOf(state);
    expect(frame.phase).toBe('cooldown');
  });

  test('a finished morph parks on a fresh full cooldown', () => {
    const nearEnd: GooeyMorphState = { ...initialMorphState(CONFIG), cooldown: 0.05 };
    const state = nextMorphState(nearEnd, 0.05 + CONFIG.morphTime);
    expect(state.cooldown).toBe(CONFIG.cooldownTime);
    expect(morphFrameOf(state)).toEqual({ phase: 'cooldown' });
  });

  test('cycles through every word over a long run', () => {
    let state = initialMorphState(CONFIG);
    const seen = new Set<number>([state.wordIndex]);
    // Simulate ~60s at 60fps: enough for several full cooldown+morph cycles.
    for (let i = 0; i < 60 * 60; i += 1) {
      state = nextMorphState(state, 1 / 60);
      seen.add(state.wordIndex);
    }
    expect(seen.size).toBe(CONFIG.wordCount);
  });

  test('a huge frame gap (tab restore) still advances exactly one word', () => {
    const state = nextMorphState(initialMorphState(CONFIG), 120);
    expect(state.wordIndex).toBe(0);
    expect(state.cooldown).toBe(CONFIG.cooldownTime);
  });
});
