'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';

interface ShineBorderProps extends React.HTMLAttributes<HTMLDivElement> {
  /**
   * Width of the border in pixels
   * @default 1
   */
  borderWidth?: number;
  /**
   * Duration of the animation in seconds
   * @default 14
   */
  duration?: number;
  /**
   * Color of the border, can be a single color or an array of colors
   * @default var(--color-accent)
   */
  shineColor?: string | string[];
}

/**
 * Shine Border
 *
 * An animated background border effect component with configurable properties.
 */
export function ShineBorder({
  borderWidth = 1,
  duration = 14,
  shineColor = 'var(--color-accent)',
  className,
  style,
  ...props
}: ShineBorderProps) {
  return (
    <div
      data-slot="shine-border"
      style={
        {
          '--border-width': `${borderWidth}px`,
          '--duration': `${duration}s`,
          backgroundImage: `radial-gradient(var(--color-transparent),var(--color-transparent), ${
            Array.isArray(shineColor) ? shineColor.join(',') : shineColor
          },var(--color-transparent),var(--color-transparent))`,
          backgroundSize: '300% 300%',
          mask: `linear-gradient(var(--color-mask) 0 0) content-box, linear-gradient(var(--color-mask) 0 0)`,
          WebkitMask: `linear-gradient(var(--color-mask) 0 0) content-box, linear-gradient(var(--color-mask) 0 0)`,
          WebkitMaskComposite: 'xor',
          maskComposite: 'exclude',
          padding: 'var(--border-width)',
          ...style,
        } as React.CSSProperties
      }
      className={cn(
        'motion-safe:animate-shine pointer-events-none absolute inset-0 size-full rounded-[inherit] will-change-[background-position]',
        className,
      )}
      {...props}
    />
  );
}
