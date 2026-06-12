'use client';

import { MonitorCog, Moon, Palette, SunMedium } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useClientStore } from '@/lib/client-state';
import { cn } from '@/lib/utils';

// Arc-style theme panel. Accent and background are independent axes (Arc
// separates the space color from the derived chrome): accent = hue+intensity,
// background = its own hue + tint amount, plus the rail gradient wash, film
// grain, and the editorial display font. Every control writes CSS variables
// on <html>; the OKLCH derivations in globals.css do the rest.
const DEFAULT_HUE = 156;
const DEFAULT_CHROMA = 0.09;

const PRESETS: { name: string; hue: number; chroma: number }[] = [
  { name: 'Forest', hue: DEFAULT_HUE, chroma: DEFAULT_CHROMA },
  { name: 'Ocean', hue: 235, chroma: 0.11 },
  { name: 'Iris', hue: 290, chroma: 0.11 },
  { name: 'Rose', hue: 15, chroma: 0.11 },
  { name: 'Ember', hue: 60, chroma: 0.1 },
  { name: 'Mono', hue: 250, chroma: 0.015 },
];

// Display-layer font: wordmark, sender names, subjects, section headers.
// Body copy and controls always stay sans.
const FONTS: { id: 'sans' | 'serif' | 'news'; label: string; stack: string | null }[] = [
  { id: 'serif', label: 'Editorial', stack: null }, // Fraunces — the default
  { id: 'news', label: 'News', stack: 'var(--font-averia)' },
  { id: 'sans', label: 'Sans', stack: 'var(--font-geist-sans)' },
];

export function useApplyThemeExtras() {
  const accentHue = useClientStore((s) => s.accentHue);
  const accentChroma = useClientStore((s) => s.accentChroma);
  const bgHue = useClientStore((s) => s.bgHue);
  const surfaceTint = useClientStore((s) => s.surfaceTint);
  const washOpacity = useClientStore((s) => s.washOpacity);
  const grainOpacity = useClientStore((s) => s.grainOpacity);
  const appFont = useClientStore((s) => s.appFont);
  useEffect(() => {
    const root = document.documentElement;
    const setOrClear = (name: string, value: string | null) => {
      if (value === null) root.style.removeProperty(name);
      else root.style.setProperty(name, value);
    };
    setOrClear('--accent-hue', accentHue == null ? null : String(accentHue));
    setOrClear('--accent-chroma', accentHue == null ? null : String(accentChroma ?? DEFAULT_CHROMA));
    setOrClear('--bg-hue', bgHue == null ? null : String(bgHue));
    setOrClear('--surface-tint', surfaceTint > 0 ? String(surfaceTint) : null);
    setOrClear('--wash-opacity', washOpacity > 0 ? String(washOpacity) : null);
    setOrClear('--grain-opacity', grainOpacity > 0 ? String(grainOpacity) : null);
    const font = FONTS.find((f) => f.id === appFont);
    setOrClear('--font-display-choice', font?.stack ?? null);
  }, [accentHue, accentChroma, bgHue, surfaceTint, washOpacity, grainOpacity, appFont]);
}

const HUE_TRACK =
  'linear-gradient(to right, oklch(0.62 0.11 0), oklch(0.62 0.11 60), oklch(0.62 0.11 120), oklch(0.62 0.11 180), oklch(0.62 0.11 240), oklch(0.62 0.11 300), oklch(0.62 0.11 359))';

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
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
  trackStyle?: React.CSSProperties;
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center justify-between text-[10.5px] text-[var(--color-text-muted)]">
        {label}
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

