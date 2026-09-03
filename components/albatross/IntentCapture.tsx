'use client';

import { Mic } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { looksLikeMultipleIntents, splitIntentText } from '@/components/albatross/surface-data';
import { cn } from '@/lib/utils';

export { looksLikeMultipleIntents, splitIntentText };

// The full-screen capture takeover is retired. The Ask / Hold bar is the one
// door: the rail button opens the bar with the chip preset to Hold. What
// survives here is the name of that door and the voice capture the bar reuses.

/** The one name for the one door into the product. */
export const CAPTURE_BUTTON_LABEL = 'Get this off my mind';

/* ------------------------------------------------------------------ */
/* Voice (SpeechRecognition)                                           */
/* ------------------------------------------------------------------ */

export type SpeechRecognitionLike = {
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
export type SpeechResultEvent = { results: ArrayLike<ArrayLike<{ transcript: string }>> };
type SpeechWindow = Window & {
  SpeechRecognition?: new () => SpeechRecognitionLike;
  webkitSpeechRecognition?: new () => SpeechRecognitionLike;
};

/** The running transcript of one recognition event. */
export function transcriptOf(event: SpeechResultEvent): string {
  let transcript = '';
  for (let i = 0; i < event.results.length; i += 1) {
    transcript += event.results[i][0]?.transcript ?? '';
  }
  return transcript;
}

/** The typed text with the spoken tail after it. The tail replaces itself as it grows. */
export function appendTranscript(base: string, transcript: string): string {
  const anchor = base.trim();
  if (!anchor) return transcript;
  return `${anchor} ${transcript}`;
}

export function speechRecognitionAvailable(win: unknown): boolean {
  const speechWindow = win as SpeechWindow | undefined;
  return Boolean(speechWindow?.SpeechRecognition || speechWindow?.webkitSpeechRecognition);
}

export interface VoiceCapture {
  supported: boolean;
  listening: boolean;
  start: () => void;
  stop: () => void;
}

/**
 * Voice into a text field. `read()` gives the text at the moment the user
 * starts to talk; `write(text)` receives the text with the spoken tail. The
 * recognition stops on its own at the end of a phrase.
 */
export function useVoiceCapture(read: () => string, write: (text: string) => void): VoiceCapture {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const readRef = useRef(read);
  readRef.current = read;
  const writeRef = useRef(write);
  writeRef.current = write;

  useEffect(() => {
    if (typeof window === 'undefined') return;
    setSupported(speechRecognitionAvailable(window));
  }, []);

  useEffect(
    () => () => {
      recognitionRef.current?.abort();
      recognitionRef.current = null;
    },
    [],
  );

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
    setListening(false);
  }, []);

  const start = useCallback(() => {
    if (typeof window === 'undefined') return;
    const speechWindow = window as SpeechWindow;
    const Recognition = speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition;
    if (!Recognition) return;
    const recognition = new Recognition();
    recognition.lang = 'en-US';
    recognition.interimResults = true;
    recognition.continuous = false;
    const base = readRef.current();
    recognition.onresult = (event) => writeRef.current(appendTranscript(base, transcriptOf(event)));
    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);
    recognitionRef.current = recognition;
    setListening(true);
    recognition.start();
  }, []);

  return { supported, listening, start, stop };
}

/** The microphone toggle. Renders nothing when the browser has no speech recognition. */
export function VoiceCaptureButton({
  voice,
  disabled = false,
  className,
}: {
  voice: VoiceCapture;
  disabled?: boolean;
  className?: string;
}) {
  if (!voice.supported) return null;
  return (
    <button
      type="button"
      onClick={() => (voice.listening ? voice.stop() : voice.start())}
      disabled={disabled}
      aria-pressed={voice.listening}
      aria-label={voice.listening ? 'Stop voice capture' : 'Capture with voice'}
      title={voice.listening ? 'Stop voice capture' : 'Capture with voice'}
      className={cn(
        'inline-flex size-7 items-center justify-center rounded-md transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/40 disabled:opacity-40',
        voice.listening
          ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
          : 'text-[var(--color-text-faint)] hover:text-[var(--color-text)]',
        className,
      )}
    >
      {voice.listening ? (
        <span
          aria-hidden
          className="size-3.5 animate-pulse rounded-full motion-reduce:animate-none"
          style={{
            background:
              'radial-gradient(circle at 35% 35%, var(--color-accent-shine-2), var(--color-accent-shine-1) 70%, transparent)',
          }}
        />
      ) : (
        <Mic className="size-3.5" />
      )}
    </button>
  );
}
