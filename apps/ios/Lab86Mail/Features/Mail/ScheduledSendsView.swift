import SwiftUI

/// Mail that waits to send, across every connected mailbox, each with
/// Cancel. The web's Scheduled dialog, as a sheet.
struct ScheduledSendsView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss
    @State private var model = ScheduledSendsModel()

    private var client: ScheduledSendsClient {
        ScheduledSendsClient(tools: environment.tools)
    }

    private var showsAccount: Bool {
        environment.store.accounts.count > 1
    }

    var body: some View {
        NavigationStack {
            List {
                content
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(environment.theme.elevatedColor)
            .navigationTitle("Scheduled")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task { await load() }
            .refreshable { await load() }
        }
        .presentationBackground(environment.theme.elevatedColor)
        #if os(macOS)
        .frame(minWidth: 420, minHeight: 440)
        #endif
    }

    @ViewBuilder private var content: some View {
        switch model.phase {
        case .loading:
            HStack {
                Spacer()
                ProgressView("Loading scheduled sends…")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Spacer()
            }
            .padding(.vertical, 32)
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
        case .failed:
            ContentUnavailableView {
                Label("Could not load scheduled sends", systemImage: "exclamationmark.triangle")
            } description: {
                Text("The mail server did not answer. Try again in a minute.")
            } actions: {
                Button("Try Again") { Task { await load() } }
            }
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
        case .loaded:
            if model.rows.isEmpty {
                emptyState
            } else {
                Section {
                    ForEach(model.rows) { row in
                        scheduledRow(row)
                    }
                } footer: {
                    footer
                }
            }
        }
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Nothing is scheduled")
                .font(environment.theme.displayType.displayFont(size: 22))
            Text("Choose a send time in the composer, and the message waits here until then.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if !model.failedAccounts.isEmpty {
                failedAccountsText
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 4)
        .padding(.top, 32)
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
    }

    @ViewBuilder private var footer: some View {
        VStack(alignment: .leading, spacing: 4) {
            if !model.failedAccounts.isEmpty {
                failedAccountsText
            }
            if let cancelError = model.cancelError {
                Text(cancelError)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var failedAccountsText: some View {
        Text("Could not read \(model.failedAccounts.joined(separator: ", ")).")
            .font(.footnote)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func scheduledRow(_ row: ScheduledSendRow) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(row.sendLine())
                    .font(.body)
                if showsAccount {
                    Text(row.accountLabel)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            Button(model.cancellingID == row.id ? "Cancelling…" : "Cancel", role: .destructive) {
                Task { await model.cancel(row, client: client) }
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(model.cancellingID != nil)
            .accessibilityHint("Stops this send.")
        }
        .padding(.vertical, 4)
        .listRowBackground(Color.clear)
        .accessibilityElement(children: .combine)
    }

    private func load() async {
        await model.load(accounts: environment.store.accounts, client: client)
    }
}
