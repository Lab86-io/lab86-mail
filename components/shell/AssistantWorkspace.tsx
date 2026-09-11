'use client';

import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { cn } from '@/lib/utils';
import './assistant-workspace.css';

export type AssistantPresentation = 'corner' | 'split' | 'full';

/** What the frame actually paints. `closed` keeps the chat mounted and inert
 * behind a full-width page; the other three follow the requested
 * presentation unless the phone or a narrow window forces `full`. */
export type AssistantLayout = 'closed' | 'corner' | 'split' | 'full';

export const ASSISTANT_PAGE_MIN_PX = 280;
export const ASSISTANT_CHAT_MIN_PX = 360;
export const ASSISTANT_SEAM_PX = 6;
export const ASSISTANT_DEFAULT_PAGE_SHARE = 50;
/** Below this width a split cannot honor both minimums, so it paints full. */
export const ASSISTANT_SPLIT_MIN_WIDTH_PX = ASSISTANT_PAGE_MIN_PX + ASSISTANT_SEAM_PX + ASSISTANT_CHAT_MIN_PX;
export const ASSISTANT_SHARE_STEP = 2;
export const ASSISTANT_SHARE_STEP_LARGE = 10;
/** Two presses on the seam this close in time and space reset the split. */
export const ASSISTANT_DOUBLE_PRESS_MS = 400;
export const ASSISTANT_DOUBLE_PRESS_SLOP_PX = 6;
export const ASSISTANT_CHAT_LABEL = 'Albatross chat';
const SHARE_STORAGE_KEY = 'lab86-mail-assistant-split';

export function resolveAssistantLayout(state: {
  open: boolean;
  presentation: AssistantPresentation;
  mobile?: boolean;
  width?: number | null;
}): AssistantLayout {
  if (!state.open) return 'closed';
  if (state.mobile) return 'full';
  if (state.presentation === 'split' && state.width != null && state.width < ASSISTANT_SPLIT_MIN_WIDTH_PX) {
    return 'full';
  }
  return state.presentation;
}

/** The page share (percent of the width left after the seam) both panes can
 * live with. An unknown or too-narrow width only clamps to 0..100; the layout
 * resolver has already taken the split away in that case. The stylesheet
 * applies the share to the same usable width, `calc((100% - seam) * share /
 * 100)`, so the clamp here and the tracks there agree to the pixel. */
export function clampPageShare(share: number, width?: number | null): number {
  const safe = Number.isFinite(share) ? share : ASSISTANT_DEFAULT_PAGE_SHARE;
  const usable = width == null ? 0 : width - ASSISTANT_SEAM_PX;
  if (usable < ASSISTANT_PAGE_MIN_PX + ASSISTANT_CHAT_MIN_PX) return Math.min(100, Math.max(0, safe));
  const min = (ASSISTANT_PAGE_MIN_PX / usable) * 100;
  const max = 100 - (ASSISTANT_CHAT_MIN_PX / usable) * 100;
  return Math.min(max, Math.max(min, safe));
}

export function pageShareFromPointer(clientX: number, rect: { left: number; width: number }): number {
  const usable = rect.width - ASSISTANT_SEAM_PX;
  if (usable <= 0) return ASSISTANT_DEFAULT_PAGE_SHARE;
  return clampPageShare(((clientX - rect.left - ASSISTANT_SEAM_PX / 2) / usable) * 100, rect.width);
}

/** Keyboard resize on the seam. Arrows nudge, Shift+arrows stride, Home and
 * End go to the narrowest and widest page, Enter resets. Anything else
 * returns the same share so the caller knows not to react. */
export function stepPageShare(
  share: number,
  key: string,
  options: { width?: number | null; shift?: boolean } = {},
): number {
  const step = options.shift ? ASSISTANT_SHARE_STEP_LARGE : ASSISTANT_SHARE_STEP;
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowUp':
      return clampPageShare(share - step, options.width);
    case 'ArrowRight':
    case 'ArrowDown':
      return clampPageShare(share + step, options.width);
    case 'Home':
      return clampPageShare(0, options.width);
    case 'End':
      return clampPageShare(100, options.width);
    case 'Enter':
      return clampPageShare(ASSISTANT_DEFAULT_PAGE_SHARE, options.width);
    default:
      return share;
  }
}

/** True when this Escape is the frame's to act on: nobody below (a Radix
 * menu, a popover, the composer) already claimed it, and the person is not
 * mid-composition in an IME. */
export function escapeClosesAssistant(event: {
  key: string;
  defaultPrevented: boolean;
  isComposing?: boolean;
}): boolean {
  return event.key === 'Escape' && !event.defaultPrevented && !event.isComposing;
}

/** Where focus should land when the chat closes. Focus is returned only when
 * it was inside the chat (or fell to the body because the chat went inert);
 * a person already working on the page keeps their place. The launcher
 * unmounts in the very commit that opens the chat, so a click on it leaves
 * the body as the recorded opener; the body is never a target, the freshly
 * mounted launcher is. */
