# Full-client parity: Albatross interaction research

Date: 2026-07-23

This note records the focused Mobbin and browser research used while implementing
the accepted backlog in `docs/ux-flow-parity-audit-2026-07-23.md`. It is not a
new audit and does not change the accepted scope.

## Research questions

1. How should a conversation retain the Work or Area that launched it?
2. How should a risky agent action pause without losing its conversational context?
3. How should attachments and recoverable failures remain visible in a chat?
4. How should conversation history read when it is empty or grouped over time?

## References inspected

- [monday Sidekick chat](https://mobbin.com/flows/34655d93-3325-44cd-8848-3ddda2b16c61)
  keeps the current board visible behind the assistant, acknowledges that scope in
  the first response, and asks a scoped clarification before acting.
- [Microsoft Copilot conversations](https://mobbin.com/flows/c84e4462-2fc6-4780-877f-91dfae35d40c)
  uses an explicit empty-history state and keeps new-conversation and composer
  actions available.
- [Tiimo chat history](https://mobbin.com/flows/4ad7fb1a-1d5f-4c5a-af31-b698bb1bcec2)
  presents a compact, date-grouped history under the active page.
- [Manus approval/progress card](https://mobbin.com/screens/5f1e26ff-a7aa-426a-9510-fa2928315f24)
  states the proposed subtask, its cost/impact, and the choices to start once or
  always allow it.
- [Navigator review card](https://mobbin.com/screens/c28c27bc-7067-4924-800a-b17b7770a1d4)
  pairs a factual recap with clear accept and correction actions.
- [Wabi mutation history](https://mobbin.com/screens/fd8cb6af-b1ce-4a3e-aab2-1bb2a43cf988)
  keeps individual changes visible and gives each mutation its own undo affordance.
- [Copilot file attachment](https://mobbin.com/screens/5923fab9-9ed4-4f17-abb2-57b05e99db7a)
  keeps filename, type, and remove control in the composer.
- [Gemini image attachment](https://mobbin.com/screens/793f47cc-ae07-4cfa-b36a-831db8d6d397)
  uses a compact preview chip that remains removable before send.
- [ChatGPT sent file](https://mobbin.com/screens/4cb31b2c-ad0c-4bcb-9789-5168460a1e7f)
  retains the file in the transcript after submission.
- [Mimo recoverable error](https://mobbin.com/screens/d6b05c01-83c7-4c09-8d49-a8ba36d6f611)
  keeps failed work inline and offers a specific repair action.
- [Opera Aria retry](https://mobbin.com/screens/08707419-9dd5-434d-9934-9345336fef19)
  preserves the prompt, renders a terminal error below it, and places Retry at
  that failure.

## Implementation decisions

- A chat launched from Work or an Area carries a typed scope. The scope is visible
  in the conversation and persists with its history instead of living only in a
  transient navigation flag.
- Human-in-the-loop review is an item-bound card at the responsible turn. It names
  the action, affected entity, submitted parameters, and risk before presenting
  Approve and Reject.
- The same action-risk model drives rich artifacts and fallback content. Navigation
  is immediate; externally visible or destructive mutations require contextual
  review.
- Attachments are represented as durable items with filename, media type, progress
  or failure, removal before send, and transcript retention after send.
- Retry is attached to the failed message or tool call. The prompt and attachments
  remain intact, and a new attempt does not manufacture a success state.
- Conversation history has explicit loading, failed, empty, and date-grouped
  states, plus a clear New Chat action.
- Automated mutations remain individually identifiable so Activity can offer
  operation-specific undo where the server reports that undo is still available.

## Browser inspection

The product-native preview host was unavailable in this environment, so the
shared browser fallback was used. The staging shell reached its authentication
boundary and did not expose an authenticated product surface. Production showed
the real Clerk sign-in path, supported Google, email/username, phone, and passkey
entry, and described Gmail, Outlook, and iCloud connection support. No UI
acceptance claim is based on the unauthenticated browser session; authenticated
acceptance remains part of the staging and device gates.
