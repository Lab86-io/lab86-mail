# Brief verification after the production release

The first production regeneration completed all five area jobs and the daily job on their first attempts. The daily run took about 25 minutes, including analysis of 117 conversations, then selected seven items and authored seven Tool UI components across six regions. No application generation cutoff interrupted it.

## Map source

Rendering the saved production document with Next.js exposed a map source defect: the existing CARTO raster endpoints returned tiles watermarked “API key required.” The renderer and map markers worked, but the geographic background did not.

The map now requests OpenStreetMap's standard raster tiles directly from the browser. The official [tile usage policy](https://operations.osmfoundation.org/policies/tiles/) specifies the URL, visible attribution, normal browser Referer and HTTP caching, and no bulk prefetch or offline download. This change keeps those defaults and only requests the visible Leaflet viewport. Zooms above the native tile limit reuse the highest supported native tiles. Existing map controls and responsive layout stay intact; light and dark treatments apply only to the tile layer.

Browser verification of the saved production document found seven rendered components, a visible map, no horizontal overflow at 1280px or 390px, and no JavaScript errors. A saved choice survived reload through the local component store. This validates the renderer with saved production data, not an authenticated browser session in production. No production selections were changed. Screenshots and source documents remain local because they contain private account data.

The Bun-only preview had an unrelated CSS-module bundling error; final map verification uses Next.js, the app's actual bundler.

## Evidence conflicts

The first generated edition repeated an old PR review warning as active even though it cited a later merge notification elsewhere. Both prose and layout writers now share explicit evidence rules: reconcile exact item identities and timestamps; newer direct completion evidence supersedes old summaries; old failures with no matching resolution must be dated and qualified as unverified. This does not infer that an unrelated newer release fixes an older rejected build, or mark work complete from silence.

Focused tests verify the writer request policy and public tile URL, attribution, and native zoom contract. The subsequent production regeneration is the live check of the updated editorial instructions; prompt guidance cannot guarantee factual correctness in every future model response.

## Release runner availability

The follow-up's CI and staging deployment jobs remained queued without a runner assignment, including a cancelled/retried PR CI run. The organization runner listing reported 420 offline runners and no online runner. All local checks and the separate Apple build/archive checks passed. Public provider status pages showed no active incident, so this does not establish a platform-wide outage or its cause.

The three web workflows now accept `WEB_WORKFLOW_RUNNER`, retaining the existing Blacksmith label when unset. Setting the repository variable to `ubuntu-24.04` allows validation and release on GitHub-hosted Linux without removing tests, changing secrets, or bypassing required checks. Native workflows are untouched. [GitHub documents configuration variables in `runs-on`](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#vars-context).
