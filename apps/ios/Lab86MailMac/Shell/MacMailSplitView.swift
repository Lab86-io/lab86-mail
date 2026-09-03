import SwiftUI

// Mail on the Mac: the thread list and the reading pane side by side, the way
// every desktop mail client works, instead of the list pushing the thread and
// hiding itself. The list is the same MailView the phone uses; the pane reads
// the shared navigation route, so notification actions, deep links, and the
// assistant open a thread here exactly as they do on iOS.
struct MacMailSplitView: View {
    @Environment(AppEnvironment.self) private var environment

    var body: some View {
        HSplitView {
            NavigationStack {
                MailView()
            }
            .frame(minWidth: 320, idealWidth: 400, maxWidth: 560)
            readingPane
                .frame(minWidth: 440, maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    @ViewBuilder private var readingPane: some View {
        if let route = environment.navigation.threadRoute {
            NavigationStack {
                ThreadView(
                    route: route,
                    summary: environment.store.threads.first { route.matches($0) }
                )
            }
            // A new route is a new reader, not the old one re-fed.
            .id(route)
        } else {
            ContentUnavailableView(
                "No Conversation Selected",
                systemImage: "envelope.open",
                description: Text("Choose a conversation from the list to read it here.")
            )
            .background(Color(uiColor: .systemBackground))
        }
    }
}
