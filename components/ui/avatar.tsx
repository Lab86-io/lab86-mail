'use client';

import { cn } from '@/lib/utils';
import { fromColor, fromInitials } from '@/lib/shared/format';

export function Avatar({
  name,
  size = 28,
  className,
}: {
  name: string | null | undefined;
  size?: number;
  className?: string;
}) {
  const color = fromColor(name || '');
  const initials = fromInitials(name || '?');
  return (
    <div
      className={cn(
        'grid shrink-0 select-none place-items-center rounded-full text-white shadow-[var(--shadow-soft)]',
        className,
      )}
      style={{
        width: size,
        height: size,
        background: color,
        fontSize: Math.max(10, size * 0.4),
        fontWeight: 600,
        letterSpacing: '-0.02em',
      }}
    >
      {initials}
    </div>
  );
}
