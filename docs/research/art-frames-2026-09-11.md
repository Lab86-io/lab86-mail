# Artwork, frames and printed lettering

## Request and existing flow

Continue the existing framed daily brief with 21 frames, including black Gothic,
modern and Art Deco; choose frames to suit the artwork; broaden museum sources;
derive the title ink from each image and add subtle texture.

Inspected `BriefMasthead`, `BriefCanvas`, Today, the shared inset CSS, the five
existing photo assets and their credits, daily image selection, fallbacks, and
Claude's unfinished museum/palette generator. The main art box, title position,
weather and wall-label placement remain part of the same dense brief layout.

## Research notes for the PR

The repository asks for Mobbin and browser product research. Loaded the Mobbin
research skill, but no Mobbin MCP or tool-search connector is available in this
session. No Mobbin results are claimed. Intended focused web queries:

- Museum artwork detail with a large image, title and artist credit below.
- Editorial daily dashboard with serif title over art and compact weather.
- Art collection grid with material frames and restrained color accents.

Browser reference: [Rijksmuseum Art Deco collection](https://www.rijksmuseum.nl/en/collection/set/Art-Deco--791be437-b294-4d37-73d9-08dd0f2c01a3).
Inspected its rendered hero and collection: the large artwork carries the display
heading, a dark overlay separates lettering from busy imagery, and the collection
keeps attribution secondary. The visible 1920s references use geometric bands,
fans, stepped lines, black lacquer and muted metallic color. Applied that material
vocabulary to original SVG mouldings, without expanding the surrounding app UI.

[Rijksmuseum, A Question of Framing](https://bulletin.rijksmuseum.nl/article/download/9695/10208/15881)
provides historical context for substantial black ebony profiles around Dutch
paintings. That informed the ripple-profile frame and dark framing for Dutch work.
Frame choices are an editorial heuristic, not a claim about an artwork's original frame.

## Museum data and provenance

- [Met Collection API](https://metmuseum.github.io/): public-domain objects only,
  with the museum's date, origin, medium, object URL and image.
- [Cleveland Open Access API](https://openaccess-api.clevelandart.org/): CC0 image
  records only. The API returned 403 during this run, so the generator uses the
  museum's [official data export](https://github.com/ClevelandMuseumArt/openaccess)
  as its fallback. This also makes its richer style metadata available.
- [SMK API documentation](https://api.smk.dk/api/v1/docs/): public-domain paintings,
  searching Danish subjects and modern artists alongside landscapes and interiors.
  Native download links are resolved to their original IIIF identifiers and
  requested at up to 1600 × 1000, avoiding full-resolution source downloads.
- [National Gallery of Art Open Data](https://github.com/NationalGalleryOfArt/opendata):
  joins object records to primary images explicitly marked open access. Parses
  quoted CSV fields including multiline text. Adds medieval work, modern
  compositions, still lifes, portraits, prints and drawings.

The generated catalog contains 409 works: Met 51, Cleveland 120, SMK 120, NGA 118.
Artwork images are fetched and decoded to sample their colors during generation;
no canvas/CORS-dependent extraction or museum API request is needed at runtime.
Art Institute URLs remain excluded following the earlier hotlink failures.
Museum selection is balanced before selecting a work, so larger source catalogs
cannot crowd out smaller ones. Source failures during regeneration cannot replace
the catalog with fewer than 300 works or fewer than ten from any of the four museums.
Downloads are cached in the system temporary directory; set `ART_POOL_REFRESH=1`
to fetch fresh source data. Network calls have a 20-second timeout.

## Implementation choices

- Preserve the five museum photo frames; add six Gothic, five modern and five
  Art Deco original SVG frames. Original assets are credited as Albatross designs.
- Explicit museum movement metadata wins over date bands. Origin informs Dutch
  and East Asian framing. Seeded daily variation only chooses suitable frames.
  Modern compositions can use modern or geometric Deco frames.
- Quantize small image derivatives into up to six weighted colors, then tint a
  selected image color toward light ink. Monochrome images retain neutral ink.
- Check the darkest 6% grain flecks against the maximum possible background under
  the 60% black scrim. Minimum measured contrast is 4.5:1. Higher-contrast and
  forced-color modes remove the texture; semantic text is present once.
- Each fallback carries its own image, palette, classification and credit.
  Stale errors cannot skip a source; changing the artwork/day resets exhausted
  fallbacks. Bundled images have sampled palettes and omit unknown attribution.
- `/dev/frame-preview` shows all 21 with collection filters, artwork selection
  and sampled swatches; production continues to return 404 for this dev route.

## Validation

Focused tests cover palette extraction/contrast, classification, frame coverage,
catalog provenance and source balance, fallback metadata, stale errors and resets.
Browser acceptance covers all frames, image/asset loading, collection and artwork
selection, desktop/phone geometry, dark mode and high-contrast behavior. Final
command results:

- `bun test`: **3,601 passed, 0 failed** across 375 files.
- Final focused artwork/brief tests: **42 passed, 0 failed** across seven files.
- `bun run typecheck`: passed.
- Biome checks on the changed implementation and test files: passed.
- `node scripts/verify-art-frames-ui.mjs`: passed; 21 assets, both gallery
  controls, 320/390/768/1280px layouts, dark mode and contrast modes.
- `git diff --check`: passed.

Visually inspected the Gothic and modern collections and the 390px Art Deco
gallery with real Met paintings loaded. Final screenshots are in
`/tmp/albatross-art-review/` (`gothic.png`, `modern.png`, `art-deco.png`,
`phone.png`, `dark.png`). The preview harness can be started on a separate port
with `ALBATROSS_PREVIEW_PORT=18848 bun scripts/preview-app-workspace.mjs` and
opened at `http://localhost:18848/?review=frames`.
