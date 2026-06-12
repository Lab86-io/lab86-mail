import SwiftUI

struct MainWindow: View {
    @Environment(MailStore.self) private var store
    @State private var searchText = ""

    var body: some View {
        @Bindable var store = store
        NavigationSplitView {
            RailView()
                .navigationSplitViewColumnWidth(min: 200, ideal: 240, max: 320)
        } content: {
            ThreadListView()
                .navigationSplitViewColumnWidth(min: 320, ideal: 400, max: 560)
                .searchable(text: $searchText, placement: .toolbar, prompt: "Search mail")
                .onSubmit(of: .search) {
                    let text = searchText.trimmingCharacters(in: .whitespaces)
                    store.scope = text.isEmpty ? .inbox : .search(text)
                }
        } detail: {
            ThreadReaderView()
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
