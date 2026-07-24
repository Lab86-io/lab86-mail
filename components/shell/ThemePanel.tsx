'use client';

import { MonitorCog, Moon, Palette, SunMedium } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useEffect, useRef, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useClientStore } from '@/lib/client-state';
import {
  brillianceFromChroma,
  clampBrilliance,
  DEFAULT_ACCENT_2_CHROMA,
  DEFAULT_ACCENT_2_HUE,
  DEFAULT_ACCENT_3_CHROMA,
  DEFAULT_ACCENT_3_HUE,
  DEFAULT_ACCENT_CHROMA,
  DEFAULT_ACCENT_HUE,
  MAX_BRILLIANCE,
  MIN_BRILLIANCE,
  nearestWheelStop,
  type PaletteStop,
  paletteStop,
  WHEEL_STOP_COUNT,
} from '@/lib/theme/palette-presets';
import { cn } from '@/lib/utils';

// Arc-style theme panel around one master control: the palette wheel. Each of
// its 20 detented stops is a complete palette object (paper seat + depth
// ladder + three-accent chord) — the chord geometry rotated across the OKLCH
// spectrum (lib/theme/palette-presets.ts). Clicking or dragging around the
// wheel scrubs stops; pressing and pulling in/out (or the Brilliance slider)
// scales every chroma and the paper tint together. The fine controls
// underneath edit single axes on top of whatever the wheel wrote. Every
// control writes CSS variables on <html>; the OKLCH derivations in
// globals.css do the rest.
const DEFAULT_HUE = DEFAULT_ACCENT_HUE;
const DEFAULT_CHROMA = DEFAULT_ACCENT_CHROMA;

// Display-layer font: wordmark, sender names, subjects, section headers.
// Body copy and controls always stay sans.
const FONTS: {
  id: 'sans' | 'serif' | 'news' | 'instrument' | 'grotesk';
  label: string;
  stack: string | null;
}[] = [
  { id: 'serif', label: 'Editorial', stack: null }, // Fraunces — the default
  { id: 'instrument', label: 'Instrument', stack: 'var(--font-instrument)' },
  { id: 'news', label: 'News', stack: 'var(--font-averia)' },
  { id: 'sans', label: 'Sans', stack: 'var(--font-geist-sans)' },
  { id: 'grotesk', label: 'Grotesk', stack: 'var(--font-hanken)' },
];

export function useApplyThemeExtras() {
  const accentHue = useClientStore((s) => s.accentHue);
  const accentChroma = useClientStore((s) => s.accentChroma);
  const accent2Hue = useClientStore((s) => s.accent2Hue);
  const accent2Chroma = useClientStore((s) => s.accent2Chroma);
  const accent3Hue = useClientStore((s) => s.accent3Hue);
  const accent3Chroma = useClientStore((s) => s.accent3Chroma);
  const bgHue = useClientStore((s) => s.bgHue);
  const surfaceTint = useClientStore((s) => s.surfaceTint);
  const depthSpread = useClientStore((s) => s.depthSpread);
  const washOpacity = useClientStore((s) => s.washOpacity);
  const bgWashOpacity = useClientStore((s) => s.bgWashOpacity);
  const grainOpacity = useClientStore((s) => s.grainOpacity);
  const grainScale = useClientStore((s) => s.grainScale);
  const appFont = useClientStore((s) => s.appFont);
  useEffect(() => {
    const root = document.documentElement;
    const setOrClear = (name: string, value: string | null) => {
      if (value === null) root.style.removeProperty(name);
      else root.style.setProperty(name, value);
    };
    setOrClear('--accent-hue', accentHue == null ? null : String(accentHue));
    setOrClear('--accent-chroma', accentHue == null ? null : String(accentChroma ?? DEFAULT_CHROMA));
    setOrClear('--accent-2-hue', accent2Hue == null ? null : String(accent2Hue));
    setOrClear(
      '--accent-2-chroma',
      accent2Hue == null ? null : String(accent2Chroma ?? DEFAULT_ACCENT_2_CHROMA),
    );
    setOrClear('--accent-3-hue', accent3Hue == null ? null : String(accent3Hue));
    setOrClear(
      '--accent-3-chroma',
      accent3Hue == null ? null : String(accent3Chroma ?? DEFAULT_ACCENT_3_CHROMA),
    );
    setOrClear('--bg-hue', bgHue == null ? null : String(bgHue));
    setOrClear('--surface-tint', surfaceTint > 0 ? String(surfaceTint) : null);
    setOrClear('--depth-spread', depthSpread !== 1 ? String(depthSpread) : null);
    setOrClear('--wash-opacity', washOpacity > 0 ? String(washOpacity) : null);
    setOrClear('--bg-wash-opacity', bgWashOpacity > 0 ? String(bgWashOpacity) : null);
    setOrClear('--grain-opacity', grainOpacity > 0 ? String(grainOpacity) : null);
    setOrClear('--grain-scale', grainScale ? `${grainScale}px` : null);
    const font = FONTS.find((f) => f.id === appFont);
    setOrClear('--font-display-choice', font?.stack ?? null);
  }, [
    accentHue,
    accentChroma,
    accent2Hue,
    accent2Chroma,
    accent3Hue,
    accent3Chroma,
    bgHue,
    surfaceTint,
    depthSpread,
    washOpacity,
    bgWashOpacity,
    grainOpacity,
    grainScale,
    appFont,
  ]);
}

