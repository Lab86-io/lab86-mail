'use client';

/* Research refs — Mobbin: Superlist "Capture with voice" gradient card + pillowtalk transcribe
 * (calm full-screen wash, borderless input), Meta AI orb + Tolan glowing blob (listening state),
 * Threads glowing compose border + Cosmos blob wash + Jitter full-bleed prompt (takeover tone).
 * Techniques: 9elements fancy-border-radius (8-value blob morph), motion.dev useReducedMotion docs. */

import { useMutation } from 'convex/react';
import { Mic, Sparkles } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { looksLikeMultipleIntents, splitIntentText } from '@/components/albatross/surface-data';
import { Button } from '@/components/ui/button';
import { api } from '@/convex/_generated/api';
import { cn } from '@/lib/utils';

export { looksLikeMultipleIntents, splitIntentText };

/* ------------------------------------------------------------------ */
/* Pure helpers (exported for bun:test - keep them DOM-free)           */
/* ------------------------------------------------------------------ */

/** Rotating button copy. The accessible name stays "New Intent" - this list
 *  only feeds the aria-hidden visible label so screen readers get stability. */
export const CAPTURE_BUTTON_LABELS = [
  'New Intent',
  'New Idea',
  'New Procrastination',
  'Make This Real',
  'Unload Thought',
] as const;

/** Deterministic label for a rotation tick (modulo, negative-safe). */
export function rotatingLabelAt(tick: number): string {
  const length = CAPTURE_BUTTON_LABELS.length;
  return CAPTURE_BUTTON_LABELS[((tick % length) + length) % length];
}

export type CaptureState = 'closed' | 'editing' | 'split' | 'discard' | 'saving' | 'saved';

export type CaptureEvent =
  | { type: 'open' }
  | { type: 'submit'; multi: boolean }
  | { type: 'split' }
  | { type: 'keep' }
  | { type: 'edit' }
  | { type: 'dismiss'; hasText: boolean }
  | { type: 'discard' }
  | { type: 'saved' }
  | { type: 'error' }
  | { type: 'finish' };

/** Capture overlay state machine. Invalid transitions return the current state
 *  unchanged so stray timers/keystrokes can never wedge the overlay. */
export function nextCaptureState(state: CaptureState, event: CaptureEvent): CaptureState {
  switch (event.type) {
    case 'open':
      return state === 'closed' ? 'editing' : state;
    case 'submit':
      return state === 'editing' ? (event.multi ? 'split' : 'saving') : state;
    case 'split':
    case 'keep':
      return state === 'split' ? 'saving' : state;
    case 'edit':
      return state === 'split' || state === 'discard' ? 'editing' : state;
    case 'dismiss':
      // Saving/saved can't be dismissed - the confirmation beat always lands.
      if (state === 'editing' || state === 'split') return event.hasText ? 'discard' : 'closed';
      if (state === 'discard') return 'closed';
      return state;
    case 'discard':
      return state === 'discard' ? 'closed' : state;
    case 'saved':
      return state === 'saving' ? 'saved' : state;
    case 'error':
      return state === 'saving' ? 'editing' : state;
    case 'finish':
      return state === 'saved' ? 'closed' : state;
  }
}

/** Shape the pieces to persist from a raw dump + the user's split decision.
 *  Verbatim contract: only the ends are trimmed, inner text is untouched. */
export function resolveCapturePieces(rawText: string, decision: 'split' | 'keep'): string[] {
  const trimmed = rawText.trim();
  if (!trimmed) return [];
  return decision === 'split' ? splitIntentText(trimmed) : [trimmed];
}

/* ------------------------------------------------------------------ */
/* Voice (SpeechRecognition, same approach as the old capture dialog)  */
/* ------------------------------------------------------------------ */

type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
};
type SpeechResultEvent = { results: ArrayLike<ArrayLike<{ transcript: string }>> };
type SpeechWindow = Window & {
  SpeechRecognition?: new () => SpeechRecognitionLike;
  webkitSpeechRecognition?: new () => SpeechRecognitionLike;
};

const CAPTURE_PROMPT = 'What are you trying to get out of your head?';

/* Organic 8-value border-radius keyframes (9elements technique). First and
 * last match so the loop is seamless. */
const BLOB_RADII = [
  '46% 54% 55% 45% / 52% 46% 54% 48%',
  '56% 44% 42% 58% / 45% 56% 44% 55%',
  '48% 52% 58% 42% / 56% 47% 53% 44%',
  '46% 54% 55% 45% / 52% 46% 54% 48%',
];

const SHEEN =
  'linear-gradient(115deg, var(--color-accent-shine-1), var(--color-accent-shine-2) 40%, var(--color-accent-shine-3) 75%, var(--color-accent-shine-2))';

