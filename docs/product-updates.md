# Product updates

The web app’s **What’s new** link opens `/updates`. The feed lives in
`lib/updates/content.json` and ships with the app. It does not depend on an AI
provider, GitHub availability, a separate backend, or a database migration.

Add a batch alongside the product change in its PR. Describe the user-visible
result, rather than copying commit messages. Use a stable, unique ID, an ISO
calendar date, a title, and one or more changes. Change IDs must be unique within
their batch. Each change has a `kind` (`new`, `improved`, or `fixed`), `title`, and
`description`. A release `version` is optional; only include a known release
version. Batches display newest first. Published batches are immutable: add a new
entry for a correction so existing readers can discover it.

**One to three changes** display directly. **Four or more changes** require an
authored `summary` with both `text` and its own HTML `demo`:

```json
{
  "summary": {
    "text": "A short explanation of what changed.",
    "demo": {
      "caption": "Explain what to try in this release’s demonstration.",
      "html": "<details><summary>Try the changed view</summary>Demonstrate the actual change here.</details>"
    }
  }
}
```

The text and working HTML demonstration form one visible summary. The full list
starts collapsed behind “See all N changes”; supplementary screenshots or previews
go inside that full list. A demo is mandatory for every summary, including an
optional summary on a smaller batch. It must demonstrate that release’s changes,
rather than offer a generic explanation of the update system. Summary demos always
accept pointer and keyboard interaction. The schema rejects plain-text-only
summaries and screenshot-only replacements for the HTML demo.

Summaries and their demonstrations are authored and reviewed with the code;
collapsing is automatic. No text or HTML generation happens when a user opens the feed.

An optional supplementary `preview` can contain either a screenshot or a small HTML demonstration.
Both formats require a `caption` explaining the change without relying on sight.

For a screenshot, place the publishable asset in `public/updates/` and supply
`image` (such as `/updates/update-summary-demo.png`), descriptive `alt`, and the
original `width` and `height`. PNG, JPEG, WebP, and AVIF are supported. The update
check and tests verify that referenced screenshot files exist. Screenshots retain
their aspect ratio and do not depend on remote image hosting.

For HTML, supply a small, self-contained fragment in `html`. Set `interactive: true`
for a demonstration using native controls such as radios, checkboxes, or details.
This enables pointer and keyboard access. Otherwise the frame is an illustration
without interaction. Native HTML and CSS can demonstrate view changes without
scripts; use an ordinary app component for a feature requiring application logic.

Use fictional display data. Previews demonstrate the change without connecting
to live app data. Avoid external assets, scripts, form submissions, and links.
The frame blocks scripts, same-origin access, and network resources; inline
CSS and data images work. Shared preview CSS provides `--surface`, `--text`,
`--muted`, `--border`, `--accent`, and `--soft`, with light and dark palettes. Keep
the fragment compact enough for a 260px-high desktop frame and a 320px-high phone frame.

An open app checks `/api/app-release` every minute while visible and when focus
or network access returns. The same-origin endpoint disables caching and uses
the version and note IDs bundled with that app build. New versions or new note
IDs offer **Update available** in the rail. **Later** keeps working; **Reload to
update** rechecks the release before reloading the same URL, preserving native
unsaved-work guards. If another release supersedes the reviewed one, its notes
replace the dialog contents and require another click. Unavailable checks leave
the current app usable. No polling event opens the dialog or reloads the page.
Rebuilds with the same package version and same note IDs share an identity; the
production release workflow already bumps the package version for each release.

The unread dot records the latest viewed batch ID in this browser’s local
storage. Opening the feed marks its current latest batch read; prefetching does
not. Tabs synchronize through storage events. Clearing browser storage makes
the feed unread again. The receipt is device-local rather than account-wide.

Run `bun run updates:check` and `bun test tests/product-updates` before merging.
The checked-in feed is also
validated by the normal test suite. Old entries stay available in the feed.