const HUE_TRACK =
  'linear-gradient(to right, oklch(0.62 0.11 0), oklch(0.62 0.11 60), oklch(0.62 0.11 120), oklch(0.62 0.11 180), oklch(0.62 0.11 240), oklch(0.62 0.11 300), oklch(0.62 0.11 359))';

// Wheel geometry (px, inside a 176px square).
const WHEEL_SIZE = 176;
const STOP_RING_RADIUS = 72;
const STOP_STEP_DEG = 360 / WHEEL_STOP_COUNT;
// Radial drag: pulling one dot-spacing in/out shifts brilliance by ~0.45.
const BRILLIANCE_PER_PX = 0.011;

function stopSwatch(stop: PaletteStop) {
  const a1 = `oklch(0.62 ${stop.chroma} ${stop.hue})`;
  const a2 = `oklch(0.62 ${stop.chroma2} ${stop.hue2})`;
  const a3 = `oklch(0.62 ${stop.chroma3} ${stop.hue3})`;
  return `conic-gradient(from 210deg, ${a1} 0 33.4%, ${a2} 33.4% 66.7%, ${a3} 66.7% 100%)`;
}

function PaletteWheel({
  stopIndex,
  brilliance,
  onScrub,
}: {
  stopIndex: number;
  brilliance: number;
  onScrub: (stopIndex: number, brilliance: number) => void;
}) {
  const wheelRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startRadius: number; startBrilliance: number; moved: boolean } | null>(null);
  const current = paletteStop(stopIndex, brilliance);
  const paper = `oklch(0.96 ${0.008 + current.surfaceTint * 0.03} ${current.bgHue})`;

  const polar = (event: React.PointerEvent) => {
    const rect = wheelRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const dx = event.clientX - (rect.left + rect.width / 2);
    const dy = event.clientY - (rect.top + rect.height / 2);
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
    const index =
      ((Math.round(angle / STOP_STEP_DEG) % WHEEL_STOP_COUNT) + WHEEL_STOP_COUNT) % WHEEL_STOP_COUNT;
    return { index, radius: Math.hypot(dx, dy) };
  };

  return (
    <div className="flex flex-col items-center gap-2">
      <div
        ref={wheelRef}
        role="slider"
        aria-label="Palette wheel"
        aria-valuemin={0}
        aria-valuemax={WHEEL_STOP_COUNT - 1}
        aria-valuenow={stopIndex}
        aria-valuetext={`Palette ${stopIndex + 1} of ${WHEEL_STOP_COUNT}`}
        tabIndex={0}
        className="relative cursor-pointer touch-none select-none rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/50"
        style={{ width: WHEEL_SIZE, height: WHEEL_SIZE }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
            event.preventDefault();
            onScrub((stopIndex + 1) % WHEEL_STOP_COUNT, brilliance);
          } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
            event.preventDefault();
            onScrub((stopIndex - 1 + WHEEL_STOP_COUNT) % WHEEL_STOP_COUNT, brilliance);
          }
        }}
        onPointerDown={(event) => {
          const point = polar(event);
          if (!point) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = { startRadius: point.radius, startBrilliance: brilliance, moved: false };
          onScrub(point.index, brilliance);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          const point = drag && polar(event);
          if (!drag || !point) return;
          const pulled = point.radius - drag.startRadius;
          if (Math.abs(pulled) > 6) drag.moved = true;
          onScrub(
            point.index,
            drag.moved ? clampBrilliance(drag.startBrilliance + pulled * BRILLIANCE_PER_PX) : brilliance,
          );
        }}
        onPointerUp={() => {
          dragRef.current = null;
        }}
      >
        {Array.from({ length: WHEEL_STOP_COUNT }, (_, index) => {
          const stop = paletteStop(index, brilliance);
          const angle = ((index * STOP_STEP_DEG - 90) * Math.PI) / 180;
          const x = WHEEL_SIZE / 2 + Math.cos(angle) * STOP_RING_RADIUS;
          const y = WHEEL_SIZE / 2 + Math.sin(angle) * STOP_RING_RADIUS;
          return (
            <span
              key={stop.hue}
              aria-hidden
              className={cn(
                'absolute block size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border border-black/10 transition-transform duration-[var(--duration-fast)]',
                index === stopIndex &&
                  'scale-125 ring-2 ring-[var(--color-text)] ring-offset-2 ring-offset-[var(--color-bg-elevated)]',
              )}
              style={{ left: x, top: y, background: stopSwatch(stop) }}
            />
          );
        })}
        {/* Center preview: the paper seat carrying the three voices. */}
        <div
          className="absolute left-1/2 top-1/2 grid size-[76px] -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-[var(--color-border)] shadow-[var(--shadow-soft)]"
          style={{ background: paper }}
        >
          <div className="flex items-center -space-x-1.5">
            {[
              [current.chroma, current.hue],
              [current.chroma2, current.hue2],
              [current.chroma3, current.hue3],
            ].map(([chroma, hue]) => (
              <span
                key={hue}
                className="block size-5 rounded-full border-2 border-[var(--color-bg-elevated)]"
                style={{ background: `oklch(0.55 ${chroma} ${hue})` }}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-[var(--color-border)]/60 pt-2.5 first:border-t-0 first:pt-0">
      <div className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--color-text-faint)]">
        {title}
      </div>
      {children}
    </div>
  );
}