export function focusTargetOnClose(state: {
  activeElement: Element | null;
  chat: Element | null;
  opener: Element | null;
  launcher: Element | null;
}): Element | null {
  const active = state.activeElement;
  const focusWasInChat = !active || active === document.body || !!state.chat?.contains(active);
  if (!focusWasInChat) return null;
  const opener = state.opener;
  const openerUsable =
    !!opener &&
    opener.isConnected &&
    opener !== document.body &&
    opener !== document.documentElement &&
    !state.chat?.contains(opener);
  if (openerUsable) return opener;
  return state.launcher ?? null;
}

function readStoredShare(): number {
  if (typeof window === 'undefined') return ASSISTANT_DEFAULT_PAGE_SHARE;
  try {
    const raw = window.localStorage.getItem(SHARE_STORAGE_KEY);
    const parsed = raw == null ? Number.NaN : Number(raw);
    return Number.isFinite(parsed) ? parsed : ASSISTANT_DEFAULT_PAGE_SHARE;
  } catch {
    return ASSISTANT_DEFAULT_PAGE_SHARE;
  }
}

function storeShare(share: number) {
  try {
    window.localStorage.setItem(SHARE_STORAGE_KEY, String(Math.round(share * 10) / 10));
  } catch {
    // Private mode or a full quota: the split just does not persist.
  }
}

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** The frame around a page and the assistant. Both children keep one stable
 * DOM parent each across every open/presentation change, so page filters,
 * scroll, editors and drafts, tool cards and a streaming reply all survive
 * moving the chat from the corner to a split to full and back, or closing it.
 *
 * Behavior this frame owns (the root need not duplicate it):
 * - Escape while focus is inside the chat closes it, unless a child already
 *   handled the key (Radix menus and popovers preventDefault first).
 * - Focus restoration on close: back to the element that had focus before
 *   the chat opened, or to the launcher; never when focus is on the page.
 * - Presentation and resize changes never move focus, except that entering
 *   `full` moves focus out of the page it is about to hide.
 * - The closed chat and the page under `full` are `inert` and aria-hidden.
 * - The split seam: pointer drag and keyboard resize with 280px/360px floors;
 *   a double press or Enter resets the split.
 *
 * The header controls (expand, collapse, corner, close) live in `assistant`. */
