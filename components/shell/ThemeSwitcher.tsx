'use client';

import { MonitorCog, Moon, SunMedium } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

const ORDER = ['light', 'dark', 'system'] as const;
const ICON: Record<string, any> = {
  light: SunMedium,
  dark: Moon,
  system: MonitorCog,
};
const LABEL: Record<string, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
};

export function ThemeSwitcher({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <div className={cn('h-7 w-7', className)} />;

  const current = (ORDER.includes(theme as any) ? theme : 'system') as (typeof ORDER)[number];
  const Icon = ICON[current];
  const next = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length];

  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      title={`Theme: ${LABEL[current]} → ${LABEL[next]}`}
      className={cn(
        'grid h-7 w-7 place-items-center rounded-md text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text)]',
        className,
      )}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={current}
          initial={{ scale: 0.6, opacity: 0, rotate: -90 }}
          animate={{ scale: 1, opacity: 1, rotate: 0 }}
          exit={{ scale: 0.6, opacity: 0, rotate: 90 }}
          transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        >
          <Icon className="h-3.5 w-3.5" />
        </motion.span>
      </AnimatePresence>
    </button>
  );
}
