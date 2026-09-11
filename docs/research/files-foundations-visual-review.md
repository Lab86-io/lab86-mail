# Files foundations and visual review

## Scope and method

This pass owns the web UI and shared file services, not `apps/ios`, MobileAPI, or `lib/mobile/v1` (native ownership remains with Claude). No account data was modified during production inspection. No sources were connected or disconnected, no brief was generated, and no document was edited in production.

The signed-in shared browser was available. Captured real desktop and mobile-width screenshots of Files, Search, and an Area, plus desktop Calendar, Today, and Mail. These contain private account material and are deliberately not committed. Phone-width web screenshots are not evidence of native iOS acceptance.

Mobbin research was attempted but no Mobbin tool is available in this session. No Mobbin screen is claimed as viewed. The fallback combined signed-in product inspection with browser-based primary-source research:

- [Google Drive search help](https://support.google.com/drive/answer/2375114?hl=en): separate location and type controls; clarify the scope of search.
- [Google Drive file search API](https://developers.google.com/workspace/drive/api/guides/search-files): distinguish file-name matches from provider full-text matches.
- [Google Docs content operations](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/request): preserve the mandatory final newline rather than adding a blank paragraph on each save.
- [Google Docs write control](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/batchUpdate): use a required revision to reject concurrent document changes.
- [OneDrive search improvements](https://techcommunity.microsoft.com/blog/onedriveblog/enhanced-onedrive-search-experience-new-features-to-boost-productivity/4260347/): make file location legible and keep filtering coherent.

The implementation preserves Albatross's typography, semantic color tokens, compact density, and editorial briefs. This is a consistency and reliability pass, not a replacement design system.

## Screenshot findings and changes

| Finding | Treatment |
| --- | --- |
| Floating mobile menu covers Files title, Today title, and Area controls | In-flow shared mobile navigation with a directly accessible Search action |
| File row columns and actions extend outside phone viewport | Responsive metadata columns; mobile subtitle; visible, larger action targets |
| Drive locations disappear on phones | Location selector in the main file toolbar |
| Dark mode gets a large light-colored drive failure strip | Semantic colors, compact expandable details, retry and connection recovery |
| Library/provider limits masquerade as complete results | Cursor-based browsing, load-more controls, explicit partial-result notices |
| Provider content search matches disappear in All files | Respect provider results instead of re-filtering everything by filename |
| Thumbnail failures show broken image chrome | Fall back to the normal file-type icon |
| Narrow editor's assistant is initially open, taking much of the document viewport; its button is blank | Default closed below desktop widths, real icon and accessible name |
| Google import discards structures that whole-body save would overwrite | Fail-closed fidelity check; read-only excerpt and original-provider link for unsupported files |
| Conflict response can lead to repeated stale autosaves | Stop saves, preserve draft, require explicit reload/discard; re-check provider version before revision-guarded body write |

## Fundamentals

- `/api/files/library` is authenticated, rate-limited, owner-scoped, and private/no-store. It returns metadata, never editor models.
- Convex scans are bounded by rows and bytes. Search can return an empty page with a continuation; the UI must not call that an exhausted folder.
- Library browsing and palette search share the validated page reader. Palette retrieval is deliberately bounded to four pages per kind, with an incompleteness notice; it is not a full indexed corpus search.
- Google Drive search includes provider full-text. OneDrive continuation URLs stay on the Graph drive API. Tool pagination does not silently discard part of a larger provider page.
- Unsupported rich Google documents, sheets, and decks remain available through their original provider. Rich editing is not solved by this patch. Albatross-native documents remain editable.
- Connected sources in the inspected account required reconnection. The UI can guide recovery; it cannot renew revoked consent on the user's behalf.

## Reproducible acceptance

Run `bun run build`, then `bun scripts/preview-narrative-tools.mjs --files`. In another shell run `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chromium bun scripts/verify-files-ui.mjs`.

The acceptance script is pinned to the loopback synthetic fixture. It checks 390/768/1440px layouts; row/action bounds; shared mobile navigation and search; provider selection; keyboard folder opening and return; pagination; type filters; provider content matches; no-results and partial failures; thumbnail fallback; read-only provider previews; successful saves; and conflict recovery without automatic retries. It saves synthetic light/dark screenshots outside the repository.

Focused tests cover metadata-only pagination beyond the old first-page limit, owner separation, auth and validation, malformed sources, bounded palette retrieval, file type filters, provider full-text/cursor propagation, lossless-editability guards, and zero provider mutations for unsupported documents or unverifiable versions.

The browser acceptance run passed all listed interactions; the synthetic screenshots were visually inspected as well. The production screenshots are the before-state only. Local preview could not be opened in the shared browser, so changed-code acceptance used local Chromium. The build, full test suite, lint, and type checks were run locally; this document is not deployment evidence.

## Remaining product work

1. Files needs indexed content extraction and evidence links into Areas/briefs/work. Name search plus provider full-text is a step, not that complete integration.
2. A mature editor needs a faithful provider document model or targeted structural operations. Do not re-enable destructive simplified round-trips as a cosmetic fix.
3. Today was in its no-edition state during inspection; a populated real-account brief was not visually verified. The empty state could offer more immediate utility.
4. Search can display repeated narrative suggestions. Dedupe should preserve distinct evidence, not simply discard same-title entries.
5. The inspected Calendar showed repeated holiday rows and some cross-day time-only chips. Determine whether these represent duplicated calendars, timezone handling, or layout before changing event semantics.
6. Area mobile layout still has independently scrolling brief/inbox regions. A separate interaction pass should test whether that split helps on short screens.

Do not describe this pass as eliminating every visual defect or delivering native parity.
