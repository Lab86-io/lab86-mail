import SwiftUI

struct MainWindow: View {
    @Environment(MailStore.self) private var store
    @State private var searchText = ""

    var body: some View {
        @Bindable var store = store
        NavigationSplitView {
            RailView()
                .navigationSplitViewColumnWidth(min: 200, ideal: 240, max: 320)
        } detail: {
            // Web-app behavior: the inbox owns the full width until a thread
            // is opened; the reader then slides in beside it.
            HStack(spacing: 0) {
                ThreadListView()
                    .frame(
                        minWidth: store.selectedThreadKey == nil ? nil : 340,
                        maxWidth: store.selectedThreadKey == nil ? .infinity : 420
                    )
                if store.selectedThreadKey != nil {
                    Divider()
                    ThreadReaderView()
                        .frame(maxWidth: .infinity)
                        .transition(.move(edge: .trailing).combined(with: .opacity))
                }
            }
            .animation(.snappy(duration: 0.25), value: store.selectedThreadKey == nil)
            .searchable(text: $searchText, placement: .toolbar, prompt: "Search mail")
            .onSubmit(of: .search) {
                let text = searchText.trimmingCharacters(in: .whitespaces)
                store.scope = text.isEmpty ? .inbox : .search(text)
            }
        }
        .navigationTitle(store.scope.title)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    store.composePresented = true
                } label: {
                    Label("Compose", systemImage: "square.and.pencil")
                }
                .buttonStyle(.glassProminent)
                .help("New message (⌘N)")
            }
        }
        .sheet(isPresented: $store.composePresented) {
            ComposeView()
        }
        .alert(
            "Something went wrong",
            isPresented: Binding(
                get: { store.lastError != nil },
                set: { if !$0 { store.lastError = nil } }
            )
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(store.lastError ?? "")
        }
    }
}
