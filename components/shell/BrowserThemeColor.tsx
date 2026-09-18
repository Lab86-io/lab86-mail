'use client';

import { useEffect } from 'react';

/** Keep browser chrome on the same resolved color as the navigation rail/frame. */
export function watchBrowserThemeColor(doc: Document = document) {
  const win = doc.defaultView;
  if (!win) return () => {};
  const probe = doc.createElement('span');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText =
    'position:fixed;pointer-events:none;visibility:hidden;width:1px;height:1px;background-color:var(--color-workspace-frame)';
  doc.body.append(probe);
  const canvas = doc.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const meta = doc.createElement('meta');
  meta.name = 'theme-color';
  meta.dataset.appThemeColor = '';
  let frame = 0;

  function sync() {
    frame = 0;
    let color = win!.getComputedStyle(probe).backgroundColor;
    if (!color || color === 'rgba(0, 0, 0, 0)') return;
    // The palette uses OKLCH/color-mix. Serialize opaque sRGB for browsers
    // whose chrome accepts hex but not the full CSS Color 4 syntax.
    if (context) {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
      color = `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
    }
    if (meta.content !== color) meta.content = color;
    // First matching theme-color wins. A media-free live value also follows
    // an explicit app theme that differs from the operating system's theme.
    // Keep server media-query values as pre-hydration fallbacks.
    if (doc.head.querySelector('meta[name="theme-color"]') !== meta) doc.head.prepend(meta);
  }
  function schedule() {
    if (!frame) frame = win!.requestAnimationFrame(sync);
  }
  const observer = new win.MutationObserver(schedule);
  observer.observe(doc.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
  // Next can replace head metadata during navigation. Restore our live value
  // first without observing our own content updates.
  observer.observe(doc.head, { childList: true });
  sync();
  return () => {
    observer.disconnect();
    if (frame) win.cancelAnimationFrame(frame);
    meta.remove();
    probe.remove();
  };
}

export function BrowserThemeColor() {
  useEffect(() => watchBrowserThemeColor(), []);
  return null;
}
