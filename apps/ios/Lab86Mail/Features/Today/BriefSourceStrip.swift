import SwiftUI

/// The lines under the Today masthead (round 2, FEATURES items 2 and 18):
/// notes about the edition itself, the trial note in its last days, a
/// Reconnect row for each source that needs the user, and one quiet line
/// that names the other sources with their last sync. A broken source must
/// never read as a calm day, so the problems come first.
struct BriefSourceStrip: View {
    @Environment(AppEnvironment.self) private var environment
    let health: BriefSourceHealth?
    let notes: [String]
    let trialNote: String?

    @State private var reconnectingID: String?
    @State private var showsConnections = false
    @State private var reconnectError: String?

    var hasContent: Bool {
        !notes.isEmpty || trialNote != nil || !(health?.sources.isEmpty ?? true)
            || !(health?.line.isEmpty ?? true)
    }

    var body: some View {
        if hasContent {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(notes, id: \.self) { note in
                    Text(note)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let trialNote {
                    Text(trialNote)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let health {
                    ForEach(health.problems) { source in
                        problemRow(source)
                    }
                    if let line = health.sourcesLine(now: .now) {
                        Text(line)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    } else if health.sources.isEmpty, !health.line.isEmpty {
                        Text(health.line)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                if let reconnectError {
                    Text(reconnectError)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20)
            .padding(.top, 12)
            .sheet(isPresented: $showsConnections) {
                NavigationStack {
                    ConnectionsSettingsView()
                        .toolbar {
                            ToolbarItem(placement: .confirmationAction) {
                                Button("Done") { showsConnections = false }
                            }
                        }
                }
            }
        }
    }

    private func problemRow(_ source: BriefSource) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(source.problemLine)
                .font(.footnote)
                .foregroundStyle(.red)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            if source.status == .reconnect || source.reconnectPath != nil {
                Button(reconnectingID == source.id ? "Reconnecting…" : "Reconnect") {
                    Task { await reconnect(source) }
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(reconnectingID != nil)
            }
        }
        .accessibilityElement(children: .combine)
    }

    // A mailbox or calendar signs in again in place; a connected tool opens
    // its settings, where each tool has its own sign-in.
    private func reconnect(_ source: BriefSource) async {
        reconnectError = nil
        guard source.kind != .connector else {
            showsConnections = true
            return
        }
        reconnectingID = source.id
        defer { reconnectingID = nil }
        do {
            try await environment.webAuthentication.connectMailbox(provider: source.provider)
            await environment.store.refreshMail()
            await environment.store.refreshBriefSources()
        } catch {
            reconnectError = error.localizedDescription
        }
    }
}
