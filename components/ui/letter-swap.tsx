'use client';

import { AnimatePresence, motion, useIsPresent } from 'motion/react';

function AnimatedPhrase({ phrase }: { phrase: string }) {
  const present = useIsPresent();
  return (
    <motion.span
      className="assistant-launcher__phrase"
      data-active={present ? 'true' : 'false'}
      initial="enter"
      animate="settled"
      exit="exit"
    >
      {Array.from(phrase).map((letter, position) => (
        <motion.span
          key={position}
          data-letter
          className="inline-block whitespace-pre"
          variants={{
            enter: { y: '85%', opacity: 0, rotateX: -35 },
            settled: { y: 0, opacity: 1, rotateX: 0 },
            exit: { y: '-85%', opacity: 0, rotateX: 35 },
          }}
          transition={{ duration: 0.34, ease: [0.22, 1, 0.36, 1], delay: position * 0.012 }}
        >
          {letter}
        </motion.span>
      ))}
    </motion.span>
  );
}

/** A quiet letter roll informed by Chamaac's Text Loop and Dancing Letters.
 * The caller owns the idle timer. A fixed measuring grid keeps all phrases
 * the same width; only the visible line transitions inside that footprint. */
export function LetterSwap({
  phrases,
  index,
  reduceMotion,
}: {
  phrases: readonly string[];
  index: number;
  reduceMotion: boolean;
}) {
  const phrase = phrases[index] || '';
  return (
    <span className="assistant-launcher__phrases" aria-hidden>
      {phrases.map((text) => (
        <span key={text} className="assistant-launcher__measure">
          {text}
        </span>
      ))}
      {reduceMotion ? (
        <span className="assistant-launcher__phrase" data-active="true">
          {phrase}
        </span>
      ) : (
        <AnimatePresence initial={false} mode="sync">
          <AnimatedPhrase key={phrase} phrase={phrase} />
        </AnimatePresence>
      )}
    </span>
  );
}
