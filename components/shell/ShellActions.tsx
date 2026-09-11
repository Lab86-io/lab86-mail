'use client';

import { Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CAPTURE_BUTTON_LABEL } from '@/components/albatross/IntentCapture';
import { buttonVariants } from '@/components/ui/button';
import { LetterSwap } from '@/components/ui/letter-swap';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';
import './assistant-workspace.css';

/** The rail's one quiet door: Search. Capture moved into the floating
 * assistant launcher, so the rail no longer stacks a second Hold button.
 * `captureLabel`/`onCapture` stay accepted for callers that still pass them;
 * they render nothing. Navigation state remains owned by the shell. */
export function RailPrimaryActions({
  searchShortcut,
  onSearch,
}: {
  captureLabel?: string;
  searchShortcut: string;
  onCapture?: () => void;
  onSearch: () => void;
}) {
  return (
    <SidebarMenu className="gap-2">
      <SidebarMenuItem>
        <SidebarMenuButton
          tooltip={`Search everything (${searchShortcut} or /)`}
          aria-label={`Search everything (${searchShortcut} or slash)`}
          aria-keyshortcuts="Meta+F Control+F /"
          title={`Search everything (${searchShortcut} or /)`}
          onClick={onSearch}
          className={cn(
            buttonVariants({ variant: 'outline' }),
            'h-10 justify-start gap-2 px-2.5 text-[12.5px]',
          )}
        >
          <Search className="size-4 shrink-0 text-[var(--color-text-muted)]" aria-hidden />
          <span>Search</span>
          <span className="ml-auto group-data-[collapsible=icon]:hidden" aria-hidden>
            <kbd className="control-key">{searchShortcut}</kbd>
          </span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

/** The launcher's accessible name never changes, whatever phrase is showing. */
export const ASSISTANT_LAUNCHER_NAME = 'Ask Albatross or get this off my mind';

/** Idle phrases. Each is an invitation about the next action, never a claim
 * about the person's state of mind or what is in their inbox. The first is
 * the capture vocabulary the rest of the product uses. */
export const ASSISTANT_LAUNCHER_PHRASES: readonly string[] = [
  CAPTURE_BUTTON_LABEL,
  'One thing at a time',
  'Where do we start?',
  'Ask, or hold a thought',
];

export const ASSISTANT_LAUNCHER_ROTATE_MS = 7000;

/** The next phrase index: advances only when the launcher is genuinely idle
 * (not hovered, not focused, window visible, motion allowed). */
export function nextLauncherPhrase(
  index: number,
  state: { idle: boolean; reduceMotion: boolean; count?: number },
): number {
  const count = state.count ?? ASSISTANT_LAUNCHER_PHRASES.length;
  if (count <= 1 || !state.idle || state.reduceMotion) return index;
  return (index + 1) % count;
}

function subscribeReducedMotion(onChange: () => void) {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const query = window.matchMedia('(prefers-reduced-motion: reduce)');
  query.addEventListener?.('change', onChange);
  return () => query.removeEventListener?.('change', onChange);
}

function readReducedMotion() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function usePrefersReducedMotion() {
  // Server and first client paint agree on "no preference"; the real value
  // lands in an effect so hydration never mismatches.
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    const sync = () => setReduce(readReducedMotion());
    sync();
    return subscribeReducedMotion(sync);
  }, []);
  return reduce;
}

function useDocumentVisible() {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const sync = () => setVisible(document.visibilityState !== 'hidden');
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, []);
  return visible;
}

/** One floating door for both Ask and Hold. `onOpen` semantics are unchanged:
 * the shell decides what the panel shows. `context` is an optional visible
 * eyebrow (e.g. the attached Area) and never changes the accessible name.
 * `rotateMs` exists for previews and tests. */
export function AssistantLauncher({
  placement,
  shortcut,
  onOpen,
  context,
  phrases = ASSISTANT_LAUNCHER_PHRASES,
  rotateMs = ASSISTANT_LAUNCHER_ROTATE_MS,
}: {
  placement: 'stacked' | 'corner';
  shortcut: string;
  onOpen: (phrase: string) => void;
  context?: string;
  phrases?: readonly string[];
  rotateMs?: number;
}) {
  const reduceMotion = usePrefersReducedMotion();
  const documentVisible = useDocumentVisible();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [phraseIndex, setPhraseIndex] = useState(0);
  const idle = documentVisible && !hovered && !focused;
  const rotating = idle && !reduceMotion && phrases.length > 1;

  // A new page starts with its primary invitation without remounting the focused button.
  // biome-ignore lint/correctness/useExhaustiveDependencies: phrase identity intentionally resets the rotation.
  useEffect(() => setPhraseIndex(0), [phrases]);

  useEffect(() => {
    if (!rotating) return;
    const timer = window.setInterval(
      () => {
        setPhraseIndex((index) =>
          nextLauncherPhrase(index, { idle: true, reduceMotion: false, count: phrases.length }),
        );
      },
      Math.max(250, rotateMs),
    );
    return () => window.clearInterval(timer);
  }, [rotating, rotateMs, phrases.length]);

  return (
    <button
      type="button"
      onClick={() => onOpen(phrases[phraseIndex % phrases.length])}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      title={`${ASSISTANT_LAUNCHER_NAME} (${shortcut})`}
      aria-label={ASSISTANT_LAUNCHER_NAME}
      aria-keyshortcuts="Meta+K Control+K"
      data-assistant-launcher=""
      data-placement={placement}
      data-rotating={rotating ? 'true' : 'false'}
      data-phrase={phraseIndex}
      className="assistant-launcher"
    >
      <span className="assistant-launcher__copy" aria-hidden>
        <span className="assistant-launcher__eyebrow">{context || 'Ask Albatross'}</span>
        <LetterSwap phrases={phrases} index={phraseIndex % phrases.length} reduceMotion={reduceMotion} />
      </span>
      <kbd className="control-key assistant-launcher__key" aria-hidden>
        {shortcut}
      </kbd>
    </button>
  );
}
