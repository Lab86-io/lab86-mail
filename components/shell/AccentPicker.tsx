'use client';

import { Palette } from 'lucide-react';
import { useEffect } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useClientStore } from '@/lib/client-state';
import { cn } from '@/lib/utils';

// Arc-style theming: one hue drives the entire accent family (globals.css
// derives accent/hover/soft/selection/shine from --accent-hue/--accent-chroma
// in OKLCH). Presets cover the useful range; the slider is for the rest.
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

export function useApplyAccent() {
  const accentHue = useClientStore((s) => s.accentHue);
  const accentChroma = useClientStore((s) => s.accentChroma);
  useEffect(() => {
    const root = document.documentElement;
    if (accentHue == null) {
      root.style.removeProperty('--accent-hue');
      root.style.removeProperty('--accent-chroma');
      return;
    }
    root.style.setProperty('--accent-hue', String(accentHue));
    root.style.setProperty('--accent-chroma', String(accentChroma ?? DEFAULT_CHROMA));
  }, [accentHue, accentChroma]);
}

export function AccentPicker({ className }: { className?: string }) {
  useApplyAccent();
  const accentHue = useClientStore((s) => s.accentHue);
  const accentChroma = useClientStore((s) => s.accentChroma);
  const setAccent = useClientStore((s) => s.setAccent);
  const hue = accentHue ?? DEFAULT_HUE;
  const chroma = accentChroma ?? DEFAULT_CHROMA;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Accent color"
          title="Accent color"
          className={cn(
            'grid h-7 w-7 place-items-center rounded-md text-[var(--color-text-muted)] transition-colors duration-[var(--duration-fast)] hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text)]',
            className,
          )}
        >
          <Palette className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-56 p-3">
        <div className="mb-2 text-[11px] font-medium text-[var(--color-text-muted)]">Accent</div>
        <div className="grid grid-cols-6 gap-1.5">
          {PRESETS.map((preset) => {
            const selected =
              preset.hue === hue && Math.abs(preset.chroma - chroma) < 0.005 && accentHue !== null;
            const isDefault = preset.hue === DEFAULT_HUE && accentHue === null;
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
                  'grid h-7 w-7 place-items-center rounded-md transition-transform duration-[var(--duration-fast)] hover:scale-110',
                  (selected || isDefault) &&
                    'ring-2 ring-[var(--color-border-strong)] ring-offset-1 ring-offset-[var(--color-bg-elevated)]',
                )}
                style={{ background: `oklch(0.62 ${preset.chroma} ${preset.hue})` }}
              >
                <span className="sr-only">{preset.name}</span>
              </button>
            );
          })}
        </div>
        <div className="mt-3">
          <input
            type="range"
            min={0}
            max={359}
            value={hue}
            aria-label="Custom accent hue"
            onChange={(event) => setAccent(Number(event.target.value), Math.max(chroma, 0.08))}
            className="h-1.5 w-full cursor-pointer appearance-none rounded-full"
            style={{
              background:
                'linear-gradient(to right, oklch(0.62 0.11 0), oklch(0.62 0.11 60), oklch(0.62 0.11 120), oklch(0.62 0.11 180), oklch(0.62 0.11 240), oklch(0.62 0.11 300), oklch(0.62 0.11 359))',
            }}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
