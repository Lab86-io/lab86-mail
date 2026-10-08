#if os(iOS)
import SwiftUI

/// The iPad form of the Albatrosses page (docs/albatross-threads.md, T4):
/// the list in a 320 pt column, the open thread beside it. The outer
/// navigation bar hides; the list draws its own title and the thread has
/// its own stack. A nested split view is not a supported layout, so this is
/// an HStack with a hairline between the columns.
struct ThreadsSplitView<ListColumn: View>: View {
    @Environment(AppEnvironment.self) private var environment
    let route: WorkRoute?
    @ViewBuilder let list: () -> ListColumn

    var body: some View {
        HStack(spacing: 0) {
            list()
                .frame(width: WorkView.listColumnWidth)
            Divider()
            Group {
                if let route {
                    NavigationStack {
                        WorkThreadView(route: route, showsAttentionBanner: false)
                    }
                    .id(route.workID)
                } else {
                    placeholder
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(environment.theme.paperColor)
        .toolbar(.hidden, for: .navigationBar)
    }

    private var placeholder: some View {
        VStack(spacing: 8) {
            Text(ThreadsSplitCopy.chooseTitle)
                .font(.title3)
                .foregroundStyle(.secondary)
            Text(ThreadsSplitCopy.chooseLine)
                .font(.footnote)
                .foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
    }
}

enum ThreadsSplitCopy {
    static let chooseTitle = "Choose an Albatross"
    static let chooseLine = "The list stays live while you read."
}
#endif
