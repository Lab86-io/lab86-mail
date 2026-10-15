'use client';

// A saved PDF in document mode (docs/research/goal-runs-web-design-2026-10-15.md,
// §5.4): the pages drawn with pdfjs-dist at the pane width, one canvas each.
// The header names the file, the page in view, and the size, with "Open in
// Files" and "Download". A sealed field (the tax ID of a W-9) is marked on
// the page with "Fills in when you send". Download of a sealed file runs the
// identity check first: the thread passes a `loadFile` that goes through
// Clerk's reverification (use-saved-file.ts); the harness passes none.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { formatFileSize, GOAL_RUN_COPY } from '@/lib/albatross/goal-run-view';
import { cn } from '@/lib/utils';

export interface PdfPaneProps {
  /** The inline bytes of the saved file (`savedFilePreviewUrl`). */
  url: string;
  /** The bytes for Download (`savedFileDownloadUrl`). */
  downloadUrl: string;
  title: string;
  /** The names of the fields that fill in at send time (the saved file's sealed fill list). */
  sealedFields?: readonly string[];
  /** The Files link of the file, from the server. */
  openPath?: string | null;
  /** Loads the bytes. The thread's loader runs the identity check on a 403 `verify_identity`. */
  loadFile?: (url: string) => Promise<ArrayBuffer>;
  onOpenInFiles?: (path: string) => void;
  className?: string;
}

interface PageView {
  index: number;
  width: number;
  height: number;
  /** Sealed and signature fields on this page, in CSS pixels of the page box. */
  marks: Array<{ name: string; label: string; left: number; top: number; width: number; height: number }>;
}

export class SavedFileError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** The body of a 403 that asks for the identity check (Clerk's reverification shape plus the files builder's code). */
export interface IdentityCheckBody {
  clerk_error?: { type?: string; reason?: string; metadata?: unknown };
  code?: string;
  error?: string;
}

export function isIdentityCheckBody(body: unknown): body is IdentityCheckBody {
  if (!body || typeof body !== 'object') return false;
  const value = body as IdentityCheckBody;
  return (
    value.code === 'verify_identity' ||
    (value.clerk_error?.type === 'forbidden' && value.clerk_error?.reason === 'reverification-error')
  );
}

/**
 * The bytes of a saved file, or the identity-check body of a 403. The body
 * comes back as a value, not an error, so Clerk's `useReverification` can
 * see it, run the check, and call again (use-saved-file.ts).
 */
export async function fetchSavedFileOrCheck(
  url: string,
): Promise<{ bytes: ArrayBuffer } | IdentityCheckBody> {
  const response = await fetch(url, { credentials: 'same-origin' });
  if (response.ok) return { bytes: await response.arrayBuffer() };
  const body = await response.json().catch(() => null);
  if (response.status === 403 && isIdentityCheckBody(body)) return body;
  throw new SavedFileError(
    String(body?.error || GOAL_RUN_COPY.pdfFailed),
    response.status,
    typeof body?.code === 'string' ? body.code : undefined,
  );
}

/** The plain loader: the bytes, or an error. A 403 for the identity check is an error here. */
export async function fetchSavedFile(url: string): Promise<ArrayBuffer> {
  const result = await fetchSavedFileOrCheck(url);
  if ('bytes' in result) return result.bytes;
  throw new SavedFileError(GOAL_RUN_COPY.pdfNotDownloaded, 403, 'verify_identity');
}

/** True for a widget whose field name is in the sealed list. Field names compare without case. */
export function isSealedField(fieldName: string | null | undefined, sealed: readonly string[]): boolean {
  const name = String(fieldName || '')
    .trim()
    .toLowerCase();
  return Boolean(name) && sealed.some((entry) => entry.trim().toLowerCase() === name);
}

async function loadPdfjs() {
  const pdfjs = await import('pdfjs-dist');
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      'pdfjs-dist/build/pdf.worker.min.mjs',
      import.meta.url,
    ).toString();
  }
  return pdfjs;
}