export function ThemePanel({ className }: { className?: string }) {
  useApplyThemeExtras();
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const accentHue = useClientStore((s) => s.accentHue);
  const accentChroma = useClientStore((s) => s.accentChroma);
  const setAccent = useClientStore((s) => s.setAccent);
  const bgHue = useClientStore((s) => s.bgHue);
  const setBgHue = useClientStore((s) => s.setBgHue);
  const surfaceTint = useClientStore((s) => s.surfaceTint);
  const setSurfaceTint = useClientStore((s) => s.setSurfaceTint);
  const washOpacity = useClientStore((s) => s.washOpacity);
  const setWashOpacity = useClientStore((s) => s.setWashOpacity);
  const grainOpacity = useClientStore((s) => s.grainOpacity);
  const setGrainOpacity = useClientStore((s) => s.setGrainOpacity);
  const appFont = useClientStore((s) => s.appFont);
  const setAppFont = useClientStore((s) => s.setAppFont);

  const hue = accentHue ?? DEFAULT_HUE;
  const chroma = accentChroma ?? DEFAULT_CHROMA;
  const backgroundHue = bgHue ?? DEFAULT_HUE;
  if (!mounted) return <div className={cn('h-7 w-7', className)} />;
  const mode = theme === 'light' || theme === 'dark' ? theme : 'system';

  return (
    <Popover>
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
      <PopoverContent side="top" align="end" className="w-64 space-y-2.5 p-3">
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

        <Section title="Accent">
          <div className="mb-2 grid grid-cols-6 gap-1.5">
            {PRESETS.map((preset) => {
              const isDefault = preset.hue === DEFAULT_HUE && accentHue === null;
              const selected =
                isDefault ||
                (accentHue !== null && preset.hue === hue && Math.abs(preset.chroma - chroma) < 0.005);
              return (
                <button
                  key={preset.name}
                  type="button"
                  title={preset.name}
                  onClick={() =>
                    preset.hue === DEFAULT_HUE && preset.chroma === DEFAULT_CHROMA
                      ? setAccent(null, null)
                      : setAccent(preset.hue, preset.chroma)
                  }
                  className={cn(
                    'h-7 w-7 rounded-full transition-transform duration-[var(--duration-fast)] hover:scale-110',
                    selected &&
                      'ring-2 ring-[var(--color-text)] ring-offset-2 ring-offset-[var(--color-bg-elevated)]',
                  )}
                  style={{ background: `oklch(0.62 ${preset.chroma} ${preset.hue})` }}
                >
                  <span className="sr-only">{preset.name}</span>
                </button>
              );
            })}
          </div>
          <div className="space-y-2">
            <Slider
              label="Hue"
              min={0}
              max={359}
              step={1}
              value={hue}
              onChange={(value) => setAccent(value, Math.max(chroma, 0.08))}
              trackStyle={{ background: HUE_TRACK }}
            />
            <Slider
              label="Intensity"
              min={0.01}
              max={0.16}
              step={0.005}
              value={chroma}
              onChange={(value) => setAccent(hue, value)}
              trackStyle={{
                background: `linear-gradient(to right, oklch(0.62 0.01 ${hue}), oklch(0.62 0.16 ${hue}))`,
              }}
            />
          </div>
        </Section>

        <Section title="Background">
          <div className="space-y-2">
            <Slider
              label="Hue"
              min={0}
              max={359}
              step={1}
              value={backgroundHue}
              onChange={(value) => setBgHue(value)}
              trackStyle={{ background: HUE_TRACK }}
            />
            <Slider
              label="Tint"
              min={0}
              max={1}
              step={0.05}
              value={surfaceTint}
              onChange={setSurfaceTint}
              trackStyle={{
                background: `linear-gradient(to right, var(--color-bg-muted), oklch(0.45 0.06 ${backgroundHue}))`,
              }}
            />
          </div>
        </Section>

        <Section title="Effects">
          <div className="space-y-2">
            <Slider label="Wash" min={0} max={1} step={0.05} value={washOpacity} onChange={setWashOpacity} />
            <Slider
              label="Grain"
              min={0}
              max={0.3}
              step={0.02}
              value={grainOpacity}
              onChange={setGrainOpacity}
            />
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
