import type { DeckModelV2 } from '../../lib/documents/model';

/** Composition tests stub only the separate image-review service. */
export async function passingVisualReview(model: DeckModelV2) {
  return {
    model,
    report: {
      status: 'passed' as const,
      totalSlides: model.slides.length,
      checkedSlideIds: model.slides.map((slide) => slide.id),
      repairedSlideIds: [],
      issues: [],
    },
  };
}