export function PdfPane({
  url,
  downloadUrl,
  title,
  sealedFields = [],
  openPath,
  loadFile,
  onOpenInFiles,
  className,
}: PdfPaneProps) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState<number | null>(null);
  const [pages, setPages] = useState<PageView[]>([]);
  const [current, setCurrent] = useState(1);
  const [downloadNote, setDownloadNote] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const canvases = useRef(new Map<number, HTMLCanvasElement>());
  const docRef = useRef<{ numPages: number; getPage: (n: number) => Promise<unknown> } | null>(null);
  const widthRef = useRef(0);
  const sealed = useMemo(() => [...sealedFields], [sealedFields]);

  const load = useCallback(
    (target: string) => (loadFile ? loadFile(target) : fetchSavedFile(target)),
    [loadFile],
  );

  // Load the file and lay out the pages at the pane width.
  useEffect(() => {
    let alive = true;
    setStatus('loading');
    setError(null);
    setPages([]);
    canvases.current.clear();
    (async () => {
      const bytes = await load(url);
      if (!alive) return;
      setSize(bytes.byteLength);
      const pdfjs = await loadPdfjs();
      const doc = await pdfjs.getDocument({ data: bytes }).promise;
      if (!alive) return;
      docRef.current = doc as unknown as typeof docRef.current;
      const width = Math.max(320, (scrollRef.current?.clientWidth ?? 640) - 40);
      widthRef.current = width;
      const views: PageView[] = [];
      for (let index = 1; index <= doc.numPages; index += 1) {
        const page = await doc.getPage(index);
        const base = page.getViewport({ scale: 1 });
        const scale = width / base.width;
        const viewport = page.getViewport({ scale });
        const marks: PageView['marks'] = [];
        const annotations = (await page.getAnnotations()) as Array<{
          subtype?: string;
          fieldName?: string;
          fieldType?: string;
          rect?: number[];
        }>;
        for (const annotation of annotations) {
          if (annotation.subtype !== 'Widget' || !annotation.rect) continue;
          const sealedField = isSealedField(annotation.fieldName, sealed);
          const signature = annotation.fieldType === 'Sig';
          if (!sealedField && !signature) continue;
          const [ax, ay, bx, by] = annotation.rect;
          const [x1, y1] = viewport.convertToViewportPoint(ax, ay);
          const [x2, y2] = viewport.convertToViewportPoint(bx, by);
          marks.push({
            name: annotation.fieldName ?? '',
            label: sealedField ? GOAL_RUN_COPY.pdfSealed : GOAL_RUN_COPY.pdfSignature,
            left: Math.min(x1, x2),
            top: Math.min(y1, y2),
            width: Math.abs(x2 - x1),
            height: Math.abs(y2 - y1),
          });
        }
        views.push({ index, width: viewport.width, height: viewport.height, marks });
      }
      if (!alive) return;
      setPages(views);
      setStatus('ready');
    })().catch((cause: unknown) => {
      if (!alive) return;
      setError(cause instanceof Error && cause.message ? cause.message : GOAL_RUN_COPY.pdfFailed);
      setStatus('failed');
    });
    return () => {
      alive = false;
    };
  }, [url, load, sealed]);

  // Draw each page once its canvas is on screen.
  const drawPage = useCallback(async (index: number, canvas: HTMLCanvasElement) => {
    const doc = docRef.current;
    if (!doc || canvas.dataset.drawn) return;
    canvas.dataset.drawn = '1';
    const page = (await doc.getPage(index)) as {
      getViewport: (options: { scale: number }) => { width: number; height: number };
      render: (options: { canvasContext: CanvasRenderingContext2D; viewport: unknown }) => {
        promise: Promise<void>;
      };
    };
    const base = page.getViewport({ scale: 1 });
    const ratio = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const scale = (widthRef.current / base.width) * ratio;
    const viewport = page.getViewport({ scale });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const context = canvas.getContext('2d');
    if (!context) return;
    await page.render({ canvasContext: context, viewport }).promise;
  }, []);

  useEffect(() => {
    if (status !== 'ready' || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const index = Number((entry.target as HTMLElement).dataset.page);
          if (!entry.isIntersecting) continue;
          const canvas = canvases.current.get(index);
          if (canvas) void drawPage(index, canvas);
          if (entry.intersectionRatio >= 0.5) setCurrent(index);
        }
      },
      { root: scrollRef.current, threshold: [0.1, 0.5] },
    );
    for (const element of scrollRef.current?.querySelectorAll<HTMLElement>('[data-page]') ?? [])
      observer.observe(element);
    return () => observer.disconnect();
  }, [status, drawPage]);

  const download = async () => {
    setDownloading(true);
    setDownloadNote(null);
    try {
      const bytes = await load(downloadUrl);
      const blob = new Blob([bytes], { type: 'application/pdf' });
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = title.toLowerCase().endsWith('.pdf') ? title : `${title}.pdf`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(href), 10_000);
    } catch (cause) {
      setDownloadNote(
        cause instanceof SavedFileError && cause.code === 'verify_identity'
          ? GOAL_RUN_COPY.pdfNotDownloaded
          : cause instanceof Error && cause.message
            ? cause.message
            : GOAL_RUN_COPY.pdfNotDownloaded,
      );
    } finally {
      setDownloading(false);
    }
  };

  return (
    <section
      data-slot="pdf-pane"
      aria-label={title}
      className={cn('flex h-full min-h-0 min-w-0 flex-col bg-[var(--color-bg)]', className)}
    >
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-[var(--color-border)] px-4 text-[12.5px]">
        <span className="min-w-0 truncate font-medium">{title}</span>
        {status === 'ready' && pages.length ? (
          <span className="shrink-0 tabular-nums text-[var(--color-text-muted)]" aria-live="polite">
            {GOAL_RUN_COPY.pdfPage(current, pages.length)}
          </span>
        ) : null}
        {size !== null ? (
          <span className="shrink-0 tabular-nums text-[var(--color-text-faint)]">{formatFileSize(size)}</span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {openPath && onOpenInFiles ? (
            <Button type="button" size="xs" variant="ghost" onClick={() => onOpenInFiles(openPath)}>
              {GOAL_RUN_COPY.pdfOpenInFiles}
            </Button>
          ) : null}
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={downloading}
            onClick={() => void download()}
          >
            {GOAL_RUN_COPY.pdfDownload}
          </Button>
        </span>
      </header>
      {downloadNote ? (
        <p className="shrink-0 px-4 py-1.5 text-[11.5px] text-[var(--color-text-muted)]" role="status">
          {downloadNote}
        </p>
      ) : null}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto bg-[var(--color-surface-well)] px-5 py-5"
      >
        {status === 'loading' ? (
          <p className="text-[12.5px] text-[var(--color-text-muted)]">{GOAL_RUN_COPY.pdfLoading}</p>
        ) : null}
        {status === 'failed' ? (
          <div className="flex flex-col gap-3">
            <p className="text-[13px]">{error ?? GOAL_RUN_COPY.pdfFailed}</p>
            {openPath && onOpenInFiles ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="w-fit"
                onClick={() => onOpenInFiles(openPath)}
              >
                {GOAL_RUN_COPY.pdfOpenInFiles}
              </Button>
            ) : null}
          </div>
        ) : null}
        <div className="mx-auto flex w-fit flex-col gap-5">
          {pages.map((page) => (
            <div
              key={page.index}
              data-page={page.index}
              role="img"
              aria-label={GOAL_RUN_COPY.pdfPage(page.index, pages.length)}
              className="relative bg-white shadow-[var(--shadow-soft)]"
              style={{ width: page.width, height: page.height }}
            >
              <canvas
                ref={(element) => {
                  if (element) canvases.current.set(page.index, element);
                  else canvases.current.delete(page.index);
                }}
                className="block"
                style={{ width: page.width, height: page.height }}
              />
              {page.marks.map((mark) => (
                <span
                  key={`${mark.name}:${mark.left}:${mark.top}`}
                  data-slot="pdf-sealed-mark"
                  role="note"
                  aria-label={`${mark.name}, ${mark.label}`}
                  className="absolute border border-[var(--color-accent-3)] bg-[var(--color-accent-3-soft)]"
                  style={{ left: mark.left, top: mark.top, width: mark.width, height: mark.height }}
                >
                  <span className="absolute left-0 -top-[17px] whitespace-nowrap bg-white px-0.5 text-[10.5px] font-medium leading-[14px] text-[var(--color-accent-3)]">
                    {mark.label}
                  </span>
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
