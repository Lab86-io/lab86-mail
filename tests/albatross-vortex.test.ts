import { describe, expect, test } from 'bun:test';
import {
  CARD_MAX_DURATION_MS,
  CARD_MIN_DURATION_MS,
  DEFAULT_VORTEX_SOURCES,
  mulberry32,
  ORB_GROWTH_MS,
  ORB_GROWTH_SCALE,
  ORB_PULSE_AMPLITUDE,
  orbScaleAt,
  SPAWN_JITTER_MS,
  SPAWN_SPACING_MS,
  spawnPlan,
} from '../components/albatross/ContextVortex';

describe('mulberry32', () => {
  test('is deterministic for a given seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 8; i++) expect(a()).toBe(b());
  });

  test('emits values in [0, 1)', () => {
    const rnd = mulberry32(7);
    for (let i = 0; i < 200; i++) {
      const v = rnd();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('spawnPlan', () => {
  test('is deterministic from (index, seed)', () => {
    expect(spawnPlan(3, 1234)).toEqual(spawnPlan(3, 1234));
    expect(spawnPlan(0, 99, 3)).toEqual(spawnPlan(0, 99, 3));
  });

  test('varies with index and seed', () => {
    const base = spawnPlan(1, 500);
    expect(spawnPlan(2, 500)).not.toEqual({
      ...base,
      delay: spawnPlan(2, 500).delay,
      sourceIndex: spawnPlan(2, 500).sourceIndex,
    });
    expect(spawnPlan(1, 501).startX === base.startX && spawnPlan(1, 501).startY === base.startY).toBe(false);
  });

  test('spawns just outside the named edge with the other axis inside the frame', () => {
    for (let i = 0; i < 60; i++) {
      const plan = spawnPlan(i, 2026);
      if (plan.edge === 'top') {
        expect(plan.startY).toBeLessThan(0);
        expect(plan.startX).toBeGreaterThanOrEqual(6);
        expect(plan.startX).toBeLessThanOrEqual(94);
      } else if (plan.edge === 'bottom') {
        expect(plan.startY).toBeGreaterThan(100);
        expect(plan.startX).toBeGreaterThanOrEqual(6);
        expect(plan.startX).toBeLessThanOrEqual(94);
      } else if (plan.edge === 'left') {
        expect(plan.startX).toBeLessThan(0);
        expect(plan.startY).toBeGreaterThanOrEqual(6);
        expect(plan.startY).toBeLessThanOrEqual(94);
      } else {
        expect(plan.edge).toBe('right');
        expect(plan.startX).toBeGreaterThan(100);
        expect(plan.startY).toBeGreaterThanOrEqual(6);
        expect(plan.startY).toBeLessThanOrEqual(94);
      }
    }
  });

  test('uses all four edges across a cycle', () => {
    const edges = new Set(Array.from({ length: 40 }, (_, i) => spawnPlan(i, 77).edge));
    expect(edges.size).toBe(4);
  });

  test('midpoint arcs off the straight start->center line', () => {
    let curved = 0;
    for (let i = 0; i < 20; i++) {
      const plan = spawnPlan(i, 11);
      const straightMidX = plan.startX + (50 - plan.startX) / 2;
      const straightMidY = plan.startY + (50 - plan.startY) / 2;
      const offset = Math.hypot(plan.midX - straightMidX, plan.midY - straightMidY);
      expect(offset).toBeLessThanOrEqual(16.001);
      if (offset >= 7) curved++;
    }
    expect(curved).toBe(20); // bulge magnitude is always 7..16
  });

  test('staggers launches ~700ms apart with bounded jitter', () => {
    for (let i = 0; i < 12; i++) {
      const plan = spawnPlan(i, 8);
      expect(plan.delay).toBeGreaterThanOrEqual(i * SPAWN_SPACING_MS);
      expect(plan.delay).toBeLessThan(i * SPAWN_SPACING_MS + SPAWN_JITTER_MS);
    }
  });

  test('keeps flight duration within the card window', () => {
    for (let i = 0; i < 30; i++) {
      const plan = spawnPlan(i, 3);
      expect(plan.duration).toBeGreaterThanOrEqual(CARD_MIN_DURATION_MS);
      expect(plan.duration).toBeLessThanOrEqual(CARD_MAX_DURATION_MS);
      expect(Math.abs(plan.rotate)).toBeLessThanOrEqual(14);
    }
  });

  test('cycles source labels by index', () => {
    for (let i = 0; i < 15; i++) {
      expect(spawnPlan(i, 4, 5).sourceIndex).toBe(i % 5);
      expect(spawnPlan(i, 4, 3).sourceIndex).toBe(i % 3);
    }
    expect(spawnPlan(9, 4, 0).sourceIndex).toBe(0);
  });
});

describe('orbScaleAt', () => {
  test('starts at exactly 1', () => {
    expect(orbScaleAt(0)).toBe(1);
    expect(orbScaleAt(-500)).toBe(1);
  });

  test('grows toward 1.6 over the growth window', () => {
    const half = orbScaleAt(ORB_GROWTH_MS / 2);
    expect(half).toBeGreaterThan(1.2);
    expect(half).toBeLessThan(1.4);
    const full = orbScaleAt(ORB_GROWTH_MS);
    expect(Math.abs(full - (1 + ORB_GROWTH_SCALE))).toBeLessThanOrEqual(ORB_PULSE_AMPLITUDE);
  });

  test('clamps growth after 25s: only the breathing pulse remains', () => {
    const a = orbScaleAt(ORB_GROWTH_MS + 1_000);
    const b = orbScaleAt(ORB_GROWTH_MS + 60_000);
    expect(Math.abs(a - b)).toBeLessThanOrEqual(2 * ORB_PULSE_AMPLITUDE);
    for (const t of [30_000, 41_500, 90_000]) {
      const v = orbScaleAt(t);
      expect(v).toBeGreaterThanOrEqual(1 + ORB_GROWTH_SCALE - ORB_PULSE_AMPLITUDE);
      expect(v).toBeLessThanOrEqual(1 + ORB_GROWTH_SCALE + ORB_PULSE_AMPLITUDE);
    }
  });

  test('breathes on a ~3s cycle', () => {
    // Pulse is sinusoidal: a quarter cycle after any time t, growth aside,
    // the value shifts by roughly the pulse amplitude.
    const t = 27_000; // exactly 9 pulse cycles, past the growth clamp
    expect(orbScaleAt(t)).toBeCloseTo(1 + ORB_GROWTH_SCALE, 5);
    expect(orbScaleAt(t + 750)).toBeCloseTo(1 + ORB_GROWTH_SCALE + ORB_PULSE_AMPLITUDE, 5);
  });
});

describe('DEFAULT_VORTEX_SOURCES', () => {
  test('keeps the stable id/label/kind contract', () => {
    expect(DEFAULT_VORTEX_SOURCES.map((s) => s.kind)).toEqual(['mail', 'calendar', 'tasks', 'areas', 'web']);
    for (const source of DEFAULT_VORTEX_SOURCES) {
      expect(source.id.length).toBeGreaterThan(0);
      expect(source.label.length).toBeGreaterThan(0);
    }
  });
});
