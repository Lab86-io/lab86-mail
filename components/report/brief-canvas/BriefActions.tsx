'use client';

import { Check, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import { briefActionTier, isKnownBriefAction } from '@/lib/shared/brief-actions';
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
  const visible = actions.filter((action) => isKnownBriefAction(action.action));
  if (!visible.length) return null;
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
    </div>
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
      onClick={tier === 'review' ? undefined : run}
    >
      {pending ? <Loader2 className="animate-spin" /> : null}
      {action.label}
    </Button>
  );

  if (tier !== 'review') return button;
  const copy = briefActionReviewCopy(action, payload);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{button}</PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <PopoverHeader>
          <PopoverTitle>{copy.title}</PopoverTitle>
          <PopoverDescription>{copy.detail}</PopoverDescription>
        </PopoverHeader>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={pending} onClick={run}>
            {pending ? <Loader2 className="animate-spin" /> : <Check />}
            {copy.confirm}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
