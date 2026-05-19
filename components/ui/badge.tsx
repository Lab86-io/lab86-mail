import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
  {
    variants: {
      variant: {
        default:
          'border-[var(--color-border)] bg-[var(--color-bg-subtle)] text-[var(--color-text-muted)]',
        accent:
          'border-transparent bg-[var(--color-accent-soft)] text-[var(--color-accent)]',
        success: 'border-transparent text-[var(--color-success)] bg-[var(--color-success)]/10',
        warning: 'border-transparent text-[var(--color-warning)] bg-[var(--color-warning)]/10',
        danger: 'border-transparent text-[var(--color-danger)] bg-[var(--color-danger)]/10',
        outline: 'border-[var(--color-border)] bg-transparent text-[var(--color-text-muted)]',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
