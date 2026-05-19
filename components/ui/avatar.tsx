'use client';

import BoringAvatar from 'boring-avatars';
import { cn } from '@/lib/utils';
import { shortFrom } from '@/lib/shared/format';

// Warm-gray + accent palette plucked to harmonize with our Linear-y theme.
const PALETTE_LIGHT = ['#0b7285', '#2f7d55', '#b45309', '#b1483f', '#7c5dbf'];
const PALETTE_DARK = ['#4cb7c8', '#5fb289', '#d49a4d', '#e1655c', '#a796d8'];

export function Avatar({
  name,
  size = 28,
  className,
  variant = 'beam',
}: {
  name: string | null | undefined;
  size?: number;
  className?: string;
  variant?: 'marble' | 'beam' | 'pixel' | 'sunset' | 'ring' | 'bauhaus';
}) {
  const seed = shortFrom(name || 'unknown').toLowerCase() || 'unknown';
  return (
    <div
      className={cn('shrink-0 overflow-hidden rounded-full shadow-[var(--shadow-soft)]', className)}
      style={{ width: size, height: size }}
    >
      <BoringAvatar
        size={size}
        name={seed}
        variant={variant}
        colors={typeof document !== 'undefined' && document.documentElement.classList.contains('dark') ? PALETTE_DARK : PALETTE_LIGHT}
        square={false}
      />
    </div>
  );
}
