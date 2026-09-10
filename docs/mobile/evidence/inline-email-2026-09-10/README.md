# Native inline-email rendering evidence

Captured on iPhone 17 Pro Simulator / iOS 27 with Xcode 27 beta from the
production `AssistantDraftArtifactContent`, hosted in a real scene-attached
UIKit window. The tests inject isolated draft/account/theme state and a
scripted transport. These are actual SwiftUI controls, not design mockups.
No real account, model response, or email send is involved.

Source result bundle on the isolated Mac:
`/tmp/albatross-native-claude-20260910/DerivedData-iOS/Logs/Test/Test-Lab86Mail-2026.09.10_16-55-27--0400.xcresult`

- [Light mode](light.png)
- [Dark mode, contrasting Send label](dark.png)
- [Editing recipients within the artifact](editing.png)
- [Visible attachment error, original draft and attachments intact](attachment-error.png)
- [Accessibility Dynamic Type](accessibility.png)
- [Accessibility footer, scrollable content and unbroken Send label](accessibility-actions.png)
- [Pending send with Undo](pending.png)
- [Unconfirmed send with check-Sent guidance](unconfirmed.png)

The render tests assert that the window contains nonblank pixels, that the
actual recipient control updates the durable owner, that rendering makes no
send call, and that editing presents no separate composer. Larger text uses
a stacked action layout; the screenshot above follows scrolling to the
footer. Long attachment chips intentionally scroll horizontally.

These verify the inline component and its real state owner, not a signed-in
end-to-end agent conversation. The tests focus a recipient control, but these
window images do not claim to capture the system keyboard window. Physical
iPhone, VoiceOver and signed-in Mac acceptance remain separate device checks.
