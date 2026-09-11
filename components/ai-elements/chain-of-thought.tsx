'use client';

// @ai-elements/chain-of-thought (registry.ai-sdk.dev), restyled to the app
// tokens. Structure is the registry's: a controllable open state shared by
// the header (a collapsible trigger) and the content (the rows), each row a
// step with an icon column and the vertical rule under it. Changes here are
// style only: the brain icon before the header text is gone (no icons before
// text), sizes follow the chat type scale, colors are the OKLCH tokens, and
// the step icon accepts any small component so the work log can pass its
// state glyphs.

import { useControllableState } from '@radix-ui/react-use-controllable-state';
import { ChevronDownIcon, DotIcon } from 'lucide-react';
import type { ComponentProps, ComponentType, ReactNode } from 'react';
import { createContext, memo, useContext, useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

type ChainOfThoughtContextValue = {
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
};

const ChainOfThoughtContext = createContext<ChainOfThoughtContextValue | null>(null);

const useChainOfThought = () => {
  const context = useContext(ChainOfThoughtContext);
  if (!context) {
    throw new Error('ChainOfThought components must be used within ChainOfThought');
  }
  return context;
};

export type ChainOfThoughtProps = ComponentProps<'div'> & {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export const ChainOfThought = memo(
  ({ className, open, defaultOpen = false, onOpenChange, children, ...props }: ChainOfThoughtProps) => {
    const [isOpen, setIsOpen] = useControllableState({
      prop: open,
      defaultProp: defaultOpen,
      onChange: onOpenChange,
    });

    const chainOfThoughtContext = useMemo(() => ({ isOpen, setIsOpen }), [isOpen, setIsOpen]);

    return (
      <ChainOfThoughtContext.Provider value={chainOfThoughtContext}>
        <div className={cn('not-prose w-full min-w-0 space-y-1.5', className)} {...props}>
          {children}
        </div>
      </ChainOfThoughtContext.Provider>
    );
  },
);

export type ChainOfThoughtHeaderProps = ComponentProps<typeof CollapsibleTrigger> & {
  /** Show the chevron. Off while the block still works. */
  disclosure?: boolean;
};

export const ChainOfThoughtHeader = memo(
  ({ className, children, disclosure = true, ...props }: ChainOfThoughtHeaderProps) => {
    const { isOpen, setIsOpen } = useChainOfThought();

    return (
      <Collapsible onOpenChange={setIsOpen} open={isOpen}>
        <CollapsibleTrigger
          className={cn(
            'flex w-full items-center gap-2 px-1 text-[12px] text-[var(--color-text-muted)] transition-colors duration-[var(--duration-fast)] hover:text-[var(--color-text)]',
            className,
          )}
          {...props}
        >
          <span className="flex min-w-0 flex-1 items-center gap-2 text-left">{children ?? 'Steps'}</span>
          {disclosure ? (
            <ChevronDownIcon
              aria-hidden
              className={cn('size-3.5 shrink-0 transition-transform', isOpen ? 'rotate-180' : 'rotate-0')}
            />
          ) : null}
        </CollapsibleTrigger>
      </Collapsible>
    );
  },
);

export type ChainOfThoughtStepProps = ComponentProps<'div'> & {
  icon?: ComponentType<{ className?: string }>;
  label: ReactNode;
  description?: ReactNode;
  status?: 'complete' | 'active' | 'pending';
};

export const ChainOfThoughtStep = memo(
  ({
    className,
    icon: Icon = DotIcon,
    label,
    description,
    status = 'complete',
    children,
    ...props
  }: ChainOfThoughtStepProps) => {
    const statusStyles = {
      complete: 'text-[var(--color-text-faint)]',
      active: 'text-[var(--color-text-muted)]',
      pending: 'text-[var(--color-text-faint)]/60',
    };

    return (
      <div
        data-status={status}
        className={cn(
          'group/step flex gap-2 text-[12px] leading-relaxed',
          statusStyles[status],
          'fade-in-0 slide-in-from-top-1 animate-in',
          className,
        )}
        {...props}
      >
        <div className="relative mt-[3px] flex size-4 shrink-0 items-start justify-center">
          <Icon className="size-4" />
          <div
            aria-hidden
            className="-mx-px absolute top-5 bottom-0 left-1/2 w-px bg-[var(--color-border)] group-last/step:hidden"
          />
        </div>
        <div className="min-w-0 flex-1 space-y-1.5 pb-3">
          <div className="min-w-0">{label}</div>
          {description && <div className="text-[11.5px] text-[var(--color-text-muted)]">{description}</div>}
          {children}
        </div>
      </div>
    );
  },
);

export type ChainOfThoughtSearchResultsProps = ComponentProps<'div'>;

export const ChainOfThoughtSearchResults = memo(
  ({ className, ...props }: ChainOfThoughtSearchResultsProps) => (
    <div className={cn('flex flex-wrap items-center gap-2', className)} {...props} />
  ),
);

export type ChainOfThoughtSearchResultProps = ComponentProps<typeof Badge>;

export const ChainOfThoughtSearchResult = memo(
  ({ className, children, ...props }: ChainOfThoughtSearchResultProps) => (
    <Badge
      className={cn('gap-1 px-2 py-0.5 font-normal text-[11px]', className)}
      variant="secondary"
      {...props}
    >
      {children}
    </Badge>
  ),
);

export type ChainOfThoughtContentProps = ComponentProps<typeof CollapsibleContent>;

export const ChainOfThoughtContent = memo(({ className, children, ...props }: ChainOfThoughtContentProps) => {
  const { isOpen } = useChainOfThought();

  return (
    <Collapsible open={isOpen}>
      <CollapsibleContent
        className={cn(
          'mt-1 pl-1',
          'data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-1 data-[state=open]:slide-in-from-top-1 outline-none data-[state=closed]:animate-out data-[state=open]:animate-in',
          className,
        )}
        {...props}
      >
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
});

export type ChainOfThoughtImageProps = ComponentProps<'div'> & {
  caption?: string;
};

export const ChainOfThoughtImage = memo(
  ({ className, children, caption, ...props }: ChainOfThoughtImageProps) => (
    <div className={cn('mt-2 space-y-2', className)} {...props}>
      <div className="corner-smooth relative flex max-h-[22rem] items-center justify-center overflow-hidden rounded-[var(--radius-md)] bg-[var(--color-bg-subtle)] p-3">
        {children}
      </div>
      {caption && <p className="text-[11.5px] text-[var(--color-text-muted)]">{caption}</p>}
    </div>
  ),
);

ChainOfThought.displayName = 'ChainOfThought';
ChainOfThoughtHeader.displayName = 'ChainOfThoughtHeader';
ChainOfThoughtStep.displayName = 'ChainOfThoughtStep';
ChainOfThoughtSearchResults.displayName = 'ChainOfThoughtSearchResults';
ChainOfThoughtSearchResult.displayName = 'ChainOfThoughtSearchResult';
ChainOfThoughtContent.displayName = 'ChainOfThoughtContent';
ChainOfThoughtImage.displayName = 'ChainOfThoughtImage';
