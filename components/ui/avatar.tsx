'use client';

import BoringAvatar from 'boring-avatars';
import { useEffect, useState } from 'react';
import { shortFrom } from '@/lib/shared/format';
import { cn } from '@/lib/utils';

// Warm-gray + accent palette plucked to harmonize with our Linear-y theme.
const PALETTE_LIGHT = ['#0b7285', '#2f7d55', '#b45309', '#b1483f', '#7c5dbf'];
const PALETTE_DARK = ['#4cb7c8', '#5fb289', '#d49a4d', '#e1655c', '#a796d8'];

export function Avatar({
  name,
  src,
  size = 28,
  className,
  variant = 'beam',
}: {
  name: string | null | undefined;
  src?: string | null;
  size?: number;
  className?: string;
  variant?: 'marble' | 'beam' | 'pixel' | 'sunset' | 'ring' | 'bauhaus';
}) {
  const seed = shortFrom(name || 'unknown').toLowerCase() || 'unknown';
  // If the upstream URL fails (CSP, network, default-photo HEAD denial),
  // gracefully fall back to the boring-avatar without flashing a broken image.
  // Reset the broken-image flag whenever the URL changes so we'll retry
  // loading. biome's exhaustive-deps rule misclassifies the prop as an outer
  // scope value here; the dep is correct.
  const [broken, setBroken] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: src is a prop, intentional reset trigger.
  useEffect(() => {
    setBroken(false);
  }, [src]);
  const showImage = !!src && !broken;
  return (
    <div
      className={cn('shrink-0 overflow-hidden rounded-full shadow-[var(--shadow-soft)]', className)}
      style={{ width: size, height: size }}
    >
      {showImage ? (
        // biome-ignore lint/performance/noImgElement: Google profile photos come from arbitrary lh3 paths; next/image needs an allowlist and adds no value at avatar sizes.
        <img
          src={src as string}
          alt={seed}
          width={size}
          height={size}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setBroken(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <BoringAvatar
          size={size}
          name={seed}
          variant={variant}
          colors={
            typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
              ? PALETTE_DARK
              : PALETTE_LIGHT
          }
          square={false}
        />
      )}
    </div>
  );
}
