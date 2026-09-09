# Narrative/search review fixes

September 9, 2026. Follows CodeRabbit's review of promotion PR #230.

- Validate the meeting-preparation fields that the panel renders, including
  nested evidence and source IDs. Malformed successful responses show a retryable
  error rather than escaping the panel as a render exception.
- Validate calendar/file search collections and required row fields before
  mapping. A malformed response is an actionable failure, not a false empty
  result or a raw TypeError shown to a keyboard user.
- Applying a narrative draft to a nonempty composer explicitly says **Replace
  message**, with a warning that quoted text is included. Generation still does
  not mutate the message; nothing is sent by this action.

These are error handling and clarification changes within existing surfaces, not
a redesign. Existing layout, icons, density and navigation are unchanged. Focused
component tests exercise malformed payloads and explicit acceptance; source tests
exercise missing, null and malformed collections. Full regressions and browser
acceptance remain promotion gates.
