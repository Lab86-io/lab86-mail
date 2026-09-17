'use client';

// Adapted from Odyssey UI; see README.md for upstream source and local changes.

import { Check, ChevronDown, Circle, CircleAlert, Loader2 } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import React, { createContext, useContext, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { ShimmerText } from './text-shimmer';

export type ThoughtChainStatus = 'done' | 'active' | 'pending' | 'failed';
type Status = ThoughtChainStatus;

type StepContextType = {
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
  status: Status;
};

const StepContext = createContext<StepContextType | null>(null);

const statusStyles: Record<Status, { label: string; line: string; badge: string }> = {
  failed: { label: 'text-[var(--color-danger)]', line: 'bg-[var(--color-danger)]/30', badge: '' },
  done: {
    label: 'text-muted-foreground',
    line: 'bg-[var(--color-success)]/30',
    badge: '',
  },
  active: {
    label: 'text-foreground',
    line: 'bg-[var(--color-accent)]/25',
    badge: 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]',
  },
  pending: {
    label: 'text-muted-foreground',
    line: 'bg-border',
    badge: '',
  },
};

function StatusIcon({ status }: { status: Status }) {
  const reduceMotion = useReducedMotion();
  if (status === 'failed') return <CircleAlert className="size-4 text-[var(--color-danger)]" />;
  if (status === 'done') {
    return (
      <span className="flex size-5 items-center justify-center rounded-full bg-[var(--color-success)]">
        <Check className="size-3 text-[var(--color-success-foreground)]" strokeWidth={3} />
      </span>
    );
  }

  if (status === 'active') {
    return (
      <motion.span
        animate={reduceMotion ? undefined : { rotate: 360 }}
        transition={{ repeat: Infinity, duration: 0.75, ease: 'linear' }}
        className="flex size-5 items-center justify-center"
      >
        <Loader2 className="size-5 text-[var(--color-accent)]" />
      </motion.span>
    );
  }

  return <Circle className="size-5 text-muted-foreground" />;
}

export function ThoughtChain({ children, ...props }: React.ComponentProps<'div'>) {
  const steps = React.Children.toArray(children);
  const total = steps.length;

  return (
    <div data-slot="thought-chain" {...props}>
      {steps.map((step, index) =>
        React.isValidElement(step)
          ? React.cloneElement(step as React.ReactElement<{ _isLast?: boolean }>, {
              _isLast: index === total - 1,
            })
          : step,
      )}
    </div>
  );
}

export function ThoughtChainStep({
  children,
  status = 'pending',
  defaultOpen = true,
  _isLast = false,
  className,
  ...props
}: {
  children: React.ReactNode;
  status?: Status;
  defaultOpen?: boolean;
  _isLast?: boolean;
} & React.ComponentProps<typeof Collapsible>) {
  const [open, setOpen] = useState(defaultOpen);
  const styles = statusStyles[status];

  return (
    <StepContext.Provider value={{ open, setOpen, status }}>
      <Collapsible
        data-slot="thought-chain-step"
        data-status={status}
        open={open}
        onOpenChange={setOpen}
        className={className}
        {...props}
      >
        <div className="flex min-w-0 gap-2.5">
          <div className="flex shrink-0 flex-col items-center">
            <span className="mt-0.5">
              <StatusIcon status={status} />
            </span>

            {!_isLast && <span className={cn('mt-1.5 min-h-5 w-0.5 flex-1 rounded-sm', styles.line)} />}
          </div>

          <div className="min-w-0 flex-1 pb-2">{children}</div>
        </div>
      </Collapsible>
    </StepContext.Provider>
  );
}

export function ThoughtChainTrigger({
  children,
  expandable = true,
}: {
  children: React.ReactNode;
  expandable?: boolean;
}) {
  const reduceMotion = useReducedMotion();
  const { open, status } = useContext(StepContext)!;
  const styles = statusStyles[status];

  return (
    <CollapsibleTrigger
      disabled={!expandable}
      className="flex w-full min-w-0 cursor-pointer select-none flex-wrap items-center gap-1.5 rounded-sm text-left focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default"
    >
      <span className={cn('min-w-0 break-words text-[12px] font-medium', styles.label)}>
        {status === 'active' ? (
          typeof children === 'string' ? (
            <ShimmerText text={children} />
          ) : (
            children
          )
        ) : (
          children
        )}
      </span>

      {expandable && (
        <motion.span
          animate={{ rotate: open ? 180 : 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.2, ease: 'easeInOut' }}
          className="flex items-center text-muted-foreground"
        >
          <ChevronDown className="size-3.5" />
        </motion.span>
      )}
      <span className="sr-only">
        {status === 'done' ? 'Done' : status === 'failed' ? 'Failed' : status === 'pending' ? 'Pending' : ''}
      </span>

      {status === 'active' && (
        <Badge variant="outline" className={cn(styles.badge, 'border-[var(--color-accent)]/30')}>
          In progress
        </Badge>
      )}
    </CollapsibleTrigger>
  );
}

export function ThoughtChainContent({ children }: { children: React.ReactNode }) {
  const { open } = useContext(StepContext)!;
  const reduceMotion = useReducedMotion();

  return (
    <CollapsibleContent forceMount>
      <motion.div
        initial={false}
        animate={{ opacity: open ? 1 : 0, height: open ? 'auto' : 0 }}
        transition={{ duration: reduceMotion ? 0 : 0.22, ease: 'easeInOut' }}
        className="overflow-hidden"
        aria-hidden={!open}
        inert={!open}
      >
        <div className="mt-1 pl-0.5">{children}</div>
      </motion.div>
    </CollapsibleContent>
  );
}

export function ThoughtChainItem({ children }: { children: React.ReactNode }) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.3, ease: 'easeOut' }}
      className="flex items-start gap-2 py-1.25"
    >
      <span className="mt-1.75 size-1 shrink-0 rounded-full bg-border" />
      <span className="text-[12px] leading-[1.55] text-muted-foreground">{children}</span>
    </motion.div>
  );
}
