'use client';

// @ai-elements/task (registry.ai-sdk.dev), restyled to the app tokens. The
// structure is the registry's: a collapsible with a trigger line and a rule
// on the left of its items. The search icon before the trigger text is gone
// (no icons before text); colors and sizes follow the chat type scale.

import { ChevronDownIcon } from 'lucide-react';
import type { ComponentProps } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

export type TaskItemFileProps = ComponentProps<'div'>;

export const TaskItemFile = ({ children, className, ...props }: TaskItemFileProps) => (
  <div
    className={cn(
      'corner-smooth inline-flex items-center gap-1 rounded-[var(--radius-xs)] border border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-1.5 py-0.5 text-[11px] text-[var(--color-text)]',
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

export type TaskItemProps = ComponentProps<'div'>;

export const TaskItem = ({ children, className, ...props }: TaskItemProps) => (
  <div className={cn('text-[12px] text-[var(--color-text-muted)]', className)} {...props}>
    {children}
  </div>
);

export type TaskProps = ComponentProps<typeof Collapsible>;

export const Task = ({ defaultOpen = true, className, ...props }: TaskProps) => (
  <Collapsible className={cn(className)} defaultOpen={defaultOpen} {...props} />
);

export type TaskTriggerProps = ComponentProps<typeof CollapsibleTrigger> & {
  title: string;
};

export const TaskTrigger = ({ children, className, title, ...props }: TaskTriggerProps) => (
  <CollapsibleTrigger asChild className={cn('group', className)} {...props}>
    {children ?? (
      <div className="flex w-full cursor-pointer items-center gap-2 text-[12px] text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)]">
        <p className="text-[12px]">{title}</p>
        <ChevronDownIcon
          aria-hidden
          className="size-3.5 text-[var(--color-text-faint)] transition-transform group-data-[state=open]:rotate-180"
        />
      </div>
    )}
  </CollapsibleTrigger>
);

export type TaskContentProps = ComponentProps<typeof CollapsibleContent>;

export const TaskContent = ({ children, className, ...props }: TaskContentProps) => (
  <CollapsibleContent
    className={cn(
      'data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-1 data-[state=open]:slide-in-from-top-1 outline-none data-[state=closed]:animate-out data-[state=open]:animate-in',
      className,
    )}
    {...props}
  >
    <div className="mt-2 space-y-1.5 border-[var(--color-border)] border-l pl-3">{children}</div>
  </CollapsibleContent>
);
