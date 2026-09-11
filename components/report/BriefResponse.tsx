'use client';

import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { BriefResponseRef } from '@/lib/brief/response';
import { useClientStore } from '@/lib/client-state';

export function BriefResponse({ reference, title }: { reference: BriefResponseRef; title: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [response, setResponse] = useState('');
  const [target, setTarget] = useState({ reference, title });
  const changed = JSON.stringify(target.reference) !== JSON.stringify(reference);
  const [submitted, setSubmitted] = useState(false);
  const pending = useClientStore((state) => state.assistantBriefRequest);
  return (
    <div className="mt-2" data-brief-response>
      {open ? (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!response.trim() || pending || changed) return;
            const accepted = useClientStore.getState().queueBriefResponse({
              id: crypto.randomUUID(),
              reference: target.reference,
              title: target.title,
              response: response.trim(),
            });
            if (accepted) {
              setOpen(false);
              setSubmitted(true);
              setResponse('');
            }
          }}
        >
          <label htmlFor={id} className="block text-xs text-[var(--color-text-muted)]">
            What would you like Albatross to do?
          </label>
          <Textarea
            id={id}
            autoFocus
            value={response}
            onChange={(event) => setResponse(event.target.value)}
            maxLength={4000}
            required
            placeholder="Draft the reply and a short proposal. Keep the deadline open."
            className="rounded-ui min-h-20 text-sm"
          />
          {changed ? (
            <div role="status" className="text-xs text-[var(--color-text-muted)]">
              The recommendation changed. Your response is still here.
              <Button size="sm" variant="ghost" type="button" onClick={() => setTarget({ reference, title })}>
                Use updated recommendation
              </Button>
            </div>
          ) : null}
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={!response.trim() || !!pending || changed}>
              Take it forward
            </Button>
            <Button size="sm" variant="ghost" type="button" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            type="button"
            onClick={() => {
              setTarget({ reference, title });
              setOpen(true);
            }}
          >
            Respond & act
          </Button>
          {submitted ? (
            <span role="status" className="text-xs text-[var(--color-text-muted)]">
              Continued in chat
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}
