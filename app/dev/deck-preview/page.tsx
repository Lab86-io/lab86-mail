'use client';

import { notFound, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { PresentationEditor } from '@/components/files/editors/PresentationEditor';
import { SlideSurface } from '@/components/files/editors/SlideRenderer';
import { type DeckDirection, hiringDeck, referenceDeck } from '@/lib/documents/deck-fixtures';
import { upgradeDeckModel } from '@/lib/documents/deck-versions';
import { type AlbatrossDocumentModel, createDefaultDocumentModel } from '@/lib/documents/model';

/* Dev-only harness: the reference decks through the real slide renderer.
 *   ?deck=lakeshore (default) | hiring
 *   ?direction=editorial (default) | signal
 *   ?slide=2            one slide, full viewport width (screenshots)
 *   ?sheet=1            contact sheet, three across
 *   ?editor=1           the real PresentationEditor around the fixture
 *   ?rich=0             editor with version 2 authoring off (text and rect shapes only)
 *   ?deck=legacy        a fresh version 1 deck, to check the gate on old decks
 * Not linked from anywhere; 404s outside development. */
export default function DeckPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <DeckPreviewInner />;
}

/** A version 1 deck as the app creates it today, with a little content. */
function legacyDeck() {
  const model = createDefaultDocumentModel('deck', 'legacy');
  if (model.kind !== 'deck' || model.version !== 1) throw new Error('Expected a version 1 deck.');
  model.slides[0].title = 'Quarterly review';
  model.slides[0].elements[0].text = 'Quarterly review';
  model.slides[0].elements[1].text = 'What changed, what is next.';
  return model;
}

function DeckPreviewInner() {
  const params = useSearchParams();
  const direction = (params.get('direction') === 'signal' ? 'signal' : 'editorial') as DeckDirection;
  const deckParam = params.get('deck');
  const stored =
    deckParam === 'hiring'
      ? hiringDeck(direction)
      : deckParam === 'legacy'
        ? legacyDeck()
        : referenceDeck(direction);
  // The editor takes the stored form (either version); the preview views draw the lifted deck.
  const deck = upgradeDeckModel(stored);
  const rich = params.get('rich') !== '0';
  const only = Number(params.get('slide'));
  const sheet = params.get('sheet') === '1';
  const editor = params.get('editor') === '1';
  const [model, setModel] = useState<AlbatrossDocumentModel>(stored);
  if (editor) {
    return (
      <div className="h-dvh">
        <PresentationEditor
          model={model.kind === 'deck' ? model : stored}
          onChange={setModel}
          richAuthoring={rich}
        />
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
