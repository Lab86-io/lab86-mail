# Native narrative Brief parity

September 9, 2026. User explicitly requested iOS/macOS implementation and builds
for this increment, overriding the earlier platform ownership split for this task.

## Product decisions

The native Brief reads the same `/api/narrative?op=brief&at=…` as web, using the
selected edition's date. The source-backed account replaces the document lede;
the live calendar, existing brief document, and phone navigation stay intact.
Supporting observations open in a native read-only sheet with a Done action.
Semantic typography, flexible text, minimum 44-point controls and system colors
follow the SwiftUI/iOS design skills. No new top-level tab or custom navigation.

Memory is not added to ProductSnapshot or persisted in native caches. Reads are
revalidated on foregrounding, edition changes and refresh, and every minute
while visible (8 seconds during generation). Failed reads and source withdrawal
remove previously displayed narrative content. Superseded/cancelled requests
cannot restore it. Refresh uses existing consent and does not enable sources.

Native chat already streams through `/api/agent`, which captures user statements
and uses task-specific narrative retrieval. Native Albatross creation calls
`/api/albatross/capture`; server-side Work/Area agents use the shared narrative
skill. Compaction and query expansion remain shared server capabilities, not
independent native implementations. Provider OAuth/source choices are unchanged.

Also fixes mounted iOS Mail search request consumption and the historical Brief
toolbar date, with shared native regression tests.

## Build acceptance

`Native acceptance` builds the iOS simulator/device targets and the macOS app/test
target. Shared unit tests execute on iOS 27. It does not sign, distribute, or
upload an app to TestFlight. The [Xcode 27 preview runner](https://github.com/actions/runner-images/blob/main/images/macos/xcode-27-arm64-Readme.md)
currently hosts macOS 26, so it cannot execute the macOS 27-targeted test app;
this limitation is explicit rather than lowering the deployment target.

The signed-in physical-device and macOS runtime/visual checks require reachable
Apple hardware. Build/test logs and result bundles are retained as CI artifacts.

The first full simulator run executed 418 tests: all 13 narrative tests passed,
but an existing day-ribbon assertion exposed a timezone mismatch. The default
label formatter ignored the calendar used to position events. It now shares
that calendar/timezone, with two regressions covering alternate display zones
and preserving an explicitly supplied formatter. Final acceptance reruns both
native targets; the failing assertion was not removed or weakened.