function Slider({
  label,
  min,
  max,
  step,
  value,
  onChange,
  trackStyle,
  readout,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
  trackStyle?: React.CSSProperties;
  readout?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center justify-between text-[10.5px] text-[var(--color-text-muted)]">
        <span>{label}</span>
        {readout ? <span className="tabular-nums text-[var(--color-text-faint)]">{readout}</span> : null}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="theme-slider h-1.5 w-full cursor-pointer appearance-none rounded-full bg-[var(--color-bg-muted)]"
        style={trackStyle}
      />
    </label>
  );
}

function AccentSliders({
  title,
  hue,
  chroma,
  onChange,
}: {
  title: string;
  hue: number;
  chroma: number;
  onChange: (hue: number, chroma: number) => void;
}) {
  return (
    <Section title={title}>
      <div className="space-y-2">
        <Slider
          label="Hue"
          min={0}
          max={359}
          step={1}
          value={hue}
          readout={`${Math.round(hue)}°`}
          onChange={(value) => onChange(value, Math.max(chroma, 0.08))}
          trackStyle={{ background: HUE_TRACK }}
        />
        <Slider
          label="Intensity"
          min={0.01}
          max={0.16}
          step={0.005}
          value={chroma}
          readout={`${Math.round(((chroma - 0.01) / 0.15) * 100)}%`}
          onChange={(value) => onChange(hue, value)}
          trackStyle={{
            background: `linear-gradient(to right, oklch(0.62 0.01 ${hue}), oklch(0.62 0.16 ${hue}))`,
          }}
        />
      </div>
    </Section>
  );
}

