'use client';

import BoringAvatar from 'boring-avatars';
import { useEffect, useState } from 'react';
import { shortFrom } from '@/lib/shared/format';
import { cn } from '@/lib/utils';

const PALETTE = [
  'var(--color-avatar-1)',
  'var(--color-avatar-2)',
  'var(--color-avatar-3)',
  'var(--color-avatar-4)',
  'var(--color-avatar-5)',
];

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
  // Reset the broken-image flag whenever the URL changes so we'll retry loading.
  const [broken, setBroken] = useState(false);
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
        <BoringAvatar size={size} name={seed} variant={variant} colors={PALETTE} square={false} />
      )}
    </div>
  );
}
