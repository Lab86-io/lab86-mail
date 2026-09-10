'use client';

import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';

export const DOCUMENT_PANEL_MIN_WIDTH = 900;

export function useNarrowDocumentWorkspace() {
  const [element, ref] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!element) return;
    const update = () => setWidth(element.getBoundingClientRect().width);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  // The Files pane may be narrow inside a wide desktop chat split. Window
  // breakpoints cannot determine whether a second 320px panel fits here.
  return { ref, narrow: width === null || width < DOCUMENT_PANEL_MIN_WIDTH, measured: width !== null };
}

/** Panels stay nonmodal; the covered canvas is inert on narrow screens. */
export function useDocumentPanel(onClose: () => void) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const trigger = document.activeElement;
    const panel = ref.current;
    const workspace = panel?.closest('[data-document-workspace]');
    if (!panel || !workspace || workspace.getBoundingClientRect().width >= DOCUMENT_PANEL_MIN_WIDTH) return;
    const frame = requestAnimationFrame(() => {
      panel.querySelector<HTMLElement>('button:not([disabled]), textarea:not([disabled])')?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      if (
        trigger instanceof HTMLElement &&
        trigger.isConnected &&
        (panel.contains(document.activeElement) || document.activeElement === document.body)
      )
        trigger.focus();
    };
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };
  return { ref, onKeyDown };
}
