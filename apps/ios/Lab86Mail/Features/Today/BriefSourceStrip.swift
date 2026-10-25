import SwiftUI

/// The lines under the Today masthead (round 2, FEATURES items 2 and 18):
/// notes about the edition itself, the trial note in its last days, a
/// Reconnect row for each source that needs the user, and one quiet line
/// that counts the other sources with their last sync. A tap on that line
/// lists each source. A broken source must never read as a calm day, so the
/// problems come first and stay in red.
struct BriefSourceStrip: View {
    @Environment(AppEnvironment.self) private var environment
    let health: BriefSourceHealth?
    let notes: [String]
    let trialNote: String?

    @State private var reconnectingID: String?
    @State private var showsConnections = false
    @State private var showsSources = false
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
                    if let line = BriefSourceSummary.line(health, now: .now) {
                        summaryLine(line)
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
                #if os(macOS)
                .macFormSheet()
                #endif
            }
            .sheet(isPresented: $showsSources) {
                if let health {
                    BriefSourcesSheet(health: health)
                        #if os(macOS)
                        .macFormSheet()
                        #endif
                }
            }
        }
    }

    // Machine narration, in the display italic. The whole line is the tap
    // target; the sheet carries the addresses and the exact times.
    private func summaryLine(_ line: String) -> some View {
        Button {
            showsSources = true
        } label: {
            Text(line)
                .font(environment.theme.displayType.displayItalicFont(size: 15))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("Shows each source and when it last synced.")
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
            // A mail or calendar source id is "<kind>:<accountId>". An id of
            // another form names no account, so the flow adds a new one.
            let accountId = BriefSource.reconnectAccountID(fromSourceID: source.id)
            try await environment.webAuthentication.connectMailbox(provider: source.provider, accountId: accountId)
            await environment.store.refreshMail()
            await environment.store.refreshBriefSources()
        } catch {
            guard !error.isCancellation else { return }
            reconnectError = error.localizedDescription
        }
    }
}

/// The one-line summary of the healthy sources. Addresses and per-source
/// times belong in the sheet, not on the page.
enum BriefSourceSummary {
    /// "3 sources synced 8 minutes ago", "1 source, still syncing", or the
    /// server's own line when it names no sources. Nil when there is nothing
    /// healthy to count: the problem rows say the rest.
    static func line(_ health: BriefSourceHealth, now: Date) -> String? {
        let synced = health.others
        guard !synced.isEmpty else {
            return health.line.isEmpty ? nil : health.line
        }
        let count = synced.count == 1 ? "1 source" : "\(synced.count) sources"
        let pending = synced.filter { $0.lastSyncedAt == nil }.count
        if pending == synced.count { return "\(count), still syncing" }
        if pending > 0 { return "\(count), \(pending) still syncing" }
        // The oldest sync is the honest one for the whole set.
        guard let oldest = synced.compactMap(\.lastSyncedAt).min() else { return count }
        return "\(count) synced \(ago(oldest, now: now))"
    }

    /// "just now", "8 minutes ago", "1 hour ago", "yesterday", "3 days ago".
    static func ago(_ at: Date, now: Date) -> String {
        let diff = max(0, now.timeIntervalSince(at))
        if diff < 60 { return "just now" }
        let minutes = Int((diff / 60).rounded())
        if minutes < 60 { return minutes == 1 ? "1 minute ago" : "\(minutes) minutes ago" }
        let hours = Int((Double(minutes) / 60).rounded())
        if hours < 24 { return hours == 1 ? "1 hour ago" : "\(hours) hours ago" }
        let days = Int((Double(hours) / 24).rounded())
        return days == 1 ? "yesterday" : "\(days) days ago"
    }

    /// "synced 4 min ago" as a row line: "Synced 4 min ago".
    static func sentence(_ line: String) -> String {
        guard let first = line.first else { return line }
        return first.uppercased() + line.dropFirst()
    }
}

/// Each source with its last sync. Read-only: the Reconnect rows live on the
/// page under the plate, where a problem must stay visible.
private struct BriefSourcesSheet: View {
    @Environment(\.dismiss) private var dismiss
    let health: BriefSourceHealth

    var body: some View {
        NavigationStack {
            List {
                if !health.problems.isEmpty {
                    Section("Needs you") {
                        ForEach(health.problems) { source in
                            row(title: source.displayName, line: source.problemLine, warns: true)
                        }
                    }
                }
                if !health.others.isEmpty {
                    Section("Synced") {
                        ForEach(health.others) { source in
                            row(
                                title: source.displayName,
                                line: BriefSourceSummary.sentence(source.syncLine(now: .now)),
                                warns: false
                            )
                        }
                    }
                }
            }
            .navigationTitle("Sources")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private func row(title: String, line: String, warns: Bool) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title)
                .font(.body)
                .foregroundStyle(.primary)
            Text(line)
                .font(.footnote)
                .foregroundStyle(warns ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }
}
