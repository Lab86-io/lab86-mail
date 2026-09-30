'use client';

import { ArrowUp, Square } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useVoiceCapture, VoiceCaptureButton } from '@/components/albatross/IntentCapture';
import { PromptInput, PromptInputActions } from '@/components/odysseyui/prompt-input';
import { HoldLanding } from '@/components/shell/HoldLanding';
import { RouteChip, RouteTabHint } from '@/components/shell/RouteChip';
import { type RoutePredictionOptions, useRoutePrediction } from '@/components/shell/useRoutePrediction';
import { Button } from '@/components/ui/button';
import {
  HOLD_ERROR,
  HOLD_UNDO_ERROR,
  type HoldCard,
  heldNotice,
  releaseHold,
  restoreHeldText,
} from '@/lib/albatross/capture-client';
import type { BarRoute } from '@/lib/albatross/route-rules';
import { cn } from '@/lib/utils';

// One bar for Ask and Hold. The chip at the right edge says where Enter
// goes. Tab flips it. Cmd+Enter always sends to chat. Enter on Hold turns
// the bar into the parsed Work card, which then moves to the Work rail. A
// line under the bar then says what was held, with Undo and Ask now, so a
// Hold never clears the bar with no word.

export const BAR_PLACEHOLDER = 'Find, draft, schedule, label, anything…';

/** A request from the sidebar door: open the bar with the chip on Hold. */
export interface DoorRequest {
  seed: string | null;
  nonce: number;
}

export type BarKeyAction = 'flip' | 'send' | 'hold' | 'clear' | null;

/** What one key does in the bar. Shift+Tab and Shift+Enter keep their browser meaning. */
export function barKeyAction(
  event: { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; isComposing?: boolean },
  state: { route: BarRoute; empty: boolean },
): BarKeyAction {
  if (event.isComposing) return null;
  if (event.key === 'Tab') {
    if (event.shiftKey || event.metaKey || event.ctrlKey) return null;
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
  /** Undo a Hold: archive the Work it made. Defaults to `releaseHold`. Rejects on failure. */
  onUndoHold?: (cards: HoldCard[]) => Promise<void>;
  /**
   * Send held text to chat after Undo. Resolves false when chat cannot take
   * it; the text then comes back to the bar. Without it, the line offers Undo only.
   */
  onAsk?: (text: string) => Promise<boolean> | boolean;
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

interface Held {
  text: string;
  cards: HoldCard[];
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
  onUndoHold = releaseHold,
  onAsk,
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
  const [held, setHeld] = useState<Held | null>(null);
  const [undoing, setUndoing] = useState(false);

  // New text in the field ends the notice of the last Hold.
  const hasText = value.trim() !== '';
  useEffect(() => {
    if (hasText) setHeld(null);
  }, [hasText]);

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
    setHeld(null);
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

  // Undo archives the held Work. Then the text goes back to the bar on Ask,
  // or straight to chat with "Ask now". The field stays open during Undo, so
  // the text comes back under a newer draft and never replaces it. When chat
  // cannot take the text, it comes back to the bar the same way.
  const undoHold = useCallback(
    (next: 'restore' | 'ask') => {
      if (!held || undoing) return;
      const { text, cards } = held;
      setUndoing(true);
      setHoldError(null);
      onUndoHold(cards)
        .then(
          async () => {
            setHeld(null);
            if (next === 'ask' && onAsk) {
              const accepted = await Promise.resolve()
                .then(() => onAsk(text))
                .catch(() => false);
              if (accepted !== false) return;
            }
            onValueChange(restoreHeldText(valueRef.current, text));
            prediction.preset('ask');
            focusField();
          },
          () => setHoldError(HOLD_UNDO_ERROR),
        )
        .finally(() => setUndoing(false));
    },
    [held, undoing, onUndoHold, onAsk, onValueChange, prediction.preset, focusField],
  );

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
    if (event.nativeEvent.isComposing) return;
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
    event.preventDefault();
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
        placeholder={placeholder}
        onKeyDown={onKeyDown}
        before={before}
        maxHeight={176}
        data-landing={landing ? 'true' : undefined}
        className={landing ? 'border-[var(--color-accent-2)]/35' : undefined}
        field={
          landing ? (
            <div className="flex items-start gap-2 px-2 pt-1">
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
                    if (cards.length) setHeld({ text: landing.text, cards });
                    prediction.reset();
                    onHeld?.(cards);
                    focusField();
                  }}
                />
              </div>
            </div>
          ) : undefined
        }
      >
        {landing ? null : (
          <PromptInputActions className="justify-between pt-1">
            <div className="flex items-center gap-0.5">
              {leading}
              <VoiceCaptureButton voice={voice} disabled={busy} />
            </div>
            <div className="flex items-center gap-2">
              <RouteTabHint visible={!prediction.locked} />
              <RouteChip
                route={prediction.route}
                locked={prediction.locked}
                pending={prediction.pending}
                reduceMotion={reduceMotion}
                onFlip={prediction.flip}
              />
              <Button
                type="button"
                size="icon-sm"
                onClick={submit}
                disabled={!streaming && (busy || !canSend)}
                title={sendLabel}
                className={cn(
                  'rounded-ui',
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
      {held ? (
        <div
          role="status"
          data-held-notice
          className="flex min-w-0 items-baseline gap-2 px-2 pt-1.5 text-[11.5px] text-[var(--color-text-muted)]"
        >
          <span className="min-w-0 flex-1 truncate" title={heldNotice(held.cards, held.text)}>
            {heldNotice(held.cards, held.text)}
          </span>
          <button
            type="button"
            disabled={undoing}
            onClick={() => undoHold('restore')}
            className="shrink-0 font-medium text-[var(--color-accent)] hover:underline disabled:opacity-50"
          >
            Undo
          </button>
          {onAsk ? (
            <button
              type="button"
              disabled={undoing}
              onClick={() => undoHold('ask')}
              className="shrink-0 font-medium text-[var(--color-accent)] hover:underline disabled:opacity-50"
            >
              Ask now
            </button>
          ) : null}
        </div>
      ) : null}
      {holdError ? (
        <p role="alert" className="px-2 pt-1.5 text-[11.5px] text-[var(--color-danger)]">
          {holdError}
        </p>
      ) : null}
    </div>
  );
}
