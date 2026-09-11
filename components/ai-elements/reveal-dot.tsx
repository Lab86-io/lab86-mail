// The leading indicator (docs/chat-agentic-pass.md, section 4): a 6px accent
// dot that pulses on a 1.2s cycle. It sits after the last revealed word of a
// streaming reply (as a ::after on the `.chat-reveal` container) and, as this
// element, at the work log header while a tool runs. The `.reveal-dot` rule
// lives in app/globals.css.

import { cn } from '@/lib/utils';

export function RevealDot({ className }: { className?: string }) {
  return <span aria-hidden data-slot="reveal-dot" className={cn('reveal-dot', className)} />;
}
