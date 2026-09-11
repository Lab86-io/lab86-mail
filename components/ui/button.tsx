import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import * as React from 'react';

import { cn } from '@/lib/utils';

const buttonVariants = cva(
  "corner-smooth inline-flex shrink-0 items-center justify-center gap-2 rounded-ui border border-transparent text-sm font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow] duration-[var(--duration-fast)] outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)] disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          'bg-[var(--color-accent)] text-[var(--color-accent-foreground)] shadow-[var(--shadow-control)] hover:bg-[var(--color-accent-hover)]',
        destructive:
          'bg-destructive text-destructive-foreground shadow-[var(--shadow-control)] hover:bg-destructive/90 focus-visible:outline-destructive',
        outline:
          'border-[var(--color-control-border)] bg-[var(--color-control)] text-[var(--color-text)] shadow-[var(--shadow-control)] hover:border-[var(--color-border-strong)] hover:bg-[var(--color-control-hover)]',
        secondary:
          'bg-[var(--color-bg-muted)] text-[var(--color-text)] shadow-none hover:bg-[var(--color-control-hover)]',
        ghost:
          'bg-transparent text-[var(--color-text-muted)] shadow-none hover:bg-[var(--color-control-hover)] hover:text-[var(--color-text)]',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 py-2 has-[>svg]:px-3',
        xs: "h-6 gap-1 px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: 'h-8 gap-1.5 px-3 has-[>svg]:px-2.5',
        lg: 'h-10 px-6 has-[>svg]:px-4',
        icon: 'size-9',
        'icon-xs': "size-6 [&_svg:not([class*='size-'])]:size-3",
        'icon-sm': 'size-8',
        'icon-lg': 'size-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : 'button';

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
