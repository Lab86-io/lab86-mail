'use client';

import { MoreHorizontal } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import { briefActionTier, isBriefSteeringAction, isKnownBriefAction } from '@/lib/shared/brief-actions';
import type { BriefActionV2, BriefSourceRefV2 } from '@/lib/shared/brief-document';
import { cn } from '@/lib/utils';
import {
  type BriefActionPayload,
  briefActionReviewCopy,
  payloadForBriefAction,
} from './brief-action-runtime';

export function BriefActions({
  actions,
  sourceRef,
  onAction,
  compact = false,
}: {
  actions: BriefActionV2[];
  sourceRef?: BriefSourceRefV2;
  onAction: (action: BriefActionV2, payload: BriefActionPayload) => Promise<void> | void;
  compact?: boolean;
}) {
  const known = actions.filter((action) => isKnownBriefAction(action.action));
  const visible = known.filter((action) => !isBriefSteeringAction(action.action));
  const steering = known.filter((action) => isBriefSteeringAction(action.action));
  if (!known.length) return null;
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', compact && 'gap-1')}>
      {visible.map((action) => (
        <BriefActionControl
          key={`${action.action}:${action.label}:${JSON.stringify(action.payload)}`}
          action={action}
          payload={payloadForBriefAction(action, sourceRef)}
          onAction={onAction}
          compact={compact}
        />
      ))}
      {steering.length ? (
        <BriefSteeringMenu
          actions={steering}
          onRun={(action) => onAction(action, payloadForBriefAction(action, sourceRef))}
        />
      ) : null}
    </div>
  );
}

/**
 * The steering choices of one item (FEATURES item 8): "Not for me", "Less
 * from this sender", "Keep showing". They sit behind the item's overflow
 * control so the row keeps one clear action. The trigger is an icon with a
 * label for assistive technology; the choices are text.
 */
export function BriefSteeringMenu({
  actions,
  onRun,
  className,
}: {
  actions: BriefActionV2[];
  onRun: (action: BriefActionV2) => Promise<void> | void;
  className?: string;
}) {
  if (!actions.length) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-brief-steering-trigger
          aria-label="Tune this item in the brief"
          title="Tune this item"
          className={cn(
            'grid size-6 place-items-center rounded-ui text-[var(--color-text-faint)] hover:bg-[var(--color-hover-soft)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]',
            className,
          )}
        >
          <MoreHorizontal className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel className="text-[11px] font-medium text-[var(--color-text-muted)]">
          In future briefs
        </DropdownMenuLabel>
        {actions.map((action) => (
          <DropdownMenuItem
            key={`${action.label}:${String(action.payload.mode ?? '')}`}
            data-brief-steering-choice={String(action.payload.mode ?? '')}
            className="text-[12.5px]"
            onSelect={() => void onRun(action)}
          >
            {action.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function BriefActionControl({
  action,
  payload,
  onAction,
  compact,
}: {
  action: BriefActionV2;
  payload: BriefActionPayload;
  onAction: (action: BriefActionV2, payload: BriefActionPayload) => Promise<void> | void;
  compact: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [open, setOpen] = useState(false);
  const tier = briefActionTier(action.action);
  const variant =
    action.style === 'danger'
      ? 'destructive'
      : action.style === 'primary'
        ? 'default'
        : action.style === 'quiet'
          ? 'ghost'
          : 'outline';

  const run = async () => {
    setPending(true);
    try {
      await onAction(action, payload);
      setOpen(false);
    } finally {
      setPending(false);
    }
  };

  const button = (
    <Button
      type="button"
      size={compact ? 'xs' : 'sm'}
      variant={variant}
      disabled={pending}
      aria-busy={pending || undefined}
      onClick={tier === 'review' ? undefined : run}
    >
      {pending ? 'Working…' : action.label}
    </Button>
  );

  if (tier !== 'review') return button;
  return (
    <BriefReviewPopover
      action={action}
      payload={payload}
      open={open}
      onOpenChange={setOpen}
      pending={pending}
      onConfirm={run}
    >
      {button}
    </BriefReviewPopover>
  );
}

/**
 * The review contract: a consequential action confirms before it runs. The
 * letter rows and the canvas action controls share this one popover, so the
 * copy from `briefActionReviewCopy` reads the same everywhere.
 */
export function BriefReviewPopover({
  action,
  payload,
  open,
  onOpenChange,
  pending,
  onConfirm,
  children,
}: {
  action: BriefActionV2;
  payload: BriefActionPayload;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  onConfirm: () => void | Promise<void>;
  children: ReactNode;
}) {
  const copy = briefActionReviewCopy(action, payload);
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <PopoverHeader>
          <PopoverTitle>{copy.title}</PopoverTitle>
          <PopoverDescription>{copy.detail}</PopoverDescription>
        </PopoverHeader>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={pending}
            aria-busy={pending || undefined}
            onClick={() => void onConfirm()}
          >
            {pending ? 'Working…' : copy.confirm}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
