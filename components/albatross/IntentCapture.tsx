'use client';

/* Research refs — Mobbin: Superlist "Capture with voice" gradient card + pillowtalk transcribe
 * (calm full-screen wash, borderless input), Meta AI orb + Tolan glowing blob (listening state),
 * Threads glowing compose border + Cosmos blob wash + Jitter full-bleed prompt (takeover tone).
 * Built from fully-designed registry pieces: SmoothUI Dot Morph Button (squish spring 600/22)
 * + SmoothUI Siri Orb as the "dot", @victorwelander's 21st.dev Gooey Text Morphing for the
 * cycling label, and Chamaac UI DancingLetters for the
 * capture takeover. Buttons stay text-only — no decorative icons. */

import { useMutation } from 'convex/react';
import { Mic } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState } from 'react';
import { GooeyMorphText } from '@/components/albatross/GooeyMorphText';
import { looksLikeMultipleIntents, splitIntentText } from '@/components/albatross/surface-data';
import SiriOrb from '@/components/smoothui/siri-orb';
import { Button } from '@/components/ui/button';
import { DotGridGlow } from '@/components/ui/dot-grid-glow';
import { api } from '@/convex/_generated/api';
import { openPipWindow, pipSupported } from '@/lib/albatross/pip-window';
import { cn } from '@/lib/utils';

export { looksLikeMultipleIntents, splitIntentText };

// Lazy Chamaac piece: DancingLetters pulls in
// next/font, so neither may sit on the button's initial bundle path. They only
// download the first time the takeover opens.
const DancingLetters = dynamic(() => import('@/components/dancing-letters'), { ssr: false });

/* ------------------------------------------------------------------ */
/* Pure helpers (exported for bun:test - keep them DOM-free)           */
/* ------------------------------------------------------------------ */

/** Rotating button copy. The accessible name stays "New Intent" - this list
 *  only feeds the aria-hidden gooey label so screen readers get stability. */
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

type CaptureGeo = { latitude: number; longitude: number };

/** Best-effort location for the plan kick. Resolves null on denial, error, or
 *  after timeoutMs - it never rejects and never blocks the close beat. */
function resolveGeo(timeoutMs = 2500): Promise<CaptureGeo | null> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (value: CaptureGeo | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = window.setTimeout(() => finish(null), timeoutMs);
    try {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          window.clearTimeout(timer);
          finish({ latitude: position.coords.latitude, longitude: position.coords.longitude });
        },
        () => {
          window.clearTimeout(timer);
          finish(null);
        },
        { timeout: timeoutMs, maximumAge: 600_000 },
      );
    } catch {
      window.clearTimeout(timer);
      finish(null);
    }
  });
}

/* ------------------------------------------------------------------ */
/* Launcher (button + full-screen capture takeover)                    */
/* ------------------------------------------------------------------ */

