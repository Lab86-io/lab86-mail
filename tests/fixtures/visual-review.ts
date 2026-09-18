import type { DeckModelV2 } from '../../lib/documents/model';

/** Content/composition tests isolate the separate generative art-direction service. */
export async function passingLayoutDesign(model: DeckModelV2) {
  return { model, designedSlideIds: [], fallbackSlideIds: model.slides.map((slide) => slide.id) };
}

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
