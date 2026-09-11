'use client';

import { useEffect, useRef, useState } from 'react';
import { advanceReveal, type RevealProgress, WORD_CADENCE_MS } from '@/lib/chat/reveal';

export interface MeteredText {
  text: string;
  settled: boolean;
}

export function useMeteredText(text: string, active: boolean, reduceMotion = false): MeteredText {
  const [progress, setProgress] = useState<RevealProgress>(() => ({
    cursor: active ? 0 : text.length,
    deadline: null,
    finished: !active,
  }));
  const previous = useRef(text);
  const input = useRef({ text, active });
  input.current = { text, active };
  useEffect(() => {
    if (reduceMotion || !text.startsWith(previous.current)) {
      setProgress({ cursor: reduceMotion || !active ? text.length : 0, deadline: null, finished: !active });
    }
    previous.current = text;
  }, [text, active, reduceMotion]);

  const pending = !reduceMotion && progress.cursor < text.length;
  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(() => {
      const latest = input.current;
      // A word can span transport chunks. Wait for its boundary while live.
      const complete = latest.active ? latest.text.replace(/\S+$/, '') : latest.text;
      setProgress((current) => advanceReveal(complete, current, performance.now(), !latest.active));
    }, WORD_CADENCE_MS);
    return () => window.clearTimeout(timer);
  }, [pending, progress, text.length, active]);

  if (reduceMotion) return { text, settled: !active };
  const shown = Math.min(progress.cursor, text.length);
  return { text: text.slice(0, shown), settled: !active && shown >= text.length };
}