export function ThemePanel({ className }: { className?: string }) {
  useApplyThemeExtras();
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => setMounted(true), []);

  // Radix closes on normal outside clicks, but a click into the daily-brief
  // iframe never reaches the parent document — so also close when focus moves
  // into an iframe (window blur with an iframe active element).
  useEffect(() => {
    if (!open) return;
    const onBlur = () => {
      if (document.activeElement?.tagName === 'IFRAME') setOpen(false);
    };
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, [open]);

  const accentHue = useClientStore((s) => s.accentHue);
  const accentChroma = useClientStore((s) => s.accentChroma);
  const setAccent = useClientStore((s) => s.setAccent);
  const accent2Hue = useClientStore((s) => s.accent2Hue);
  const accent2Chroma = useClientStore((s) => s.accent2Chroma);
  const setAccent2 = useClientStore((s) => s.setAccent2);
  const accent3Hue = useClientStore((s) => s.accent3Hue);
  const accent3Chroma = useClientStore((s) => s.accent3Chroma);
  const setAccent3 = useClientStore((s) => s.setAccent3);
  const bgHue = useClientStore((s) => s.bgHue);
  const setBgHue = useClientStore((s) => s.setBgHue);
  const surfaceTint = useClientStore((s) => s.surfaceTint);
  const setSurfaceTint = useClientStore((s) => s.setSurfaceTint);
  const depthSpread = useClientStore((s) => s.depthSpread);
  const setDepthSpread = useClientStore((s) => s.setDepthSpread);
  const washOpacity = useClientStore((s) => s.washOpacity);
  const setWashOpacity = useClientStore((s) => s.setWashOpacity);
  const bgWashOpacity = useClientStore((s) => s.bgWashOpacity);
  const setBgWashOpacity = useClientStore((s) => s.setBgWashOpacity);
  const grainOpacity = useClientStore((s) => s.grainOpacity);
  const setGrainOpacity = useClientStore((s) => s.setGrainOpacity);
  const grainScale = useClientStore((s) => s.grainScale);
  const setGrainScale = useClientStore((s) => s.setGrainScale);
  const appFont = useClientStore((s) => s.appFont);
  const setAppFont = useClientStore((s) => s.setAppFont);

  const hue = accentHue ?? DEFAULT_HUE;
  const chroma = accentChroma ?? DEFAULT_CHROMA;
  const hue2 = accent2Hue ?? DEFAULT_ACCENT_2_HUE;
  const chroma2 = accent2Chroma ?? DEFAULT_ACCENT_2_CHROMA;
  const hue3 = accent3Hue ?? DEFAULT_ACCENT_3_HUE;
  const chroma3 = accent3Chroma ?? DEFAULT_ACCENT_3_CHROMA;
  const backgroundHue = bgHue ?? DEFAULT_HUE;
  const wheelStop = nearestWheelStop(hue);
  const brilliance = brillianceFromChroma(chroma);

  // A wheel scrub writes the complete palette object: chord + paper + tint.
  const applyWheel = (index: number, nextBrilliance: number) => {
    const stop = paletteStop(index, nextBrilliance);
    setAccent(stop.hue, stop.chroma);
    setAccent2(stop.hue2, stop.chroma2);
    setAccent3(stop.hue3, stop.chroma3);
    setBgHue(stop.bgHue);
    setSurfaceTint(stop.surfaceTint);
  };

  if (!mounted) return <div className={cn('h-7 w-7', className)} />;
  const mode = theme === 'light' || theme === 'dark' ? theme : 'system';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Theme"
          title="Theme"
          className={cn(
            'grid h-7 w-7 place-items-center rounded-md text-[var(--color-text-muted)] transition-colors duration-[var(--duration-fast)] hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text)]',
            className,
          )}
        >
          <Palette className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        className="max-h-[min(80vh,760px)] w-64 space-y-2.5 overflow-y-auto p-3"
      >
        {/* Appearance — Arc's auto/light/dark row. */}
        <div className="flex items-center justify-center gap-1">
          {(
            [
              { id: 'system', Icon: MonitorCog, label: 'Auto' },
              { id: 'light', Icon: SunMedium, label: 'Light' },
              { id: 'dark', Icon: Moon, label: 'Dark' },
            ] as const
          ).map(({ id, Icon, label }) => (
            <button
              key={id}
              type="button"
              title={label}
              onClick={() => setTheme(id)}
              className={cn(
                'grid h-8 w-10 place-items-center rounded-md text-[var(--color-text-muted)] transition-colors duration-[var(--duration-fast)] hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text)]',
                mode === id &&
                  'bg-[var(--color-accent-soft)] text-[var(--color-accent)] ring-1 ring-[var(--color-accent)]/40',
              )}
            >
              <Icon className="h-4 w-4" />
              <span className="sr-only">{label}</span>
            </button>
          ))}
        </div>

        <Section title="Palette">
          <PaletteWheel stopIndex={wheelStop} brilliance={brilliance} onScrub={applyWheel} />
          <div className="mt-2">
            <Slider
              label="Brilliance"
              min={MIN_BRILLIANCE}
              max={MAX_BRILLIANCE}
              step={0.05}
              value={brilliance}
              readout={`${Math.round(brilliance * 100)}%`}
              onChange={(value) => applyWheel(wheelStop, value)}
              trackStyle={{
                background: `linear-gradient(to right, oklch(0.62 0.012 ${hue}), oklch(0.62 0.135 ${hue}))`,
              }}
            />
          </div>
        </Section>

        <AccentSliders title="Accent" hue={hue} chroma={chroma} onChange={setAccent} />
        <AccentSliders title="Second accent" hue={hue2} chroma={chroma2} onChange={setAccent2} />
        <AccentSliders title="Third accent" hue={hue3} chroma={chroma3} onChange={setAccent3} />

        <Section title="Background">
          <div className="space-y-2">
            <Slider
              label="Hue"
              min={0}
              max={359}
              step={1}
              value={backgroundHue}
              readout={`${Math.round(backgroundHue)}°`}
              onChange={(value) => setBgHue(value)}
              trackStyle={{ background: HUE_TRACK }}
            />
            <Slider
              label="Tint"
              min={0}
              max={1}
              step={0.05}
              value={surfaceTint}
              readout={`${Math.round(surfaceTint * 100)}%`}
              onChange={setSurfaceTint}
              trackStyle={{
                background: `linear-gradient(to right, var(--color-bg-muted), oklch(0.45 0.06 ${backgroundHue}))`,
              }}
            />
            <Slider
              label="Depth"
              min={0.4}
              max={1.6}
              step={0.05}
              value={depthSpread}
              readout={depthSpread < 0.75 ? 'Flat' : depthSpread > 1.25 ? 'Deep' : 'Standard'}
              onChange={setDepthSpread}
            />
          </div>
        </Section>

        <Section title="Effects">
          <div className="space-y-2">
            <Slider
              label="Rail wash"
              min={0}
              max={1}
              step={0.05}
              value={washOpacity}
              readout={washOpacity ? `${Math.round(washOpacity * 100)}%` : 'Off'}
              onChange={setWashOpacity}
            />
            <Slider
              label="Background wash"
              min={0}
              max={1}
              step={0.05}
              value={bgWashOpacity}
              readout={bgWashOpacity ? `${Math.round(bgWashOpacity * 100)}%` : 'Off'}
              onChange={setBgWashOpacity}
            />
            <Slider
              label="Grain"
              min={0}
              max={0.3}
              step={0.02}
              value={grainOpacity}
              readout={grainOpacity ? `${Math.round((grainOpacity / 0.3) * 100)}%` : 'Off'}
              onChange={setGrainOpacity}
            />
            {grainOpacity > 0 ? (
              <Slider
                label="Grain size"
                min={60}
                max={240}
                step={10}
                value={grainScale}
                readout={grainScale <= 100 ? 'Fine' : grainScale >= 200 ? 'Coarse' : 'Medium'}
                onChange={setGrainScale}
              />
            ) : null}
          </div>
        </Section>

        <Section title="Display type">
          <div className="grid grid-cols-3 gap-1.5">
            {FONTS.map((font) => {
              const selected = (appFont ?? 'serif') === font.id;
              return (
                <button
                  key={font.id}
                  type="button"
                  onClick={() => setAppFont(font.id === 'serif' ? null : font.id)}
                  className={cn(
                    'flex flex-col items-center gap-0.5 rounded-md border border-[var(--color-border)] px-1 py-1.5 transition-colors duration-[var(--duration-fast)] hover:bg-[var(--color-bg-subtle)]',
                    selected &&
                      'border-[var(--color-accent)]/50 bg-[var(--color-accent-soft)] text-[var(--color-accent)]',
                  )}
                  style={{
                    fontFamily:
                      font.id === 'serif'
                        ? 'var(--font-fraunces), ui-serif, Georgia, serif'
                        : font.stack
                          ? `${font.stack}, serif`
                          : undefined,
                  }}
                >
                  <span className="text-[15px] leading-none">Ag</span>
                  <span className="font-sans text-[9.5px] text-[var(--color-text-muted)]">{font.label}</span>
                </button>
              );
            })}
          </div>
        </Section>
      </PopoverContent>
    </Popover>
  );
}
