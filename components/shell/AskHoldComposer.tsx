'use client';

import { ArrowUp, Square } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useVoiceCapture, VoiceCaptureButton } from '@/components/albatross/IntentCapture';
import { HoldLanding } from '@/components/shell/HoldLanding';
import { RouteChip, RouteTabHint } from '@/components/shell/RouteChip';
import { type RoutePredictionOptions, useRoutePrediction } from '@/components/shell/useRoutePrediction';
import { Button } from '@/components/ui/button';
import { PromptInput, PromptInputActions, PromptInputTextarea } from '@/components/ui/prompt-input';
import { HOLD_ERROR, type HoldCard } from '@/lib/albatross/capture-client';
import type { BarRoute } from '@/lib/albatross/route-classifier';
import { cn } from '@/lib/utils';

// One bar for Ask and Hold. The chip at the right edge says where Enter
// goes. Tab flips it. Cmd+Enter always sends to chat. Enter on Hold turns
// the bar into the parsed Work card, which then moves to the Work rail.

export const BAR_PLACEHOLDER = 'Find, draft, schedule, label, anything…';

/** A request from the sidebar door: open the bar with the chip on Hold. */
export interface DoorRequest {
  seed: string | null;
  nonce: number;
}

export type BarKeyAction = 'flip' | 'send' | 'hold' | 'clear' | null;

/** What one key does in the bar. Shift+Tab and Shift+Enter keep their browser meaning. */
export function barKeyAction(
  event: { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean },
  state: { route: BarRoute; empty: boolean },
): BarKeyAction {
  if (event.key === 'Tab') {
    if (event.shiftKey || state.empty) return null;
    return 'flip';
  }
  if (event.key === 'Enter') {
    if (event.shiftKey) return null;
    if (event.metaKey || event.ctrlKey) return 'send';
    return state.route === 'hold' ? 'hold' : 'send';
  }
  if (event.key === 'Escape') return state.empty ? null : 'clear';
  return null;
}

export interface AskHoldComposerProps {
  value: string;
  onValueChange: (value: string) => void;
  /** The chat is busy: a reply streams or files upload. */
  busy?: boolean;
  /** A reply streams. The send control reads Stop. */
  streaming?: boolean;
  /** True when a send has content: text or files. */
  canSend: boolean;
  onSend: () => void;
  onStop?: () => void;
  /** Keep the text as Work. Resolves the cards for the landing. Rejects on failure. */
  onHold: (text: string) => Promise<HoldCard[]>;
  /** After the landing ends. */
  onHeld?: (cards: HoldCard[]) => void;
  door?: DoorRequest | null;
  predict?: RoutePredictionOptions['predict'];
  railTarget?: () => Element | null;
  reduceMotion?: boolean;
  now?: () => number;
  /** Above the field: the scope chip, the file chips. */
  before?: ReactNode;
  /** Left of the voice control: the attach control. */
  leading?: ReactNode;
  placeholder?: string;
  className?: string;
}

interface Landing {
  text: string;
  cards: HoldCard[] | null;
}

