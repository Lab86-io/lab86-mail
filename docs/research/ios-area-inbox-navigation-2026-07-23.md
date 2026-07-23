# iOS Area Inbox and Back Navigation Research — 2026-07-23

## Scope

Build 31 device feedback identified three connected problems in the Area mail
surface:

- opening Area Inbox can destabilize the app;
- the Brief/Inbox selector should use the system Liquid Glass appearance;
- the leading-edge gesture must close an open email before it can reveal the
  app source list.

The product hierarchy remains `source list → Area Inbox → email`. The change
does not turn Mail into a new visible root destination.

## References

Mobbin iOS research:

- [Apple Mail — Browsing inbox](https://mobbin.com/flows/b8f76723-5c51-4f2c-9219-c84ddc07c633)
  keeps the message list and opened message as consecutive levels of one
  hierarchy.
- [Apple Mail — Mailboxes](https://mobbin.com/flows/f2a754b2-a7b5-41f5-9c69-5d3c1eccfcc4)
  treats mailbox navigation as the level behind the inbox, not as an overlay
  that competes with message-detail back navigation.
- [Amie — Email](https://mobbin.com/flows/82ba9851-166f-4a8b-91a2-7d0280a8255e)
  likewise preserves a distinct list/detail progression.
- [Apple Mail inbox](https://mobbin.com/screens/ad256b93-334f-43ab-baf7-42441e740e7c),
  [Gmail inbox](https://mobbin.com/screens/fe3a8124-64db-4ad1-8847-3d836195b087),
  and [Outlook inbox](https://mobbin.com/screens/0be45d49-ae76-49ba-b326-0d4303925187)
  all use stable, repeatable conversation rows as the identity-bearing unit.
- [GitHub filter control](https://mobbin.com/screens/e3bb1892-0a92-474c-9cfa-9865b92e8528)
  and [Shopify filter control](https://mobbin.com/screens/57f90808-2761-43ad-b021-a80a00ba69bb)
  support a compact, platform-native selected-state control above content.

Apple guidance:

- [Gestures](https://developer.apple.com/design/human-interface-guidelines/gestures)
  says standard hierarchical back behavior should retain priority and custom
  shortcut gestures should supplement it.
- [NavigationSplitView](https://developer.apple.com/documentation/swiftui/navigationsplitview)
  documents the collapsed iPhone hierarchy and system back progression.
- [Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars)
  describes sidebars as a Liquid Glass navigation layer, while recommending
  compact navigation on iPhone.
- [Liquid Glass](https://developer.apple.com/documentation/swiftui/glass) defines
  regular glass as the default system variant.

## Applied Decisions

1. The source-list edge recognizer is absent while any email, event, Work, or
   project destination is pushed. The system interactive-pop gesture therefore
   owns the first swipe. Once the destination binding clears, a second swipe
   can reveal the source list.
2. The custom Brief/Inbox pills are replaced by a native segmented `Picker`, so
   the current OS owns its default Liquid Glass rendering, selected state,
   accessibility, and interaction behavior.
3. Area mail is deduplicated by `accountID + threadID` at the Convex read model
   and again at the iOS decode boundary. When historical links disagree,
   user-verified evidence wins. This prevents duplicate identities from
   reaching SwiftUI `List`.

## Acceptance

- Area Inbox renders one row per account/thread even when historical Area links
  contain both candidate and verified records.
- The Brief/Inbox control is the native segmented control and remains reachable
  through VoiceOver as “Area view.”
- From an open Area email, one leading-edge swipe returns to Area Inbox; a
  second leading-edge swipe reveals navigation.
- Button-based Back and Open Navigation controls remain available.
