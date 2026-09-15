'use client';

import { notFound, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { PresentationEditor } from '@/components/files/editors/PresentationEditor';
import { SlideSurface } from '@/components/files/editors/SlideRenderer';
import { type DeckDirection, hiringDeck, referenceDeck } from '@/lib/documents/deck-fixtures';
import type { AlbatrossDocumentModel } from '@/lib/documents/model';

/* Dev-only harness: the reference decks through the real slide renderer.
 *   ?deck=lakeshore (default) | hiring
 *   ?direction=editorial (default) | signal
 *   ?slide=2            one slide, full viewport width (screenshots)
 *   ?sheet=1            contact sheet, three across
 *   ?editor=1           the real PresentationEditor around the fixture
 * Not linked from anywhere; 404s outside development. */
export default function DeckPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <DeckPreviewInner />;
}

function DeckPreviewInner() {
  const params = useSearchParams();
  const direction = (params.get('direction') === 'signal' ? 'signal' : 'editorial') as DeckDirection;
  const deck = params.get('deck') === 'hiring' ? hiringDeck(direction) : referenceDeck(direction);
  const only = Number(params.get('slide'));
  const sheet = params.get('sheet') === '1';
  const editor = params.get('editor') === '1';
  const [model, setModel] = useState<AlbatrossDocumentModel>(deck);
  if (editor) {
    return (
      <div className="h-dvh">
        <PresentationEditor model={model.kind === 'deck' ? model : deck} onChange={setModel} />
      </div>
    );
  }
  if (Number.isInteger(only) && only >= 1 && only <= deck.slides.length) {
    return (
      <div className="w-screen bg-black" data-deck-single>
        <SlideSurface slide={deck.slides[only - 1]} theme={deck.theme} />
      </div>
    );
  }
  if (sheet) {
    return (
      <div className="min-h-dvh bg-[#1a1a1a] p-8" data-deck-sheet>
        <div className="mb-4 font-sans text-[13px] text-white/70">
          {deck.theme.name} · {deck.slides.length} slides
        </div>
        <div className="grid grid-cols-3 gap-6">
          {deck.slides.map((slide, index) => (
            <figure key={slide.id} className="m-0">
              <div className="shadow-[0_2px_18px_rgba(0,0,0,0.45)]">
                <SlideSurface slide={slide} theme={deck.theme} />
              </div>
              <figcaption className="mt-2 font-sans text-[12px] text-white/60">
                {index + 1} · {slide.title}
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="min-h-dvh bg-[#1a1a1a] px-8 py-10">
      <div className="mx-auto flex max-w-[1120px] flex-col gap-10">
        {deck.slides.map((slide, index) => (
          <figure key={slide.id} className="m-0">
            <figcaption className="mb-2 font-sans text-[12px] text-white/60">
              {index + 1} · {slide.title}
            </figcaption>
            <div className="shadow-[0_2px_24px_rgba(0,0,0,0.5)]">
              <SlideSurface slide={slide} theme={deck.theme} />
            </div>
          </figure>
        ))}
      </div>
    </div>
  );
}
