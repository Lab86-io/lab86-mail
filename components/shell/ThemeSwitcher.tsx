'use client';

import { Moon, Sun, Monitor } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

const OPTIONS = [
  { value: 'light', icon: Sun, label: 'Light' },
  { value: 'system', icon: Monitor, label: 'Auto' },
  { value: 'dark', icon: Moon, label: 'Dark' },
] as const;

export function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <div className="h-7 w-full rounded border border-[var(--color-border)]" />;
  return (
    <div className="flex items-center gap-0.5 rounded border border-[var(--color-border)] p-0.5">
      {OPTIONS.map(({ value, icon: Icon, label }) => (
        <button
          key={value}
          type="button"
          onClick={() => setTheme(value)}
          className={cn(
            'flex h-6 flex-1 items-center justify-center gap-1 rounded-sm text-[10px] font-medium uppercase tracking-wider transition-colors',
            theme === value
              ? 'bg-[var(--color-bg-subtle)] text-[var(--color-text)]'
              : 'text-[var(--color-text-faint)] hover:text-[var(--color-text-muted)]',
          )}
          title={label}
        >
          <Icon className="h-3 w-3" />
        </button>
      ))}
    </div>
  );
}