/* ------------------------------------------------------------------ */
/* Launcher (button + full-screen capture takeover)                    */
/* ------------------------------------------------------------------ */

export function IntentCaptureLauncher({ onCaptured }: { onCaptured: (intentId: string) => void }) {
  const reduceMotion = useReducedMotion() ?? false;
  const createIntent = useMutation(api.albatrossIntents.createIntent);

  const [state, setState] = useState<CaptureState>('closed');
  const [tick, setTick] = useState(0);
  const [text, setText] = useState('');
  const [source, setSource] = useState<'text' | 'voice'>('text');
  const [listening, setListening] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const textRef = useRef(text);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  textRef.current = text;

  const send = useCallback((event: CaptureEvent) => {
    setState((current) => nextCaptureState(current, event));
  }, []);

  const overlayOpen = state !== 'closed';

  // Rotate the button copy every ~6s; hold still under reduced motion.
  useEffect(() => {
    if (reduceMotion || overlayOpen) return;
    const id = window.setInterval(() => setTick((value) => value + 1), 6000);
    return () => window.clearInterval(id);
  }, [reduceMotion, overlayOpen]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const speechWindow = window as SpeechWindow;
    setVoiceSupported(Boolean(speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition));
  }, []);

  // Overlay lifecycle: lock body scroll, wire Escape, focus the textarea on
  // open, reset + return focus to the launcher on close.
  useEffect(() => {
    if (!overlayOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      send({ type: 'dismiss', hasText: textRef.current.trim().length > 0 });
    };
    window.addEventListener('keydown', onKey);
    const focusId = window.setTimeout(() => textareaRef.current?.focus(), 60);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKey);
      window.clearTimeout(focusId);
    };
  }, [overlayOpen, send]);

  useEffect(() => {
    if (overlayOpen) return;
    recognitionRef.current?.abort();
    recognitionRef.current = null;
    setListening(false);
    setText('');
    setSource('text');
    setSaveError(null);
    launcherRef.current?.focus({ preventScroll: true });
  }, [overlayOpen]);

  const stopListening = () => {
    recognitionRef.current?.stop();
    setListening(false);
  };

  const startListening = () => {
    const speechWindow = window as SpeechWindow;
    const Recognition = speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition;
    if (!Recognition) return;
    const recognition = new Recognition();
    recognition.lang = 'en-US';
    recognition.interimResults = true;
    recognition.continuous = false;
    // Anchor to whatever was already typed, then live-replace the spoken tail
    // as interim results grow - updates never duplicate the running transcript.
    const base = textRef.current.trim();
    const joiner = base ? ' ' : '';
    recognition.onresult = (event) => {
      let transcript = '';
      for (let i = 0; i < event.results.length; i += 1) {
        transcript += event.results[i][0]?.transcript ?? '';
      }
      setSource('voice');
      setText(`${base}${joiner}${transcript}`);
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);
    recognitionRef.current = recognition;
    setListening(true);
    recognition.start();
  };

  // Fire-and-forget plan kick. Never awaited before closing; the Plans surface
  // owns planError state if this request fails.
  const kickPlan = (intentId: string) => {
    try {
      void fetch('/api/albatross/plan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          intentId,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      }).catch(() => {});
    } catch {
      /* ignore - plan kick is best-effort */
    }
  };

  const persist = async (pieces: string[], captureSource: 'text' | 'voice') => {
    try {
      const ids: string[] = [];
      for (const piece of pieces) {
        const id = await createIntent({
          rawText: piece,
          transcript: captureSource === 'voice' ? piece : undefined,
          source: captureSource,
        });
        ids.push(id as string);
      }
      for (const id of ids) kickPlan(id);
      if (ids[0]) onCaptured(ids[0]);
      send({ type: 'saved' });
      window.setTimeout(() => send({ type: 'finish' }), 900);
    } catch {
      setSaveError("Couldn't save that. It's still here - try again.");
      send({ type: 'error' });
    }
  };

  const handleSave = () => {
    if (listening) stopListening();
    const trimmed = text.trim();
    if (!trimmed) return;
    setSaveError(null);
    // One intent per capture by default; only ask when the dump clearly splits.
    if (looksLikeMultipleIntents(trimmed)) {
      send({ type: 'submit', multi: true });
      return;
    }
    send({ type: 'submit', multi: false });
    void persist(resolveCapturePieces(trimmed, 'keep'), source);
  };

  const decide = (decision: 'split' | 'keep') => {
    send({ type: decision });
    void persist(resolveCapturePieces(text, decision), source);
  };

  const pieces = state === 'split' ? splitIntentText(text.trim()) : [];

  return (
    <>
      {/* Bottom-center keeps the launcher clear of the bottom-right Ask
          Assistant orb; the fixed-size button keeps the hit target stable
          while the visual inside it breathes and morphs. */}
      <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center">
        <button
          ref={launcherRef}
          type="button"
          onClick={() => send({ type: 'open' })}
          aria-haspopup="dialog"
          aria-label="New Intent"
          className="group pointer-events-auto relative h-12 w-56 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/40 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-bg)]"
        >
          {/* Rotating conic aura - blurred, so a plain circle reads as a glow. */}
          {reduceMotion ? null : (
            <motion.span
              aria-hidden
              className="absolute left-1/2 top-1/2 -ml-32 -mt-32 size-64 rounded-full opacity-35 blur-2xl transition-opacity duration-300 group-hover:opacity-55"
              style={{
                background:
                  'conic-gradient(from 0deg, var(--color-accent-shine-1), var(--color-accent-shine-2), var(--color-accent-shine-3), var(--color-accent-shine-1))',
              }}
              animate={{ rotate: 360 }}
              transition={{ duration: 9, repeat: Number.POSITIVE_INFINITY, ease: 'linear' }}
            />
          )}
          {/* Morphing translucent blob body with an animated gradient sheen. */}
          <span className="absolute inset-0 block transition-transform duration-300 group-hover:scale-[1.05]">
            <motion.span
              aria-hidden
              className="absolute inset-0 overflow-hidden border border-[var(--color-accent)]/45 bg-[var(--color-bg-elevated)]/60 shadow-[var(--shadow-pop)] backdrop-blur-md"
              style={reduceMotion ? { borderRadius: '9999px' } : undefined}
              animate={reduceMotion ? undefined : { borderRadius: BLOB_RADII, scale: [1, 1.025, 1] }}
              transition={{ duration: 9, repeat: Number.POSITIVE_INFINITY, ease: 'easeInOut' }}
            >
              <motion.span
                className="absolute inset-0 opacity-25 transition-opacity duration-300 group-hover:opacity-45"
                style={{ background: SHEEN, backgroundSize: '250% 250%' }}
                animate={reduceMotion ? undefined : { backgroundPosition: ['0% 40%', '100% 60%', '0% 40%'] }}
                transition={{ duration: 6, repeat: Number.POSITIVE_INFINITY, ease: 'linear' }}
              />
            </motion.span>
          </span>
          <span className="relative z-10 flex items-center justify-center gap-2 text-[13.5px] font-medium text-[var(--color-text)]">
            <Sparkles className="size-4 text-[var(--color-accent)] transition-transform duration-300 group-hover:rotate-12 group-hover:scale-110 group-hover:drop-shadow-[0_0_6px_var(--color-accent-shine-2)]" />
            <span aria-hidden className="relative block h-5 overflow-hidden">
              <AnimatePresence mode="wait" initial={false}>
                <motion.span
                  key={reduceMotion ? 'static' : tick}
                  initial={reduceMotion ? false : { opacity: 0, y: 7 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reduceMotion ? undefined : { opacity: 0, y: -7 }}
                  transition={{ duration: 0.35, ease: 'easeOut' }}
                  className="block whitespace-nowrap leading-5"
                >
                  {reduceMotion ? rotatingLabelAt(0) : rotatingLabelAt(tick)}
                </motion.span>
              </AnimatePresence>
            </span>
          </span>
        </button>
      </div>

      <AnimatePresence>
        {overlayOpen ? (
          <motion.div
            key="intent-capture"
            className="fixed inset-0 z-[60]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.22 }}
          >
            {/* Backdrop: app blurred under a soft radial accent wash. */}
            <div
              aria-hidden
              className="absolute inset-0 bg-[var(--color-bg)]/78 backdrop-blur-xl"
              onClick={() => send({ type: 'dismiss', hasText: text.trim().length > 0 })}
            />
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0"
              style={{
                background: 'radial-gradient(58% 46% at 50% 32%, var(--color-accent-soft), transparent 75%)',
              }}
            />
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
              <motion.div
                role="dialog"
                aria-modal="true"
                aria-label="New Intent"
                className="pointer-events-auto w-full max-w-2xl"
                initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 14 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 8 }}
                transition={{ duration: reduceMotion ? 0 : 0.26, ease: 'easeOut' }}
              >
                {state === 'saved' ? (
                  <div className="flex min-h-64 flex-col items-center justify-center gap-5 text-center">
                    {/* The dump tucks away - the opening note of the transformation. */}
                    <motion.p
                      initial={{ opacity: 1, y: 0, scale: 1 }}
                      animate={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -30, scale: 0.93 }}
                      transition={{ duration: 0.55, delay: 0.15, ease: 'easeIn' }}
                      className="max-h-40 max-w-xl overflow-hidden whitespace-pre-wrap text-lg text-[var(--color-text-muted)]"
                    >
                      {text.trim()}
                    </motion.p>
                    <motion.p
                      initial={reduceMotion ? { opacity: 1 } : { opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.35, delay: 0.3 }}
                      className="font-display text-2xl text-[var(--color-text)]"
                    >
                      Got it. Making a plan.
                    </motion.p>
                  </div>
                ) : state === 'discard' ? (
                  <div className="flex flex-col items-center gap-4 text-center">
                    <p className="font-display text-2xl text-[var(--color-text)]">Discard this thought?</p>
                    <p className="max-w-md text-[13px] text-[var(--color-text-muted)]">
                      It hasn't been saved yet.
                    </p>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => send({ type: 'discard' })}
                      >
                        Discard
                      </Button>
                      <Button type="button" size="sm" onClick={() => send({ type: 'edit' })}>
                        Keep writing
                      </Button>
                    </div>
                  </div>
                ) : state === 'split' ? (
                  <div className="flex flex-col gap-4">
                    <p className="font-display text-2xl text-[var(--color-text)]">
                      This looks like {pieces.length} separate things - split them?
                    </p>
                    <ul className="flex flex-col gap-2">
                      {pieces.map((piece, index) => (
                        <li key={piece} className="flex gap-3 text-[14px] text-[var(--color-text)]">
                          <span className="tabular-nums text-[var(--color-text-faint)]">{index + 1}.</span>
                          <span className="min-w-0 flex-1">{piece}</span>
                        </li>
                      ))}
                    </ul>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button type="button" size="sm" onClick={() => decide('split')}>
                        Split into {pieces.length}
                      </Button>
                      <Button type="button" size="sm" variant="outline" onClick={() => decide('keep')}>
                        Keep as one
                      </Button>
                      <Button type="button" size="sm" variant="ghost" onClick={() => send({ type: 'edit' })}>
                        Back to editing
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col gap-6">
                    <h2 className="text-center font-display text-2xl text-[var(--color-text)] sm:text-3xl">
                      {CAPTURE_PROMPT}
                    </h2>
                    {/* Borderless dump field: writing on the wash, not a form. */}
                    <textarea
                      ref={textareaRef}
                      value={text}
                      disabled={state === 'saving'}
                      onChange={(event) => {
                        setText(event.target.value);
                        if (source !== 'text') setSource('text');
                      }}
                      onKeyDown={(event) => {
                        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                          event.preventDefault();
                          handleSave();
                        }
                      }}
                      placeholder="passport, taxes, that idea from the shower..."
                      className="min-h-40 w-full resize-none bg-transparent text-center text-lg leading-relaxed text-[var(--color-text)] caret-[var(--color-accent)] placeholder:text-[var(--color-text-faint)] focus:outline-none sm:text-xl"
                    />
                    <div className="flex items-center justify-center gap-3">
                      {voiceSupported ? (
                        <button
                          type="button"
                          onClick={() => (listening ? stopListening() : startListening())}
                          aria-pressed={listening}
                          aria-label={listening ? 'Stop voice capture' : 'Capture with voice'}
                          className={cn(
                            'inline-flex size-11 items-center justify-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/40',
                            listening
                              ? 'border-[var(--color-accent)]/50 bg-[var(--color-accent-soft)]'
                              : 'border-[var(--color-control-border)] bg-[var(--color-bg-elevated)]/70 text-[var(--color-text-muted)] hover:text-[var(--color-accent)]',
                          )}
                        >
                          {listening ? (
                            /* Pulsing accent blob (Meta AI orb / Tolan), never a red dot. */
                            <motion.span
                              className="size-5 rounded-full"
                              style={{
                                background:
                                  'radial-gradient(circle at 35% 35%, var(--color-accent-shine-2), var(--color-accent-shine-1) 70%, transparent)',
                              }}
                              animate={
                                reduceMotion ? undefined : { scale: [1, 1.3, 1], opacity: [0.75, 1, 0.75] }
                              }
                              transition={{
                                duration: 1.8,
                                repeat: Number.POSITIVE_INFINITY,
                                ease: 'easeInOut',
                              }}
                            />
                          ) : (
                            <Mic className="size-4" />
                          )}
                        </button>
                      ) : null}
                      <Button
                        type="button"
                        onClick={handleSave}
                        disabled={!text.trim() || state === 'saving'}
                        className="rounded-full px-6"
                      >
                        {state === 'saving' ? 'Saving...' : 'Get it out'}
                      </Button>
                    </div>
                    <p className="text-center text-[11.5px] text-[var(--color-text-faint)]">
                      {listening
                        ? 'Listening - just talk, it lands here.'
                        : `${source === 'voice' ? 'Voice' : 'Text'} / Cmd+Enter to save / Esc to close`}
                    </p>
                    {saveError ? (
                      <p className="text-center text-[12.5px] text-[var(--color-danger)]">{saveError}</p>
                    ) : null}
                  </div>
                )}
              </motion.div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}
