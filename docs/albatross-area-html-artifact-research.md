# Generated Area HTML artifact — research and architecture

Date: 2026-07-13  
Issue: follow-up to #75

## Product clarification

The selected Area is not a React dashboard with generated prose inside it. The
entire center pane is a generated, self-contained HTML artifact, analogous to
the Daily Brief and plan dossier. The stable application owns only the rail,
opaque iframe boundary, theme bridge, validated actions, regeneration state,
and failure recovery. The model owns the Area document's hierarchy,
composition, visual grammar, and narrative.

The generator is explicitly told to **be creative**, treat the full page as a
canvas, invent a visual grammar for the particular Area/edition, and reject
generic dashboards, equal card grids, counter tiles, and interchangeable
templates. Declared Work outranks evidence volume. Projects/Epics remain the
multi-week grouping primitive; Plans appear only under their Work. Candidate
context is uncertain, and completion is never inferred from activity.

## Mobbin grounding

Fresh Mobbin searches were run for AI-generated project/workspace summaries and
for editorial project overviews. The returned screenshots were inspected, not
just their metadata.

- [Asana AI project summary](https://mobbin.com/screens/0f8c5ba7-03c4-4efc-82c3-ac316c64432f)
  (`0f8c5ba7`): a narrative synthesis can lead the page, but its large bordered
  summary panel still behaves like one widget inside a fixed application
  template. Area artifacts should take the useful narrative priority without
  inheriting the box.
- [Asana generated status edition](https://mobbin.com/screens/140afee3-90ed-4459-b057-c17cf06b84e7)
  (`140afee3`): the previous summary remains visible while status-generation
  feedback appears separately. This grounds last-good HTML during regeneration
  rather than replacing the document with a spinner.
- [Asana AI-summary empty state](https://mobbin.com/screens/91b6ac7f-bcb5-48ef-bede-fe61fef3a8e0)
  (`91b6ac7f`): generation is an explicit honest state. It grounds the first-
  edition composer and retry path rather than fabricated placeholder content.
- [ClickUp AI alongside current work](https://mobbin.com/screens/84183559-1f97-4697-b797-ca933f1e8453)
  (`84183559`): an assistant can ask useful questions about current Work, but a
  docked chat panel competes with the workspace. Area discussion therefore
  stays a small host action and opens the existing scoped AI overlay.
- [ClickUp configurable dashboard](https://mobbin.com/screens/41f379ce-ec4b-401e-bae3-c232707910e6)
  (`41f379ce`) and
  [Monday project dashboard](https://mobbin.com/screens/45024d13-339c-430c-b9be-7bc815f57275)
  (`45024d13`): pie charts, stat widgets, and movable equal cards illustrate the
  exact failure mode. The Area prompt bans this grammar and permits a chart only
  when real relationships make it explanatory.
- [Productboard roadmap](https://mobbin.com/screens/f4b3c64b-7dde-4132-be72-f874115da4c9)
  (`f4b3c64b`): a spatial/time grammar is valuable when the underlying work has
  time horizons. This supports allowing the generator to invent a week rail or
  project field when real dates and nesting warrant it, rather than forcing a
  universal section stack.

## Browser-based grounding

- [Anthropic: What are artifacts?](https://support.anthropic.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them)
  defines artifacts as substantial, self-contained content—including single-
  page HTML and interactive components—that stands on its own in a dedicated
  window and can be iterated through versions. This grounds treating the Area
  document as the surface itself and composing a new edition on refresh.
- [Linear project overview](https://linear.app/docs/project-overview) puts the
  brief summary, project properties, resources, description, milestones, and
  progress into one project document. This grounds the Area data pack's explicit
  Work→Project relationship and the rule that long-running Projects/Epics are
  not flattened into task evidence.
- [Linear initiative and project updates](https://linear.app/docs/initiative-and-project-updates)
  describes concise current updates plus chronological history and explicit
  health/progress inputs. It supports edition/freshness semantics while
  reinforcing that progress must come from stored state, not generative guess.
- [MDN iframe](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)
  documents `srcdoc` as a full inline document and recommends combining CSP with
  sandboxing for generated/user-authored content. The implementation removes
  model scripts/handlers/embedded frames, injects a restrictive CSP, omits
  `allow-same-origin`, and accepts postMessage actions only from the current
  iframe window.

## Architecture decisions

1. `albatrossAreaBriefs.artifactHtml` stores the bounded last-good document.
   Setting `status: generating` or `error` preserves it; only a successful
   `ready` save replaces it.
2. The revision hash covers scoped source state but excludes edition time, so a
   background check can reuse a current artifact. The explicit refresh endpoint
   passes `force: true` to create a new creative edition even when source data
   has not changed.
3. The data pack is bounded and provenance-shaped: stable IDs only accompany
   allowlisted actions; candidate context is separated from verified context;
   Work carries its nested plan summary; Projects/Epics carry real task counts
   and sprint state.
4. Model output is normalized before persistence: all scripts and event-handler
   attributes, nested frames/objects/embeds, JavaScript URLs, and model CSPs are
   removed. A restrictive CSP is inserted. The host later injects the only
   runtime.
5. The iframe uses an opaque origin. The runtime can post only declared actions.
   The host verifies the message source window and validates each payload. The
   only mutation, typed capture, requires a top-window confirmation before the
   existing authenticated API is called.
6. A small floating host toolbar supplies All Areas, Area identity, edition
   state, Discuss, Refresh, and Manage. It is deliberately overlay chrome so the
   generated document remains edge-to-edge and does not become a child card.
7. The old structured Area renderer remains only as an explicit recovery path
   when no full artifact can be produced. It is never the primary ready state.

## Verification

- Generated and persisted a real 16,030-byte Area artifact against the
  development Convex deployment.
- Inspected that edition in a browser at desktop width: the document had no
  horizontal overflow, missing content, or overlapping regions, and exposed the
  expected capture and navigation actions.
- Passed typecheck, lint, all 1,033 tests, and the production Next.js build.
