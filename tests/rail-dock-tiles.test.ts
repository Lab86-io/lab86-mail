import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Collapsed-rail dock tile contract. Two regressions this pins down:
//
// 1. Off-center glyphs: the expanded row's p-2/gap-2 plus the icon-mode
//    label span (max-w-0 but still a flex item) pushed every glyph left by
//    half a gap per trailing span. Collapsed tiles must drop padding/gap and
//    take the span out of flow so the glyph centers in the square.
// 2. Selection must survive collapse. Both modes now use one static fill,
//    without a traveling border, hover halo, or conflicting transparency.

const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), 'utf8');

describe('collapsed dock tile geometry (sidebar.tsx)', () => {
  const sidebar = read('components/ui/sidebar.tsx');

  test('dock tiles drop the expanded row padding/gap and hide the label span from flow', () => {
    // Scoped: DockTile's hover glow layer is also a direct span child and
    // must survive the label-span purge.
    expect(sidebar).toContain("'gap-0 p-0 [&>span:not([data-slot=dock-tile-glow])]:hidden'");
  });

  test('the glyph scales with the tile magnification instead of floating fixed-size', () => {
    expect(sidebar).toContain('[&>svg]:scale-(--dock-glyph-scale)');
    // Area rows use a div-wrapped dot glyph; the shine border layer is a div
    // too and must NOT scale (it hugs the button via inset-0).
    expect(sidebar).toContain('[&>div:not([data-slot=shine-border])]:scale-(--dock-glyph-scale)');
    const dock = read('components/ui/dock.tsx');
    expect(dock).toContain("'--dock-glyph-scale': glyphScale");
    expect(dock).toContain('...glyphScaleStyle');
    expect(dock).toContain('data-slot="dock-tile-glow"');
  });

  test('the SSR/asChild fallback square uses the same centering contract', () => {
    expect(sidebar).toContain('group-data-[collapsible=icon]:p-0!');
    expect(sidebar).toContain('group-data-[collapsible=icon]:gap-0');
    expect(sidebar).toContain('group-data-[collapsible=icon]:[&>span]:hidden');
    // The old p-2 fallback recreated the off-center glyph on first paint.
    expect(sidebar).not.toContain('group-data-[collapsible=icon]:p-2!');
  });

  test('tile overrides land after the caller className so the dock wins the merge', () => {
    const dockBranch = sidebar.slice(sidebar.indexOf('<DockTile'), sidebar.indexOf('const button ='));
    const callerIndex = dockBranch.indexOf('className,');
    const overrideIndex = dockBranch.indexOf(
      "'justify-center gap-0 p-0! overflow-visible data-[active=true]:shadow-none",
    );
    expect(callerIndex).toBeGreaterThan(-1);
    expect(overrideIndex).toBeGreaterThan(callerIndex);
  });
});

describe('quiet rail selection in both modes', () => {
  const sidebar = read('components/ui/sidebar.tsx');

  test('rail tiles explicitly opt out of the dock hover effect', () => {
    expect(sidebar).toContain('glow={false}');
    expect(read('components/ui/dock.tsx')).toContain('glow && highlighted');
  });

  test('the collapsed tile retains the selected fill, without a lifted shadow', () => {
    expect(sidebar).not.toContain('data-[active=true]:bg-transparent');
    expect(sidebar).toContain('data-[active=true]:shadow-none');
    expect(read('app/globals.css')).toContain('.rail-wash .rail-selection[data-active="true"]');
  });

  test('surfaces and areas use the same static selection treatment', () => {
    const rail = read('components/shell/Rail.tsx');
    expect(rail).not.toContain('ShineBorder');
    expect(rail.match(/className="rail-selection"/g)).toHaveLength(2);
  });
});

describe('shine border reduced motion (shine-border.tsx)', () => {
  const shine = read('components/ui/shine-border.tsx');

  test('reduced motion swaps the animated gradient for a static accent border', () => {
    // `!` so the class beats the inline backgroundImage; the mask still cuts
    // the flat fill down to a border.
    expect(shine).toContain('motion-reduce:bg-none!');
    expect(shine).toContain('motion-reduce:bg-(--shine-static)');
    expect(shine).toContain("'--shine-static': Array.isArray(shineColor) ? shineColor[0] : shineColor");
  });

  test('the animation itself stays motion-safe gated', () => {
    expect(shine).toContain('motion-safe:animate-shine');
  });

  test('the border hugs the host radius (rounded-[inherit], inset-0 — no stretched rectangle)', () => {
    expect(shine).toContain('rounded-[inherit]');
    expect(shine).toContain('absolute inset-0');
  });
});
