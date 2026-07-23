# Hierarchical navigation, Area and Work briefs, and native mail reading

Date: 2026-07-18

## Scope

Replace the tab-first iPhone shell with the product hierarchy used by Albatross on desktop: Brief, Tasks, Calendar, and Areas. An Area owns its brief and the Work, events, mail, tasks, projects, and context that belong to it. Work is a first-class destination with its own plan brief. Opened mail must read as a full-page document rather than a card inside a list.

This slice changes navigation, data ownership, deep-link behavior, Area and Work detail presentation, and message reading. It does not copy a desktop sidebar onto a narrow phone screen.

## Apple guidance reviewed

- [NavigationSplitView](https://developer.apple.com/documentation/swiftui/navigationsplitview): a split view is the native model for a leading source list whose selection controls detail; at a narrow size class it collapses into a single navigation stack.
- [NavigationSplitViewColumn](https://developer.apple.com/documentation/swiftui/navigationsplitviewcolumn): `preferredCompactColumn` lets the product open directly to its selected detail on iPhone while retaining the source hierarchy behind the system back gesture.
- [Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars): sidebars expose a broad, flat information hierarchy and should generally stay within two levels. Apple cautions against a persistent sidebar on iPhone because it consumes space; the implementation therefore uses an adaptive split view that becomes push navigation in compact width.
- [Designing for iOS](https://developer.apple.com/design/human-interface-guidelines/designing-for-ios/): primary content receives the screen, secondary controls remain discoverable, and the layout must adapt to Dynamic Type, appearance, and common one-handed navigation.
- [Navigation](https://developer.apple.com/documentation/swiftui/navigation): typed navigation destinations and a path are the appropriate basis for deep links and state restoration.
- [Design principles](https://developer.apple.com/design/human-interface-guidelines/design-principles): a recognizable hierarchy and consistent structure should explain where the user is and what comes next.
- [Build a SwiftUI app with the new design (WWDC25)](https://developer.apple.com/videos/play/wwdc2025/323/): system navigation and toolbar controls receive the current material treatment automatically; Liquid Glass belongs to controls and app structure, not as a decorative material on every content surface.
- [What’s new in SwiftUI (WWDC26)](https://developer.apple.com/videos/play/wwdc2026/269/): `NavigationSplitView` remains the adaptive system structure for sidebar/detail apps and current toolbar behavior adapts across compact iPhone and wider layouts.
- [`prominentDetail`](https://developer.apple.com/documentation/swiftui/navigationsplitviewstyle/prominentdetail): Apple defines this split style around preserving detail size while leading columns appear and disappear. That supports keeping Albatross content visually primary on iPad, but it does not reproduce the under-page compact-phone interaction by itself.
- [`sidebarToggle`](https://developer.apple.com/documentation/swiftui/toolbardefaultitemkind/sidebartoggle): a sidebar toggle is native toolbar vocabulary. On iPhone Albatross uses the matching leading hamburger affordance in the system toolbar while owning the compact transition.

Decision: use `NavigationSplitView` with a detail-preserving style on regular-width iPad. On iPhone, keep the selected destination full-screen and move that page to the trailing side to reveal the same source list underneath it. The shifted page keeps a narrow visible strip, rounded leading corners, and a restrained edge shadow. There is no dimming scrim and no floating drawer card. Do not retain a tab bar solely to emulate the desktop sidebar, and do not make the user navigate "back" to the source list just to switch product areas.

## Mobbin queries and evidence

All searches used the iOS platform, WebP previews, and visual inspection of returned screens rather than metadata alone.

### Product hierarchy

Query: `productivity app navigation list showing a daily brief, tasks, calendar, and projects or workspaces in one hierarchy with a selected content destination`

- [Superlist navigation](https://mobbin.com/screens/676f9fa2-a627-4fa4-a578-795bdb68439d) places Inbox, Today, Tasks, and user-owned lists in one quiet source list. The persistent bottom chrome is app-specific and is not carried into Albatross.
- [Things 3 source list](https://mobbin.com/screens/b3256d81-f23e-42bb-be79-fd3347cd1836) separates universal views from projects, uses restrained counts, and makes project grouping scannable without card containers.
- [Things 3 expanded hierarchy](https://mobbin.com/screens/953ff245-ddc3-49dc-b3ac-5a5f6dcd4f4b) shows that a two-level hierarchy can remain legible when section boundaries and disclosure are quiet.
- [Notion navigation drawer](https://mobbin.com/screens/837966ac-94b9-458d-a2b1-a6b276e861e4) preserves document hierarchy but consumes too much iPhone width and visually competes with content; the overlay drawer treatment was rejected.

Recurring pattern: universal destinations first, user-owned spaces second, terse labels, native rows, and no card grid for primary navigation.

Focused follow-up queries after product review:

- `ChatGPT open the conversation sidebar from a full screen chat, browse chat history, then close the sidebar and return to the conversation`
- `Claude open the sidebar from a full screen chat, browse recent chats and projects, then close the sidebar and return to the conversation`

- [ChatGPT navigation sidebar flow](https://mobbin.com/flows/ce303c5a-d3a2-4048-af5c-1e5c3f18f177), screens 1–3: the conversation page moves right and remains visible as a narrow trailing strip while a flat, full-height source list is revealed beneath it. There is no dark scrim and no rounded drawer floating above the conversation. Navigation rows use quiet filled selection states, and the account control stays at the bottom.
- [Claude chats flow](https://mobbin.com/flows/452dcc19-a390-4d80-80f0-5d01078c802e), screens 1–2: the full-screen conversation shifts right; its leading edge receives large continuous corners and a restrained shadow, making it read as the foreground page while the warm sidebar is the underlying layer. The hamburger remains a compact system-style control.
- [Claude pinning/sidebar flow](https://mobbin.com/flows/7026177a-9967-4f9e-8860-06500a7c7763), screens 1 and 4: the sidebar is stable navigation chrome rather than another back-stack destination. Selected rows use subtle rounded fills; section labels are quiet; settings/account actions live at the bottom edge.

Refined iPhone pattern: full-screen destination, leading hamburger at root depth, source list underneath the page, page translation instead of drawer translation, no scrim, a visible page strip for spatial continuity, tap-page and left-drag dismissal, right-edge-swipe reveal, and the same selection/route owner used by iPad. Nested documents such as Work, event, and mail detail use the system back affordance instead of showing both controls.

### Area and Work detail

Query: `project or workspace detail screen with a summary brief, active work items, messages or mail, calendar events, and tasks grouped into sections`

- [Linear project overview](https://mobbin.com/screens/2d1fdc3c-3758-46bb-88e1-5cfd39ce4148) gives the project title and prose outcome the page, then exposes status and related objects as secondary information.
- [Linear work item detail](https://mobbin.com/screens/023f9f01-c422-4ce2-b64d-6bac73ab80e5) uses a document-like vertical reading order: title, properties, narrative, requirements, then activity.
- [Notion project document](https://mobbin.com/screens/1eff5376-1ef3-4b36-acb7-dd6f01090d1b) demonstrates a full-width brief whose headings and media establish hierarchy without enclosing the entire document in a card.
- [Asana project overview](https://mobbin.com/screens/4e738c2c-a7bb-447e-b5f5-3ba22cf99e62) was useful for summary and progress hierarchy, but its nested summary cards were rejected for Albatross briefs because they make authored content feel like dashboard widgets.

Flow query: `open a project or workspace from navigation, read its overview, then open an active work item detail`

- [Linear project detail flow](https://mobbin.com/flows/0e1f8b28-bfcd-47b0-a20b-2cbe5a2f307f) confirms the useful sequence: project collection → project overview → filtered issue list → work item, with system back navigation preserving context.

Recurring pattern: the brief or outcome is the document lead, status is metadata, related work is grouped below, and a selected work item pushes to a focused detail page.

### Full-page mail reading

Query: `opened rich email thread with sender header, full-width message body, inline images, attachment controls, reply actions, and native toolbar`

- [Apple Mail message](https://mobbin.com/screens/523cc9d8-8627-4ca4-9fc0-8010e11dbfd1) treats the sender, subject, and body as the page, with reply and organization actions in native chrome. The message is not placed inside an inset card.
- [Gmail rich message](https://mobbin.com/screens/e6e6f097-3f0a-4114-8c5c-ea852d8701f1) keeps body text and inline images in one continuous reading surface and reserves the toolbar for message actions.
- [Outlook thread](https://mobbin.com/screens/86c0098c-39ff-4de8-a7bf-09513312e204) uses full-width thread sections separated by whitespace and dividers; the persistent Outlook tab bar is not relevant to the opened-message presentation.

Flow query: `open an inbox, select a message, read the full email thread, then start a reply`

- [Outlook email detail flow](https://mobbin.com/flows/7bb08323-2ede-4abe-bf61-cbd07d0fc273) shows list → full-page body → inline draft/thread continuation without inserting a separate card shell.
- [Outlook reply flow](https://mobbin.com/flows/5e7d1fff-bd1c-4ed6-a81c-ae4a8e27ea71) keeps reply as a focused sheet and returns the sent reply to the thread.

Recurring pattern: subject and sender are compact headers; the body owns the remaining width; older messages may collapse to headers; reply/archive/trash belong in native toolbars. Remote-image privacy can remain explicit, but already-safe message content must never be hidden behind a misleading “load remote images” control.

## Navigation and ownership

```text
Albatross source list (persistent on iPad; slide-over on iPhone)
├── Brief
├── Tasks
├── Calendar
└── Areas
    ├── Area brief
    ├── Work
    │   └── Work plan brief
    ├── Events
    ├── Mail
    │   └── Full-page thread
    ├── Tasks
    ├── Projects
    └── Context
```

- `NavigationModel` owns the selected root destination and typed nested destinations. Deep links, push, Spotlight, and visible rows all invoke the same route methods.
- Selecting a new root clears nested detail. Selecting an Area makes that Area the root document, so it retains the iPhone sidebar control. Opening Work, an event, or a thread pushes over the Area, so Area → Mail → Thread retains Area context and uses the system back gesture.
- `ProductStore` remains the temporary compatibility facade for this slice, but views receive typed `AreaDetail` and `WorkDetail` models. They do not parse dynamic JSON.
- Convex `albatrossWorkV2` remains the durable Work owner. The Area tool aggregates its Work rows; the Work-detail tool exposes its plan artifact. No parallel Work store is introduced.
- Rich email HTML remains sandboxed and sanitized. Safe HTML is rendered immediately; externally hosted images remain governed by the existing privacy preference.

## Mutations and recovery

- Existing brief actions, task completion, event actions, mail reply/archive/trash, and approval routing keep their existing authenticated services.
- Navigation does not report a mutation as complete. Existing receipt behavior remains authoritative.
- Cached Area and Work detail renders immediately. Refresh failures preserve cached content with a retry affordance.
- If an Area has no current brief, identity and related content remain usable with a clear “Brief is still being prepared” state.
- If a Work plan has no rendered artifact, its typed outcome and summary form the readable fallback brief.
- If HTML cannot render, the existing plain-text recovery remains available.

## State matrix

| State | Source list | Area / Work brief | Mail thread |
|---|---|---|---|
| Loading | Root rows remain usable; Areas show progress | Cached document first, then inline progress | Cached summary/body first, then inline progress |
| Empty | Areas section explains how to capture/setup | Identity plus an honest empty related-content message | Empty thread error with retry/back |
| Populated | Brief, Tasks, Calendar, Areas in order; iPhone page shifts over the underlying source list and returns after selection | Full-width authored brief followed by grouped related rows | Full-width sender header and body with native actions |
| Editing | Selected root remains stable | Mutations use existing sheets/actions | Reply/forward opens focused composer |
| Offline | Cached Areas stay selectable | Cached brief and Work stay readable; offline badge | Cached body stays readable; safe mutations queue per policy |
| Partial failure | Healthy roots and Areas remain | Failed section does not erase cached/successful sections | Failed attachment/body offers local retry/plain text |
| Permission denied | Unaffected destinations remain | Provider-owned sections explain missing scope | Message metadata remains; protected download explains recovery |
| Destructive confirmation | N/A | Protected actions retain shared approval flow | Trash/delete uses existing confirmation/undo policy |
| Large Dynamic Type | Rows wrap and preserve 44pt targets | Single-column document; metadata wraps below title | Sender metadata and actions wrap; body scales without clipping |
| VoiceOver | Section headers and selected item announced | Brief heading first; sections and rows have explicit labels | Subject, sender, recipients, body, then actions in reading order |

## Rejected patterns

- Five equal bottom tabs: they flatten Areas, Work, and Mail into unrelated peer products and contradict Albatross ownership semantics.
- A permanently open custom drawer on iPhone: it sacrifices reading width. The selected destination stays full-screen outside the short navigation interaction.
- A floating overlay drawer with trailing corners, heavy shadow, and a dark scrim: it reverses the ChatGPT/Claude depth relationship and makes navigation feel pasted above the product. The source list is the underlying layer; the destination page is the moving foreground.
- Mail or briefs inside rounded dashboard cards: it makes long-form content feel secondary and creates nested scrolling/inset width.
- A second mobile-only Work or brief data model: it would diverge from desktop provenance and approval behavior.
- Copying Outlook/Gmail bottom navigation: their product hierarchy is provider-centric and does not match Albatross Areas.

## Rendered iPhone review

Reviewed 2026-07-19 on the connected iPhone 17 Pro running iOS 27.0 (24A5380h). The signed app retained the authenticated account and production-backed Areas. The physical UI test `Lab86MailUITests/testLaunchesIntoConfigurationOrAuthenticationBoundary()` passed and retained an `Authenticated navigation overlay` screenshot in `/tmp/AlbatrossSidebarReview20260719.xcresult` on the development Mac.

Confirmed in the rendered open state:

- The source list is the flat underlying layer; the Brief page moves right and remains visible as a narrow trailing strip.
- There is no dark scrim or floating drawer silhouette. Continuous leading page corners and a restrained edge shadow communicate the layer relationship.
- The system toolbar supplies the circular iOS 27 control treatment around the hamburger. Glass is not repeated on navigation rows or content.
- Brief, Tasks, Calendar, and Areas appear in the promised order. Real Areas follow under a quiet `Your areas` heading, and Settings remains reachable at the bottom.
- Selected state uses a low-contrast semantic fill plus weight, not color alone. Rows use semantic text styles, accessible labels and selected traits, and minimum 44-point targets.
- Tapping the visible page strip dismisses the sidebar; horizontal edge dragging reveals or dismisses it; Reduce Motion disables the transition animation.

HIG review found no P0 or P1 issue in the captured state. Remaining visual checks for a later whole-app pass are the same sidebar under an accessibility Dynamic Type size, dark appearance, and a longer localized Area name; the implementation uses semantic styles, adaptive colors, truncation, and stable touch targets for those states.

## Acceptance criteria

- Cold launch opens Brief. No bottom tab bar is present.
- iPhone shifts the full-screen page right to reveal the source list underneath, without a dim scrim; iPad exposes the same source list persistently.
- The source order is Brief, Tasks, Calendar, Areas, followed by real user Areas.
- Selecting an Area opens its brief and related Work, events, mail, tasks, projects, and context.
- Selecting Work renders its outcome/summary and plan artifact when available.
- Selecting Area mail pushes a full-page thread while preserving the Area back stack.
- Deep-linked events and threads use the same typed route path.
- Opened message bodies are full-width, render safe content immediately, and are not enclosed in a rounded card.
- Cached, loading, empty, offline, partial-failure, Dynamic Type, and VoiceOver states remain usable.
- Focused server and iOS tests pass, followed by a simulator render review and physical-iPhone install/run.
