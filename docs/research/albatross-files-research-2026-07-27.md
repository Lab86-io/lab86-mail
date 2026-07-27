# Albatross Files — product research and implementation notes

Date: 2026-07-27

## Goal

Add a first-class Files workspace to Albatross that can hold direct uploads and
browse Google Drive, OneDrive, and a user-selected iCloud Drive folder without
pretending those providers share the same permissions or API model.

## Mobbin research

Searches:

- Web file explorer with folder locations, compact file list, search, upload, and
  list/grid switching.
- File manager home with recent files, folder cards, and connected cloud sources.
- Integrations page with Google Drive and OneDrive provider cards and connection
  state.
- Cloud-storage connection flow from provider selection through OAuth return.

Patterns used:

- [Dropbox file explorer](https://mobbin.com/screens/5dcfb9ab-6224-4e19-9f9d-39c4090107e2):
  persistent locations on the left, file operations above the list, and details
  kept out of the primary scanning column.
- [ElevenLabs Files](https://mobbin.com/screens/666432ed-a153-4e58-b125-2dd0c9daa7ef):
  a dense, readable default list with search and create/upload actions in the
  surface header.
- [OpenAI Platform storage](https://mobbin.com/screens/10269aa5-1034-4686-b828-9ce9479eb136):
  selection can reveal detail without forcing every metadata field into the
  list.
- [Proton Drive grid](https://mobbin.com/screens/7545a9f2-8ba3-497e-bc33-ea2d8d6b4829):
  thumbnails are useful as an optional view, but list view remains the
  information-dense default.
- [Fabric sources](https://mobbin.com/screens/86570349-ccdc-421d-bd47-82f81807afb5):
  provider cards explain the access model before connection.
- [ChatGPT connected apps](https://mobbin.com/screens/32a4c5be-0847-4cfe-ace7-3e72df53a951):
  Google and Microsoft personal/work storage are recognizable as separate
  authorization targets with concise descriptions.
- [Attio storage connection flow](https://mobbin.com/flows/518e0a7f-f070-40ca-b66e-ecfc969591e3):
  connected accounts become explicit rows with a nearby removal action.
- [Langdock Google Drive flow](https://mobbin.com/flows/7abd3f9f-830f-430d-a30e-ea0408069945):
  OAuth returns directly to a visible connected state instead of a detached
  success page.

## Provider research

- Google recommends choosing the narrowest Drive scope possible. Whole-drive
  browsing requires a restricted scope; this implementation requests
  `drive.readonly` and performs no mutations:
  <https://developers.google.com/workspace/drive/api/guides/api-specific-auth>
- OneDrive delegated `Files.Read` works for personal and work/school accounts
  without granting write access:
  <https://learn.microsoft.com/en-us/onedrive/developer/rest-api/concepts/permissions_reference?view=odsp-graph-online>
- Apple supports iCloud Drive in Finder, Files, File Explorer, and iCloud.com,
  but CloudKit web APIs expose app containers rather than a general third-party
  OAuth gateway into a person's full iCloud Drive:
  <https://support.apple.com/guide/icloud/what-you-can-do-with-icloud-drive-mm19ef899373/icloud>
  and <https://developer.apple.com/documentation/technologyoverviews/shared-data>

## Decisions

- Files is a first-class rail destination alongside Calendar and Tasks.
- The default is a compact list; grid is an explicit toggle.
- "All files" merges Albatross uploads with the root/search results of connected
  providers. Each provider remains visible as a location for folder navigation.
- Google Drive and OneDrive are read-only. Albatross opens provider-hosted URLs
  and does not proxy file contents in this release.
- Direct uploads reuse encrypted-user-scoped Convex storage and are visible as
  the Albatross location.
- iCloud Drive uses an explicit directory picker (or browser folder-input
  fallback). The directory handle/files remain in the browser session. Nothing
  is copied to the server until the user separately chooses Add files.
- Connection display rows and encrypted credentials are separate Convex tables.
  OAuth state is high-entropy, short-lived, single-use, and server-secret-gated.

## Operational setup

Register this callback with both provider apps:

`https://<LAB86_MAIL_PUBLIC_URL>/api/files/oauth/callback`

Required variables:

- `GOOGLE_DRIVE_CLIENT_ID`
- `GOOGLE_DRIVE_CLIENT_SECRET`
- `MICROSOFT_DRIVE_CLIENT_ID`
- `MICROSOFT_DRIVE_CLIENT_SECRET`

Optional: `CLOUD_FILES_REDIRECT_URI`.

Google's restricted `drive.readonly` scope requires the applicable OAuth
verification/security review before broad production availability. A Google
OAuth app left in Testing mode can also issue short-lived refresh authorization,
so reconnect errors must remain visible in the provider row.

## Implemented continuation

The same slice now includes revisioned native documents, spreadsheets, and
presentations; inline web and iOS editors; reviewable AI suggestions; Office
exports; Drive search/import agent tools; and structured Google
Docs/Sheets/Slides write-back with provider-version conflict protection.

iOS uses the system document picker for iCloud Drive, the same authenticated
provider browser for Google Drive and OneDrive, and a native OAuth callback.
Server-side iCloud corpus sync remains deferred because Apple exposes no Drive
web API. Full binary extraction/chunk indexing across every upload and OneDrive
file remains a separate corpus expansion; Google-native files can already be
imported into the canonical model and used by Albatross.