export function IntentCaptureLauncher({ onCaptured }: { onCaptured: (intentId: string) => void }) {
  const reduceMotion = useReducedMotion() ?? false;
  const createIntent = useMutation(api.albatrossIntents.createIntent);

  const [state, setState] = useState<CaptureState>('closed');
  const [text, setText] = useState('');
  const [source, setSource] = useState<'text' | 'voice'>('text');
  const [listening, setListening] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [hovered, setHovered] = useState(false);
  const [hoverDevice, setHoverDevice] = useState(false);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const textRef = useRef(text);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  textRef.current = text;

  const send = useCallback((event: CaptureEvent) => {
    setState((current) => nextCaptureState(current, event));
  }, []);

  const overlayOpen = state !== 'closed';

  // Dot-morph squish only makes sense on hover-capable pointers (SmoothUI).
  useEffect(() => {
    const query = window.matchMedia('(hover: hover) and (pointer: fine)');
    setHoverDevice(query.matches);
    const onChange = (event: MediaQueryListEvent) => setHoverDevice(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

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
  const kickPlan = (intentId: string, geo: CaptureGeo | null) => {
    try {
      void fetch('/api/albatross/plan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          intentId,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          ...(geo ? { geo } : {}),
        }),
      }).catch(() => {});
    } catch {
      /* ignore - plan kick is best-effort */
    }
  };

  const persist = async (pieces: string[], captureSource: 'text' | 'voice') => {
    // Start the (bounded, silent) geo lookup in parallel with the save so it
    // usually resolves before the kicks fire.
    const geoPromise = resolveGeo();
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
      if (ids[0]) onCaptured(ids[0]);
      send({ type: 'saved' });
      window.setTimeout(() => send({ type: 'finish' }), 900);
      // Kicks wait for geo (max 2.5s) but the close beat above never does.
      void geoPromise.then((geo) => {
        for (const id of ids) kickPlan(id, geo);
      });
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
    // Default to the real browser PiP: must be requested inside this click's
    // transient activation, before any awaits. Planning then follows the user
    // into other tabs (Dia/Chrome); unsupported browsers keep the in-app dock.
    if (pipSupported()) void openPipWindow();
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
  const squished = hovered && hoverDevice && !reduceMotion;

  return (
    <>
      {/* Bottom-right, where Ask Assistant used to live (that pill hides when
          Albatross is on; the assistant stays on Cmd+K). Ghost until hovered:
          transparent pill that fills with the accent on hover/focus. The orb
          is a still gradient pearl — its rotation is paused by request. */}
      <div className="pointer-events-none fixed bottom-6 right-6 z-50">
        <button
          ref={launcherRef}
          type="button"
          onClick={() => send({ type: 'open' })}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          aria-haspopup="dialog"
          aria-label="New Intent"
          className="group pointer-events-auto flex h-10 cursor-pointer items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-bg-elevated)]/90 pr-4 pl-2.5 text-[var(--color-text)] shadow-[var(--shadow-soft)] backdrop-blur-sm transition-colors duration-150 ease-out hover:border-[var(--color-accent)] hover:bg-[var(--color-accent)] hover:text-[var(--color-accent-foreground)] hover:shadow-[var(--shadow-pop)] focus-visible:border-[var(--color-accent)] focus-visible:bg-[var(--color-accent)] focus-visible:text-[var(--color-accent-foreground)] focus-visible:outline-none active:scale-[0.97]"
        >
          <motion.span
            aria-hidden
            className="flex shrink-0 items-center justify-center [&_.siri-orb::before]:[animation-play-state:paused]"
            initial={false}
            animate={squished ? { scaleX: 0.68, scaleY: 1.32 } : { scaleX: 1, scaleY: 1 }}
            transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 600, damping: 22 }}
          >
            {/* Orb colors derive from the live accent (relative OKLCH) so any
                theme keeps it coherent; bg transparent so it sits on both the
                ghost and the hovered accent fill. */}
            <SiriOrb
              size="18px"
              animationDuration={26}
              colors={{
                bg: 'transparent',
                c1: 'oklch(from var(--color-accent) calc(l + 0.25) calc(c * 0.6) h)',
                c2: 'oklch(from var(--color-accent) calc(l + 0.12) c calc(h + 50))',
                c3: 'oklch(from var(--color-accent) calc(l + 0.12) c calc(h - 50))',
              }}
            />
          </motion.span>
          <GooeyMorphText
            texts={CAPTURE_BUTTON_LABELS}
            morphTime={1.2}
            cooldownTime={4}
            className="text-[13px] leading-5 font-medium"
          />
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
            {/* Backdrop: the app's own paper + dot grid, near-opaque so the
                dump text sits on a clean page (no shader washes — they read
                gray and die with the WebGL context). */}
            <div
              aria-hidden
              className="absolute inset-0 overflow-hidden bg-[var(--color-bg)]/97"
              onClick={() => send({ type: 'dismiss', hasText: text.trim().length > 0 })}
            >
              <DotGridGlow />
            </div>
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
                    {/* Chamaac DancingLetters heading, split per word so lines
                        wrap on word boundaries. aria-label keeps the prompt
                        readable as one sentence for screen readers. */}
                    <h2 aria-label={CAPTURE_PROMPT} className="text-center">
                      {reduceMotion ? (
                        <span className="font-display text-2xl text-[var(--color-text)] sm:text-3xl">
                          {CAPTURE_PROMPT}
                        </span>
                      ) : (
                        <span
                          aria-hidden
                          className="flex flex-wrap items-baseline justify-center gap-x-[0.3em] gap-y-1"
                        >
                          {CAPTURE_PROMPT.split(' ').map((word, index) => (
                            <DancingLetters
                              // biome-ignore lint/suspicious/noArrayIndexKey: static prompt, order never changes
                              key={`${word}-${index}`}
                              text={word}
                              letterClassName="font-display font-medium text-2xl sm:text-3xl md:text-3xl lg:text-3xl text-[var(--color-text)] dark:text-[var(--color-text)]"
                            />
                          ))}
                        </span>
                      )}
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
