import { cn } from '@/lib/utils';

/**
 * The bird, drawn once.
 *
 * The product is named after a metaphor it never showed anywhere. This is the
 * whole of it: a long-winged glide, in currentColor, no detail. Per the style
 * rules it appears in exactly four places — first run, completion, release, and
 * empty states — and never on a row, a card, or a button.
 */
export function AlbatrossMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      role="img"
      aria-hidden="true"
      focusable="false"
      className={cn('shrink-0', className)}
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* Seen from below, mid-glide: two long tapered wings, a slim body, a
          short tail. Filled rather than stroked — at 40px a line drawing of a
          bird reads as a squiggle. */}
      <path
        fill="currentColor"
        stroke="none"
        d="M32 20.2c1.5 0 2.6 1.1 3 2.8l.7 3.2 8.6-3.3c5.3-2 10.3-3 15-3 1.6 0 2.5.4 2.5 1.1 0 .6-.6 1.1-1.9 1.6l-11.3 4.4c-3.9 1.5-7.2 3.3-10 5.4l-2 1.5.5 2.6c.3 1.6.1 2.8-.6 3.6l-3.4 4.2c-.4.5-.8.7-1.1.7s-.7-.2-1.1-.7l-3.4-4.2c-.7-.8-.9-2-.6-3.6l.5-2.6-2-1.5c-2.8-2.1-6.1-3.9-10-5.4L4.1 22.6c-1.3-.5-1.9-1-1.9-1.6 0-.7.9-1.1 2.5-1.1 4.7 0 9.7 1 15 3l8.6 3.3.7-3.2c.4-1.7 1.5-2.8 3-2.8z"
      />
    </svg>
  );
}
