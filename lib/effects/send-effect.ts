'use client';

import confetti from 'canvas-confetti';

// Side-cannon confetti burst (magicui's "confetti" registry recipe) fired
// when an email actually goes out — i.e. after the undo window elapses or an
// immediate send succeeds, never while a send can still be cancelled.
export function fireSendEffect() {
  if (typeof window === 'undefined') return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const end = Date.now() + 600;
  const colors = ['#34d399', '#60a5fa', '#fbbf24', '#f472b6', '#a78bfa'];
  const frame = () => {
    confetti({
      particleCount: 3,
      angle: 60,
      spread: 55,
      startVelocity: 55,
      origin: { x: 0, y: 0.7 },
      colors,
    });
    confetti({
      particleCount: 3,
      angle: 120,
      spread: 55,
      startVelocity: 55,
      origin: { x: 1, y: 0.7 },
      colors,
    });
    if (Date.now() < end) requestAnimationFrame(frame);
  };
  frame();
}
