'use client';

import { useEffect, useState } from 'react';
import { fromColor, fromInitials, shortFrom } from '@/lib/shared/format';
import { cn } from '@/lib/utils';

export function Avatar({
  name,
  src,
  size = 28,
  className,
}: {
  name: string | null | undefined;
  src?: string | null;
  size?: number;
  className?: string;
  // Kept for call-site compatibility; geometric variants are no longer drawn —
  // identity reads faster from initials than from a marble (data drives form).
  variant?: 'marble' | 'beam' | 'pixel' | 'sunset' | 'ring' | 'bauhaus';
}) {
  const seed = shortFrom(name || 'unknown').toLowerCase() || 'unknown';
  // If the upstream URL fails (CSP, network, default-photo HEAD denial),
  // gracefully fall back to initials without flashing a broken image.
  // Reset the broken-image flag whenever the URL changes so we'll retry loading.
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    setBroken(false);
  }, [src]);
  const showImage = !!src && !broken;
  return (
    <div
      className={cn(
        'shrink-0 overflow-hidden rounded-full border border-[var(--color-avatar-ring)] bg-[var(--color-avatar-bg)] shadow-[var(--shadow-control)]',
        className,
      )}
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
        <span
          role="img"
          aria-label={seed}
          className="grid h-full w-full select-none place-items-center font-semibold uppercase leading-none text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)]"
          style={{
            backgroundColor: fromColor(name),
            fontSize: Math.max(9, Math.round(size * 0.4)),
            letterSpacing: '0.01em',
          }}
        >
          {fromInitials(name)}
        </span>
      )}
    </div>
  );
}
