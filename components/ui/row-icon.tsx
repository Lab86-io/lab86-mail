'use client';

import { type ComponentType, type Ref, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

// Adapter for lucide-animated registry icons (components/ui/<icon>.tsx).
// Each icon ships its own unique animation plus an imperative handle; this
// binds that animation to the nearest interactive ancestor, so hovering a
// sidebar row or toolbar button plays its icon's animation (claude.ai-style)
// instead of only when the cursor lands on the glyph itself. With no
// interactive ancestor the icon falls back to animating on its own hover.

interface IconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

type AnimatedIconComponent = ComponentType<{
  ref?: Ref<IconHandle>;
  size?: number;
  className?: string;
}>;

const ROW_SELECTOR = 'button, a, [role="button"], [role="menuitem"], [data-icon-row]';

export function RowIcon({
  icon: Icon,
  size = 16,
  className,
}: {
  icon: AnimatedIconComponent;
  size?: number;
  className?: string;
}) {
  const handleRef = useRef<IconHandle>(null);
  const hostRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const row = host.closest(ROW_SELECTOR) ?? host;
    const enter = () => handleRef.current?.startAnimation();
    const leave = () => handleRef.current?.stopAnimation();
    row.addEventListener('mouseenter', enter);
    row.addEventListener('mouseleave', leave);
    return () => {
      row.removeEventListener('mouseenter', enter);
      row.removeEventListener('mouseleave', leave);
    };
  }, []);

  return (
    <span ref={hostRef} className="inline-flex shrink-0">
      <Icon ref={handleRef} size={size} className={cn('flex items-center justify-center', className)} />
    </span>
  );
}

// Factory for places that take an icon COMPONENT (e.g. the Rail's mailbox and
// smart-category tables render `<item.Icon />`). Pre-binds size/class so the
// call sites stay untouched.
export function rowIcon(icon: AnimatedIconComponent, size = 16) {
  function BoundRowIcon({ className }: { className?: string }) {
    return <RowIcon icon={icon} size={size} className={className} />;
  }
  BoundRowIcon.displayName = 'BoundRowIcon';
  return BoundRowIcon;
}
