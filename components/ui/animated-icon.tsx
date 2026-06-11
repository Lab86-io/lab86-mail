'use client';

import type { LucideIcon, LucideProps } from 'lucide-react';
import { motion, type Variants } from 'motion/react';

// Animated Lucide icons (pqoqubbw-style): a motion wrapper that gives any
// Lucide icon a slight, intentional micro-animation on hover/press. Use this
// for marquee/standalone icons where you want a richer motion than the blanket
// hover ease applied app-wide in globals.css. The rendered <svg> carries
// data-anim so the blanket rule skips it (no double transform).

export type AnimatedIconVariant = 'lift' | 'wiggle' | 'spin' | 'pop';

const VARIANTS: Record<AnimatedIconVariant, Variants> = {
  // Subtle rise + grow — the default for most action icons.
  lift: { rest: { y: 0, scale: 1, rotate: 0 }, hover: { y: -1.5, scale: 1.14 }, tap: { scale: 0.9 } },
  // Playful shake — good for notifications/alerts.
  wiggle: { rest: { rotate: 0 }, hover: { rotate: [0, -10, 10, -6, 0] }, tap: { scale: 0.9 } },
  // Quarter turn — good for settings/refresh.
  spin: { rest: { rotate: 0 }, hover: { rotate: 90 }, tap: { scale: 0.9, rotate: 90 } },
  // Pronounced pop — good for primary CTAs.
  pop: { rest: { scale: 1 }, hover: { scale: 1.22 }, tap: { scale: 0.85 } },
};

export function AnimatedIcon({
  as: Icon,
  variant = 'lift',
  className,
  ...props
}: { as: LucideIcon; variant?: AnimatedIconVariant } & LucideProps) {
  return (
    <motion.span
      className="inline-flex"
      style={{ transformOrigin: 'center' }}
      initial="rest"
      animate="rest"
      whileHover="hover"
      whileTap="tap"
      variants={VARIANTS[variant]}
      transition={{ type: 'spring', stiffness: 400, damping: 15 }}
    >
      <Icon data-anim className={className} {...props} />
    </motion.span>
  );
}
