'use client';
import { Check, Circle, CircleAlert, Loader2 } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

export function DocumentSaveStatus({
  applying,
  saving,
  error,
  recovered,
  dirty,
  revision,
  googleBehind,
}: {
  applying: boolean;
  saving: boolean;
  error: boolean;
  recovered: boolean;
  dirty: boolean;
  revision: number;
  googleBehind: boolean;
}) {
  const text =
    (applying
      ? 'Applying revision…'
      : saving
        ? 'Saving…'
        : error
          ? 'Save needs attention · draft retained'
          : recovered
            ? 'Recovered unsaved edits'
            : dirty
              ? 'Unsaved changes'
              : `Saved · revision ${revision}`) + (googleBehind ? ' · Google version behind' : '');
  const Icon = applying || saving ? Loader2 : error || recovered ? CircleAlert : dirty ? Circle : Check;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={text}
            className="grid size-6 shrink-0 place-items-center rounded-sm text-[var(--color-text-muted)] focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            <Icon aria-hidden="true" className={`size-3.5 ${applying || saving ? 'animate-spin' : ''}`} />
            <span role="status" aria-live="polite" className="sr-only">
              {text}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{text}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
