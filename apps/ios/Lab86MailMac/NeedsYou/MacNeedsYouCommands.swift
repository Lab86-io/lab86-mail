import SwiftUI

// The Needs You menu on the Mac (docs/needs-you.md, phase 5; the keyboard
// table): Mark Done, Later with its three times, Not Mine, Copy Code, Start
// in Albatross, and Open in Mail (or Slack, Jira, ...), on the row the page
// has selected. A menu item runs before the page reads it, so each one is a
// request in MacRequests; the page names its selected row there. The bare
// keys (j, k, e, l, Return) live in the list itself: a bare letter as a menu
// key equivalent would fire inside every text field. Copy Code shares
// Command-C with Edit > Copy; the Edit item wins while text is selected, and
// this one takes the key while a code row is selected with no text.
struct MacNeedsYouCommands: Commands {
    let environment: AppEnvironment

    private var requests: MacRequests { MacRequests.shared }

    private var pageUp: Bool {
        MacNeedsYouCommandState.isPageUp(
            selectedTab: environment.navigation.selectedTab,
            sheetOpen: environment.navigation.sheet != nil
        )
    }

    private var item: ObligationView? {
        requests.needsYouSelectedID.flatMap { environment.needsYou.item(id: $0) }
    }

    private var laterOptions: [NeedsYouLaterOption] {
        NeedsYouGrouping.laterOptions(now: NeedsYouClock.millis(.now), timezone: environment.needsYou.timezone)
    }

    var body: some Commands {
        CommandMenu(MacNeedsYouCommandState.menu) {
            Button(MacNeedsYouCommandState.markDone) {
                requests.requestNeedsYouAction(.done)
            }
            .keyboardShortcut("d", modifiers: [.shift, .command])
            .disabled(!MacNeedsYouCommandState.doneEnabled(pageUp: pageUp, item: item))

            Menu(MacNeedsYouCommandState.later) {
                ForEach(laterOptions) { option in
                    Button(option.label) {
                        requests.requestNeedsYouAction(.later(until: option.until))
                    }
                }
            }
            .disabled(!MacNeedsYouCommandState.laterEnabled(pageUp: pageUp, item: item))

            Button(MacNeedsYouCommandState.notMine) {
                requests.requestNeedsYouAction(.notMine)
            }
            .disabled(!MacNeedsYouCommandState.notMineEnabled(pageUp: pageUp, item: item))

            Divider()

            Button(MacNeedsYouCommandState.copyCode) {
                requests.requestNeedsYouAction(.copyCode)
            }
            .keyboardShortcut("c", modifiers: .command)
            .disabled(!MacNeedsYouCommandState.copyEnabled(pageUp: pageUp, item: item))

            Button(MacNeedsYouCommandState.startInAlbatross) {
                requests.requestNeedsYouAction(.startInAlbatross)
            }
            .disabled(!MacNeedsYouCommandState.startEnabled(pageUp: pageUp, item: item))

            Button(MacNeedsYouCommandState.openTitle(item)) {
                requests.requestNeedsYouAction(.openSource)
            }
            .disabled(!MacNeedsYouCommandState.openEnabled(pageUp: pageUp, item: item))
        }
    }
}
