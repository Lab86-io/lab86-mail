'use client';

// The one small choice in a composer's send area when a sealed file needs a
// send permission: a sentence per item, "Allow for this send", and "Always
// for mail to {domain}". Plain text, no icons, no modal.

import { Button } from '@/components/ui/button';
import {
  ALLOW_SEND_COPY,
  type AllowSendRefusal,
  type AllowSendScope,
  allowSendAlwaysLabel,
  allowSendSentences,
} from '@/lib/mail/allow-send';
import { cn } from '@/lib/utils';

export function AllowSendChoice({
  refusal,
  sealedFileNames = [],
  busy,
  error,
  onChoose,
  className,
}: {
  refusal: AllowSendRefusal;
  sealedFileNames?: readonly string[];
  busy: AllowSendScope | null;
  error: string | null;
  onChoose: (scope: AllowSendScope) => void;
  className?: string;
}) {
  const sentences = allowSendSentences(refusal, sealedFileNames);
  return (
    <section
      data-slot="allow-send"
      data-allow-code={refusal.code}
      aria-label={sentences[0] ?? refusal.error}
      className={cn('flex flex-col gap-2 border-t border-[var(--color-border)] px-3 py-2.5', className)}
    >
      {refusal.code === 'allow_ended' && refusal.error ? (
        <p className="text-[12.5px] text-[var(--color-text-muted)]">{refusal.error}</p>
      ) : null}
      {sentences.map((sentence) => (
        <p key={sentence} className="text-[12.5px] leading-[1.5]">
          {sentence}
        </p>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" disabled={Boolean(busy)} onClick={() => onChoose('once')}>
          {busy === 'once' ? ALLOW_SEND_COPY.busy : ALLOW_SEND_COPY.once}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={Boolean(busy)}
          onClick={() => onChoose('always')}
        >
          {busy === 'always' ? ALLOW_SEND_COPY.busy : allowSendAlwaysLabel(refusal)}
        </Button>
      </div>
      {error ? <p className="text-[11.5px] text-[var(--color-danger)]">{error}</p> : null}
    </section>
  );
}
