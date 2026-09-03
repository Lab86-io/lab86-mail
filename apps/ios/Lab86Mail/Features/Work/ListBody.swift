import SwiftUI

/// The list shape: a quick-add row on top, one line per item, tap to check.
/// A checked item settles to the bottom and hides behind "Show 3 done". Long
/// press to remove. No header chrome. Nothing here is ever planned.
///
/// Mac branch likely: a hover-revealed "Remove" text button on each row in
/// place of the long press.
struct ListBody: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let workID: String
    let items: [WorkListEntry]

    @State private var draft = ""
    @State private var showsDone = false
    @State private var pendingIDs: Set<String> = []
    @State private var failed = false
    @State private var checks = 0
    @FocusState private var draftFocused: Bool

    private var ordered: [WorkListEntry] { WorkListOrdering.ordered(items) }
    private var open: [WorkListEntry] { ordered.filter { !$0.done } }
    private var done: [WorkListEntry] { ordered.filter(\.done) }
    private var visible: [WorkListEntry] { showsDone ? ordered : open }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            quickAddRow
            ForEach(visible) { item in
                listRow(item)
                    .transition(reduceMotion ? .opacity : .asymmetric(
                        insertion: .offset(y: 8).combined(with: .opacity),
                        removal: .opacity
                    ))
            }
            if let label = WorkListOrdering.showDoneLabel(count: done.count, showing: showsDone) {
                Button(label) {
                    withAnimation(WorkMotion.settle(reduceMotion: reduceMotion)) { showsDone.toggle() }
                }
                .buttonStyle(.plain)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .padding(.vertical, 12)
                .padding(.leading, 36)
                .frame(minHeight: 44, alignment: .leading)
                .accessibilityHint(showsDone ? "Hides the done items" : "Shows the done items")
            }
            if failed {
                Text("Could not save. Try again.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.top, 8)
                    .padding(.leading, 36)
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(WorkMotion.settle(reduceMotion: reduceMotion), value: visible.map(\.id))
        .modifier(ListHaptics(checks: checks))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(items.isEmpty ? "List, empty" : "List, \(open.count) open, \(done.count) done")
    }

    private var quickAddRow: some View {
        HStack(alignment: .center, spacing: 12) {
            Circle()
                .strokeBorder(environment.theme.hairlineColor, lineWidth: 1.5)
                .frame(width: 24, height: 24)
                .accessibilityHidden(true)
            TextField(items.isEmpty ? "Add the first item" : "Add an item", text: $draft)
                .textFieldStyle(.plain)
                .font(.body)
                .focused($draftFocused)
                .submitLabel(.done)
                .onSubmit { Task { await add() } }
                .accessibilityLabel("Add an item")
        }
        .frame(minHeight: 44)
    }

    private func listRow(_ item: WorkListEntry) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Button {
                Task { await toggle(item) }
            } label: {
                ZStack {
                    Circle()
                        .strokeBorder(
                            item.done ? environment.theme.accentColor : Color.secondary.opacity(0.55),
                            lineWidth: 1.5
                        )
                    if item.done {
                        Circle()
                            .fill(environment.theme.accentColor)
                            .padding(5)
                            .transition(.scale.combined(with: .opacity))
                    }
                }
                .frame(width: 24, height: 24)
                .contentShape(Circle().inset(by: -10))
            }
            .buttonStyle(.plain)
            .disabled(pendingIDs.contains(item.id))
            .accessibilityLabel(item.done ? "Mark not done" : "Mark done")
            .accessibilityValue(item.text)

            Text(item.text)
                .font(.body)
                .strikethrough(item.done)
                .foregroundStyle(item.done ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 10)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .contextMenu {
            Button("Remove", role: .destructive) { Task { await remove(item) } }
        }
        .accessibilityElement(children: .contain)
        .accessibilityAction(named: "Remove") { Task { await remove(item) } }
    }

    private func add() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        failed = false
        let ok = await WorkShapeWriter.addListItem(text, to: workID, current: items, environment: environment)
        if ok {
            draft = ""
            draftFocused = true
        } else {
            // The field keeps the text on failure.
            failed = true
        }
    }

    private func toggle(_ item: WorkListEntry) async {
        pendingIDs.insert(item.id)
        defer { pendingIDs.remove(item.id) }
        failed = false
        checks += 1
        let ok = await WorkShapeWriter.toggleListItem(item.id, in: workID, current: items, environment: environment)
        if !ok { failed = true }
    }

    private func remove(_ item: WorkListEntry) async {
        failed = false
        let ok = await WorkShapeWriter.removeListItem(item.id, from: workID, current: items, environment: environment)
        if !ok { failed = true }
    }
}

/// A light tick on each check. Silent on the Mac.
private struct ListHaptics: ViewModifier {
    let checks: Int

    func body(content: Content) -> some View {
        #if os(iOS)
        content.sensoryFeedback(.impact(weight: .light), trigger: checks)
        #else
        content
        #endif
    }
}
