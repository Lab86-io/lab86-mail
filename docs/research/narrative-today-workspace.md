# Narrative-driven Today working surface

## Scope

Web Today only. Preserve the letter, existing mail/calendar rows, design tokens,
and density. Add at most three agent-composed threads and an independently loaded
current-weather strip. Native Apple code and mobile contracts are unchanged.

## Research and limitations

The required Mobbin skill was read and tool discovery exhausted: neither Mobbin
screen nor flow search is connected in this session. No Mobbin findings are claimed.
The shared preview timed out and Browserbase lacked its configuration file. Local
Playwright/Chromium successfully opened and captured Sunsama's public daily-planning
page. This is a documented research-tool limitation, not a claimed full Mobbin audit.

- [Sunsama daily planning](https://www.sunsama.com/daily-planning): browser inspection
  showed an explicit daily-planning entry point and a task/calendar workspace preview.
  Reuse a clear handoff into focused work, not its expansive marketing-page spacing.
- [Sunsama workspace navigation](https://help.sunsama.com/docs/usage-guides/workspace-navigation/):
  its documented single-task focus and keyboard entry support a dedicated guided-work
  destination rather than expanding every operation inline.
- [Akiflow Today page](https://product.akiflow.com/articles/0741055-today-page):
  the documented distinction between planned tasks and scheduled tasks supports
  labeling existing work separately from a generated suggestion. Documentation
  research only; no signed-in Akiflow UI audit is claimed.

Local flow inspected: BriefCanvas → daily BriefLetter → permission-checked
NarrativeBrief; WorkDetail → GuidedStepPane; existing work-state route; capture
review flow; narrative feedback boundary; existing WeatherKit/Open-Meteo providers.

## Decisions

- Keep the narrative as the opening; add a compact working surface underneath.
- Model output is a bounded JSON selection over host-assigned source aliases, not
  generated HTML, scripts, arbitrary links, or executable tool calls.
- Attach original dates, provenance, and original-source links. Never turn a stale
  task, calendar invitation, or inferred summary into proof of completion.
- Read live owned Work details before offering navigation or a completion control.
  Guided navigation is a transient client request and never starts execution.
- Suggestions enter the existing capture/review flow; no automatic task creation.
- “Not today” and corrections save explicit user feedback through narrative's
  permission boundary. “Mark work done” updates the existing Work record only on click.
- Layout cache is bounded and ephemeral; no new durable copy escapes narrative's
  erase/consent boundary. Visibility is checked even on cache hits; changes during
  generation discard the draft. The evidence-only fallback stays usable.
- Weather loads independently, uses existing location preferences/providers, labels
  the forecast's location and units, strips precise coordinates from the response,
  credits the provider, and never substitutes invented zeroes when unavailable.
- Source cards stack on narrow screens. All actions are native keyboard-operable
  links/buttons with visible focus. Corrections explicitly focus a labeled textarea.

## Verification

Focused tests cover composition limits, invented references, source diversity,
ownership, consent revocation, stale generation, cache scoping, model failure,
feedback validation, weather privacy/fallback, rendering, and navigation.
The synthetic browser fixture uses real components and built CSS, blocks all real
data calls, and supports keyboard, feedback, capture, and guided-navigation checks.

Verified locally: full test suite (3,366 tests), production build, typecheck, and lint. Browser interaction checks
passed for keyboard guided navigation without writes, focused corrections, review
before creation, deferral, explicit completion, 390 px layout, and dark mode.

Real personal staging smoke: model-generated composition with three threads, six
source references, one owned Work link, and live Open-Meteo weather in Fahrenheit.
The smoke asserts unchanged source consent and performs no Work writes or sends.
Early model output exceeded the layout schema; explicit JSON mode and prompt
length constraints passed the real-account retry. A provider failure remains a
usable evidence-only layout and can be retried without a stale failure cache.
