'use client';

// Adapted from Odyssey UI; see README.md for upstream source and local changes.

import { ChevronDown } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { ShimmerText } from './text-shimmer';

export type StepsItemProps = React.ComponentProps<'div'>;

export const StepsItem = ({ children, className, ...props }: StepsItemProps) => (
  <div
    className={cn(
      'text-muted-foreground hover:text-foreground text-[12px] transition-colors duration-200 motion-reduce:transition-none [&_strong]:text-[var(--color-accent)]',
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

export type StepsTriggerProps = React.ComponentProps<typeof CollapsibleTrigger> & {
  leftIcon?: React.ReactNode;
  swapIconOnHover?: boolean;
  active?: boolean;
};

export const StepsTrigger = ({
  children,
  className,
  leftIcon,
  swapIconOnHover = true,
  active = false,
  ...props
}: StepsTriggerProps) => (
  <CollapsibleTrigger
    className={cn(
      'group text-muted-foreground hover:text-[var(--color-accent)] flex w-full cursor-pointer items-center justify-start gap-1 text-[12px] transition-colors duration-200 motion-reduce:transition-none',
      className,
    )}
    {...props}
  >
    <span className="flex min-w-0 items-center gap-2">
      {leftIcon ? (
        <span className="relative inline-flex size-4 items-center justify-center">
          <span
            className={cn(
              'transition-opacity motion-reduce:transition-none',
              swapIconOnHover && 'group-hover:opacity-0',
            )}
          >
            {leftIcon}
          </span>
          {swapIconOnHover && (
            <ChevronDown className="absolute size-4 opacity-0 transition-opacity motion-reduce:transition-none group-hover:opacity-100 group-hover:text-[var(--color-accent)] group-data-[state=open]:rotate-180" />
          )}
        </span>
      ) : null}
      <span>{active && typeof children === 'string' ? <ShimmerText text={children} /> : children}</span>
    </span>
    {!leftIcon && (
      <ChevronDown className="size-4 transition-transform motion-reduce:transition-none group-hover:text-[var(--color-accent)] group-data-[state=open]:rotate-180" />
    )}
  </CollapsibleTrigger>
);

export type StepsContentProps = React.ComponentProps<typeof CollapsibleContent> & {
  bar?: React.ReactNode;
};

export const StepsContent = ({ children, className, bar, ...props }: StepsContentProps) => {
  return (
    <CollapsibleContent
      className={cn(
        'text-popover-foreground data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down overflow-hidden motion-reduce:animate-none',
        className,
      )}
      {...props}
    >
      <div className="group mt-3 grid max-w-full min-w-0 grid-cols-[min-content_minmax(0,1fr)] items-start gap-x-3">
        <div className="min-w-0 self-stretch">{bar ?? <StepsBar />}</div>
        <div className="min-w-0 space-y-2">{children}</div>
      </div>
    </CollapsibleContent>
  );
};

export type StepsBarProps = React.HTMLAttributes<HTMLDivElement>;

export const StepsBar = ({ className, ...props }: StepsBarProps) => (
  <div
    className={cn(
      'bg-muted h-full w-[2px] transition-colors duration-300 motion-reduce:transition-none group-hover:bg-[var(--color-accent)]/40',
      className,
    )}
    aria-hidden
    {...props}
  />
);

export type StepsProps = React.ComponentProps<typeof Collapsible>;

export function Steps({ defaultOpen = true, className, ...props }: StepsProps) {
  return <Collapsible data-slot="steps" className={cn(className)} defaultOpen={defaultOpen} {...props} />;
}