export function AskHoldComposer({
  value,
  onValueChange,
  busy = false,
  streaming = false,
  canSend,
  onSend,
  onStop,
  onHold,
  onHeld,
  door = null,
  predict,
  railTarget,
  reduceMotion = false,
  now = () => Date.now(),
  before,
  leading,
  placeholder = BAR_PLACEHOLDER,
  className,
}: AskHoldComposerProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const prediction = useRoutePrediction({ text: value, predict });
  const voice = useVoiceCapture(() => valueRef.current, onValueChange);
  const [landing, setLanding] = useState<Landing | null>(null);
  const [holdError, setHoldError] = useState<string | null>(null);

  const focusField = useCallback(() => {
    if (typeof requestAnimationFrame !== 'function') return;
    requestAnimationFrame(() => wrapRef.current?.querySelector('textarea')?.focus());
  }, []);

  // The sidebar door: seed the field, preset Hold, focus.
  const doorNonceRef = useRef(0);
  useEffect(() => {
    if (!door || door.nonce === doorNonceRef.current) return;
    doorNonceRef.current = door.nonce;
    if (door.seed) onValueChange(door.seed);
    prediction.preset('hold');
    focusField();
  }, [door, onValueChange, prediction.preset, focusField]);

  const runHold = useCallback(() => {
    const text = valueRef.current.trim();
    if (!text || landing) return;
    if (voice.listening) voice.stop();
    setHoldError(null);
    setLanding({ text, cards: null });
    onValueChange('');
    onHold(text)
      .then((cards) => setLanding((current) => (current ? { ...current, cards } : current)))
      .catch(() => {
        // The text comes back. The chip stays on Hold, so Enter tries again.
        setLanding(null);
        onValueChange(text);
        prediction.preset('hold');
        setHoldError(HOLD_ERROR);
        focusField();
      });
  }, [landing, voice, onValueChange, onHold, prediction.preset, focusField]);

  const submit = useCallback(() => {
    if (streaming) {
      onStop?.();
      return;
    }
    if (busy) return;
    if (prediction.route === 'hold' && valueRef.current.trim()) {
      runHold();
      return;
    }
    onSend();
  }, [streaming, busy, onStop, prediction.route, runHold, onSend]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const action = barKeyAction(event, { route: prediction.route, empty: prediction.empty });
    if (!action) return;
    if (action === 'flip') {
      event.preventDefault();
      prediction.flip();
      return;
    }
    if (action === 'clear') {
      event.preventDefault();
      onValueChange('');
      return;
    }
    // The textarea already stopped the newline on Enter.
    if (action === 'send') {
      if (streaming) onStop?.();
      else if (!busy) onSend();
      return;
    }
    if (!streaming && !busy) runHold();
  };

  const holdRoute = prediction.route === 'hold';
  const sendLabel = streaming ? 'Stop' : holdRoute ? 'Hold' : 'Send';

  return (
    <div ref={wrapRef} className={cn('p-3 pt-1.5', className)}>
      <PromptInput
        value={value}
        onValueChange={onValueChange}
        isLoading={busy}
        maxHeight={176}
        data-landing={landing ? 'true' : undefined}
        className={cn(
          'rounded-2xl bg-[var(--color-control)]/95 shadow-[var(--shadow-pop)] transition-[border-color] duration-[var(--duration-normal)]',
          landing ? 'border-[var(--color-accent-2)]/35' : 'border-[var(--color-control-border)]',
        )}
      >
        {before}
        {landing ? (
          <div className="flex items-start gap-2 px-1 pt-1">
            <RouteChip route="hold" locked className="mt-1.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <HoldLanding
                text={landing.text}
                cards={landing.cards}
                nowMs={now()}
                reduceMotion={reduceMotion}
                railTarget={railTarget}
                onDone={() => {
                  const cards = landing.cards ?? [];
                  setLanding(null);
                  prediction.reset();
                  onHeld?.(cards);
                  focusField();
                }}
              />
            </div>
          </div>
        ) : (
          <PromptInputTextarea
            placeholder={placeholder}
            onKeyDown={onKeyDown}
            className="text-[13px] leading-relaxed text-[var(--color-text)]"
          />
        )}
        {landing ? null : (
          <PromptInputActions className="justify-between pt-1">
            <div className="flex items-center gap-0.5">
              {leading}
              <VoiceCaptureButton voice={voice} disabled={busy} />
            </div>
            <div className="flex items-center gap-2">
              <RouteTabHint visible={!prediction.empty && !prediction.locked} />
              <RouteChip
                route={prediction.route}
                locked={prediction.locked}
                pending={prediction.pending}
                disabled={prediction.empty && !prediction.locked}
                reduceMotion={reduceMotion}
                onFlip={prediction.flip}
              />
              <Button
                type="button"
                size="icon-sm"
                onClick={submit}
                disabled={!streaming && !canSend}
                title={sendLabel}
                className={cn(
                  'rounded-full',
                  holdRoute && !streaming && 'bg-[var(--color-accent-2)] hover:bg-[var(--color-accent-2)]/90',
                )}
                aria-label={sendLabel}
              >
                {streaming ? <Square className="size-3.5 fill-current" /> : <ArrowUp className="size-4" />}
              </Button>
            </div>
          </PromptInputActions>
        )}
      </PromptInput>
      {holdError ? (
        <p role="alert" className="px-2 pt-1.5 text-[11.5px] text-[var(--color-danger)]">
          {holdError}
        </p>
      ) : null}
    </div>
  );
}