export function AssistantWorkspace({
  children,
  assistant,
  open,
  presentation,
  onPresentationChange: _onPresentationChange,
  onClose,
  mobile = false,
  className,
}: {
  children: ReactNode;
  assistant: ReactNode;
  open: boolean;
  presentation: AssistantPresentation;
  onPresentationChange: (presentation: AssistantPresentation) => void;
  onClose: () => void;
  mobile?: boolean;
  className?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const chatRef = useRef<HTMLElement>(null);
  const openerRef = useRef<Element | null>(null);
  const wasOpenRef = useRef(open);
  const [width, setWidth] = useState<number | null>(null);
  const [pageShare, setPageShare] = useState(ASSISTANT_DEFAULT_PAGE_SHARE);
  const [resizing, setResizing] = useState(false);
  const endDragRef = useRef<(() => void) | null>(null);
  const lastPressRef = useRef<{ time: number; x: number } | null>(null);
  const pageId = useId();
  const chatId = useId();
  const layout = resolveAssistantLayout({ open, presentation, mobile, width });
  const pageHidden = layout === 'full';
  const share = clampPageShare(pageShare, width);

  useEffect(() => {
    setPageShare(readStoredShare());
  }, []);

  useEffect(() => {
    const element = rootRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (typeof next === 'number') setWidth(next);
    });
    observer.observe(element);
    setWidth(element.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);

  // Open: remember who opened, then make sure focus is inside the chat so
  // Escape and the composer's own autofocus have somewhere to work from.
  // Close: give focus back without taking it from someone on the page.
  useIsomorphicLayoutEffect(() => {
    if (open === wasOpenRef.current) return;
    wasOpenRef.current = open;
    const chat = chatRef.current;
    if (typeof document === 'undefined' || !chat) return;
    if (open) {
      openerRef.current = document.activeElement;
      if (!chat.contains(document.activeElement)) chat.focus({ preventScroll: true });
      return;
    }
    const target = focusTargetOnClose({
      activeElement: document.activeElement,
      chat,
      opener: openerRef.current,
      launcher: document.querySelector('[data-assistant-launcher]'),
    });
    openerRef.current = null;
    if (target instanceof HTMLElement) target.focus({ preventScroll: true });
  }, [open]);

  // The page is about to go inert; focus must not vanish with it.
  useIsomorphicLayoutEffect(() => {
    if (!pageHidden || typeof document === 'undefined') return;
    const page = pageRef.current;
    const chat = chatRef.current;
    if (page && chat && page.contains(document.activeElement)) chat.focus({ preventScroll: true });
  }, [pageHidden]);

  const onChatKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!escapeClosesAssistant({ ...event, isComposing: event.nativeEvent.isComposing })) return;
    event.preventDefault();
    onClose();
  };

  const commitShare = useCallback((next: number) => {
    setPageShare(next);
    storeShare(next);
  }, []);

  // A drag ends when the seam goes away (the split collapsed to full under
  // it, the chat closed, or the frame unmounted), not only on pointer up;
  // otherwise `resizing` would stay true and both panes would stay
  // pointer-events: none.
  useEffect(() => {
    if (layout !== 'split') endDragRef.current?.();
  }, [layout]);
  useEffect(() => () => endDragRef.current?.(), []);

  const onSeamKeyDown = (event: ReactKeyboardEvent<HTMLHRElement>) => {
    const next = stepPageShare(share, event.key, { width, shift: event.shiftKey });
    if (next === share && event.key !== 'Enter') return;
    event.preventDefault();
    commitShare(next);
  };

  const onSeamPointerDown = (event: ReactPointerEvent<HTMLHRElement>) => {
    if (event.button !== 0) return;
    const root = rootRef.current;
    if (!root) return;
    event.preventDefault();
    endDragRef.current?.();
    // A second press within the double-click window resets the split. It is
    // handled here because preventDefault on pointerdown (needed so the drag
    // never selects text) also stops the browser from synthesising dblclick.
    const last = lastPressRef.current;
    const press = { time: event.timeStamp, x: event.clientX };
    if (
      last &&
      press.time - last.time <= ASSISTANT_DOUBLE_PRESS_MS &&
      Math.abs(press.x - last.x) <= ASSISTANT_DOUBLE_PRESS_SLOP_PX
    ) {
      lastPressRef.current = null;
      commitShare(ASSISTANT_DEFAULT_PAGE_SHARE);
      return;
    }
    lastPressRef.current = press;
    const seam = event.currentTarget;
    const rect = root.getBoundingClientRect();
    let latest = share;
    setResizing(true);
    seam.setPointerCapture?.(event.pointerId);
    const onMove = (move: PointerEvent) => {
      latest = pageShareFromPointer(move.clientX, rect);
      root.style.setProperty('--assistant-page-share', String(latest));
    };
    const finish = () => {
      if (endDragRef.current !== finish) return;
      endDragRef.current = null;
      seam.removeEventListener('pointermove', onMove);
      seam.removeEventListener('pointerup', finish);
      seam.removeEventListener('pointercancel', finish);
      seam.removeEventListener('lostpointercapture', finish);
      // Leave the inline value at what the next render will hold. Removing it
      // instead would drop the frame to the stylesheet default whenever the
      // drag ends on the share it started from, because React does not
      // rewrite a style value it believes is unchanged.
      root.style.setProperty('--assistant-page-share', String(latest));
      setResizing(false);
      commitShare(latest);
    };
    endDragRef.current = finish;
    seam.addEventListener('pointermove', onMove);
    seam.addEventListener('pointerup', finish);
    seam.addEventListener('pointercancel', finish);
    seam.addEventListener('lostpointercapture', finish);
  };

  const chatRole = layout === 'corner' ? 'dialog' : 'region';

  return (
    <div
      ref={rootRef}
      className={cn('assistant-workspace', className)}
      data-assistant-workspace=""
      data-open={open ? 'true' : 'false'}
      data-presentation={presentation}
      data-layout={layout === 'closed' ? 'corner' : layout}
      data-mobile={mobile ? 'true' : 'false'}
      data-resizing={resizing ? 'true' : 'false'}
      style={{ '--assistant-page-share': String(share) } as CSSProperties}
    >
      <div
        ref={pageRef}
        id={pageId}
        className="assistant-workspace__page"
        data-assistant-page=""
        inert={pageHidden}
        aria-hidden={pageHidden || undefined}
      >
        {children}
      </div>

      <div className="assistant-workspace__halo" aria-hidden />

      {layout === 'split' ? (
        <hr
          tabIndex={0}
          aria-orientation="vertical"
          aria-label="Resize page and chat"
          aria-controls={`${pageId} ${chatId}`}
          aria-valuemin={Math.round(clampPageShare(0, width))}
          aria-valuemax={Math.round(clampPageShare(100, width))}
          aria-valuenow={Math.round(share)}
          aria-valuetext={`Page ${Math.round(share)}%, chat ${Math.round(100 - share)}%`}
          title="Drag to resize · arrow keys to nudge · double-click or Enter to reset"
          className="assistant-workspace__seam"
          data-assistant-seam=""
          onKeyDown={onSeamKeyDown}
          onPointerDown={onSeamPointerDown}
        />
      ) : null}

      <section
        ref={chatRef}
        id={chatId}
        role={chatRole}
        aria-label={ASSISTANT_CHAT_LABEL}
        tabIndex={-1}
        inert={!open}
        aria-hidden={!open || undefined}
        data-assistant-chat=""
        data-layout={layout}
        className="assistant-workspace__chat"
        onKeyDown={onChatKeyDown}
      >
        <div className="assistant-workspace__frame">{assistant}</div>
      </section>
    </div>
  );
}
