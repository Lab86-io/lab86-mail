'use client';

/* Shared Document Picture-in-Picture window (Chromium: Chrome, Dia, Arc).
 * One always-on-top browser window owned by the app: capture opens it by
 * default (inside the click gesture, as the API requires) and IntentPip
 * portals the live planning card into it — there is no in-app fallback.
 * Theme is mirrored continuously — next-themes drives dark mode via a
 * class on :root, which a bare pip document would never receive. */

interface DocumentPictureInPicture {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
  window: Window | null;
}

function host(): DocumentPictureInPicture | null {
  if (typeof window === 'undefined') return null;
  return (
    (window as Window & { documentPictureInPicture?: DocumentPictureInPicture }).documentPictureInPicture ??
    null
  );
}

let pipWindow: Window | null = null;
let themeObserver: MutationObserver | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export function pipSupported(): boolean {
  return host() !== null;
}

export function getPipWindow(): Window | null {
  return pipWindow;
}

export function subscribePipWindow(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Mirror the app's theme onto the pip document: stylesheets once, then the
 *  root class/style (next-themes 'dark' class, OKLCH accent inline vars) kept
 *  in sync for as long as the window lives. */
function adoptTheme(target: Window) {
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const rules = Array.from(sheet.cssRules ?? [])
        .map((rule) => rule.cssText)
        .join('\n');
      const style = target.document.createElement('style');
      style.textContent = rules;
      target.document.head.appendChild(style);
    } catch {
      const owner = sheet.ownerNode as HTMLLinkElement | null;
      if (owner?.href) {
        const link = target.document.createElement('link');
        link.rel = 'stylesheet';
        link.href = owner.href;
        target.document.head.appendChild(link);
      }
    }
  }

  const syncRoot = () => {
    const source = document.documentElement;
    const dest = target.document.documentElement;
    dest.className = source.className;
    dest.setAttribute('style', source.getAttribute('style') ?? '');
    const scheme = source.style.colorScheme || getComputedStyle(source).colorScheme;
    if (scheme) dest.style.colorScheme = scheme;
  };
  syncRoot();
  themeObserver?.disconnect();
  themeObserver = new MutationObserver(syncRoot);
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'style'],
  });

  target.document.title = 'Albatross';
  target.document.body.style.margin = '0';
  target.document.body.style.background = 'var(--color-bg)';
}

/** Must be called within a user gesture (click). Resolves the existing window
 *  when one is already open; null when unsupported or denied. */
export async function openPipWindow(): Promise<Window | null> {
  const api = host();
  if (!api) return null;
  if (pipWindow && !pipWindow.closed) return pipWindow;
  try {
    // Sized to the compact planning card; the browser lets the user drag it
    // larger when a question needs more room. Resizing programmatically on
    // mode change is not possible (requires a user gesture inside the pip).
    const win = await api.requestWindow({ width: 360, height: 150 });
    adoptTheme(win);
    win.addEventListener(
      'pagehide',
      () => {
        if (pipWindow === win) {
          pipWindow = null;
          themeObserver?.disconnect();
          themeObserver = null;
          notify();
        }
      },
      { once: true },
    );
    pipWindow = win;
    notify();
    return win;
  } catch {
    return null;
  }
}

export function closePipWindow() {
  pipWindow?.close();
  pipWindow = null;
  themeObserver?.disconnect();
  themeObserver = null;
  notify();
}
