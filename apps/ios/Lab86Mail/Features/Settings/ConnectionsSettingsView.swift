import SwiftUI

/// Names for connected source servers, so a server id never shows as text.
/// An Atlassian sign-in brings Jira issues and Confluence pages under the one
/// `jira` server, so a page reads as Confluence (as on the web).
enum ConnectedSourceNames {
    /// The product name for a server id.
    static func serverName(_ server: String) -> String {
        switch server.lowercased() {
        case "github": "GitHub"
        case "bitbucket": "Bitbucket"
        case "jira": "Jira"
        case "slack": "Slack"
        case "granola": "Granola"
        default: server.capitalized
        }
    }

    /// The name of a connected row: the label the status sent for its server,
    /// else the product name. An Atlassian sign-in covers Jira and Confluence.
    static func connectionName(server: String, authKind: String?, serverLabel: String?) -> String {
        if let label = serverLabel?.nilIfBlank { return label }
        if server.lowercased() == "jira", authKind == "oauth" { return "Atlassian" }
        return serverName(server)
    }

    /// The source name of one connected item.
    static func itemSourceName(server: String, kind: String?) -> String {
        if server.lowercased() == "jira", kind == "page" { return "Confluence" }
        return serverName(server)
    }

    /// The names the server saves as `displayName` when the user gives none,
    /// past and present. A display name equal to one of them is no nickname.
    static func defaultDisplayNames(_ server: String) -> [String] {
        server.lowercased() == "jira" ? ["Atlassian", "Jira", "Atlassian / Jira"] : []
    }

    /// Two names are the same when their letters and digits match.
    static func sameName(_ first: String, _ second: String) -> Bool {
        func key(_ value: String) -> String {
            String(value.lowercased().filter { $0.isASCII && ($0.isLetter || $0.isNumber) })
        }
        return key(first) == key(second)
    }
}

/// One server the user can connect, from `/api/mcp/status`. A server with
/// `connectMode` "oauth" signs in through the browser; "token" opens the
/// token form. An older server sends no `connectMode`, so it reads as token.
struct ConnectedSourceServer: Identifiable, Equatable {
    let id: String
    let label: String
    let tokenLabel: String
    let tokenHelp: String
    let connectMode: String
    // True when the user can connect several accounts, one sign-in for each
    // (a Slack workspace). An older server sends no `multipleAccounts`.
    let multipleAccounts: Bool

    init?(json row: JSONValue) {
        guard let id = row["id"]?.stringValue?.nilIfBlank else { return nil }
        self.id = id
        label = row["label"]?.stringValue?.nilIfBlank ?? ConnectedSourceNames.serverName(id)
        tokenLabel = row["tokenLabel"]?.stringValue ?? "Access token"
        tokenHelp = row["tokenHelp"]?.stringValue ?? ""
        connectMode = row["connectMode"]?.stringValue ?? "token"
        multipleAccounts = row["multipleAccounts"]?.boolValue ?? false
    }

    var signsInWithBrowser: Bool { connectMode == "oauth" }

    /// The quiet line under the server in "Add a source". Only a browser
    /// sign-in has one: a token server shows its help in the token form.
    var addNote: String? { signsInWithBrowser ? tokenHelp.nilIfBlank : nil }
}

/// One row in "Add a source". A server with a connection leaves the list,
/// but a server that allows several accounts stays. Its row then adds one
/// more account: "Add another Slack workspace".
struct ConnectedSourceAddRow: Identifiable, Equatable {
    let server: ConnectedSourceServer
    // True when the server has a connection and the row adds one more account.
    let addsAnother: Bool

    var id: String { server.id }

    var title: String {
        addsAnother ? "Add another \(server.label) workspace" : server.label
    }

    var note: String? {
        addsAnother ? "Sign in to one more workspace. Each workspace is its own connection." : server.addNote
    }

    /// The rows of "Add a source", in the order of the servers.
    static func rows(
        servers: [ConnectedSourceServer],
        connections: [ConnectedSourceConnection]
    ) -> [ConnectedSourceAddRow] {
        let connected = Set(connections.map(\.server))
        return servers.compactMap { server in
            let hasConnection = connected.contains(server.id)
            if hasConnection, !server.multipleAccounts { return nil }
            return ConnectedSourceAddRow(server: server, addsAnother: hasConnection)
        }
    }
}

/// One connected tool row from `/api/mcp/status` (AI-7). `status` says only
/// whether the saved sign-in works: `error` means the user must reconnect. A
/// failed or partial sync is `syncProblem`, a quiet note that retries by
/// itself. Every new field is optional, so an older server still decodes.
struct ConnectedSourceConnection: Identifiable, Equatable {
    let id: String
    let server: String
    let displayName: String?
    // "token" or "oauth". Nil from an older server.
    let authKind: String?
    // The signed-in account, after a sync. Atlassian sends its site names and
    // Bitbucket its workspace slugs in `workspaceName`, joined with ", ".
    let accountEmail: String?
    let workspaceName: String?
    let status: String
    let includeInBrief: Bool
    let includeInSearch: Bool
    let lastSyncedAt: Date?
    let itemCount: Int?
    let syncProblem: String?

    init?(json row: JSONValue) {
        guard let id = row["connectionId"]?.stringValue,
              let server = row["server"]?.stringValue else { return nil }
        self.id = id
        self.server = server
        displayName = row["displayName"]?.stringValue?.nilIfBlank
        authKind = row["authKind"]?.stringValue?.nilIfBlank
        accountEmail = row["accountEmail"]?.stringValue?.nilIfBlank
        workspaceName = row["workspaceName"]?.stringValue?.nilIfBlank
        status = row["status"]?.stringValue ?? "connected"
        includeInBrief = row["includeInBrief"]?.boolValue ?? true
        includeInSearch = row["includeInSearch"]?.boolValue ?? true
        lastSyncedAt = CalendarDateParser.date(row["lastSyncedAt"])
        itemCount = row["itemCount"]?.doubleValue.map(Int.init)
        // An older server has no lastSyncError; its sync-state error still counts.
        let legacyProblem = row["syncStatus"]?.stringValue == "error" ? row["syncError"]?.stringValue : nil
        syncProblem = status == "error"
            ? nil
            : (row["lastSyncError"]?.stringValue ?? legacyProblem)?
                .trimmingCharacters(in: CharacterSet(charactersIn: ". \n"))
                .nilIfBlank
    }

    /// Only a failed sign-in asks for Reconnect.
    var needsReconnect: Bool { status == "error" }

    /// The tool name, never the server id: "Atlassian", "GitHub".
    func sourceName(serverLabel: String?) -> String {
        ConnectedSourceNames.connectionName(server: server, authKind: authKind, serverLabel: serverLabel)
    }

    /// The user's own name for the connection, or nil when the saved display
    /// name only repeats a tool name (the server saves one by default).
    func nickname(serverLabel: String?) -> String? {
        guard let displayName else { return nil }
        let defaults = [sourceName(serverLabel: serverLabel), ConnectedSourceNames.serverName(server)]
            + ConnectedSourceNames.defaultDisplayNames(server)
        let repeatsToolName = defaults.contains(where: { ConnectedSourceNames.sameName($0, displayName) })
        return repeatsToolName ? nil : displayName
    }

    /// "Acme · ann@example.com" under the title, or nil before the first
    /// sync and from an older server. The workspace comes first, so two
    /// Slack rows show different names on this line.
    var identityText: String? {
        var parts: [String] = []
        for part in [workspaceName, accountEmail].compactMap({ $0 }) where !parts.contains(part) {
            parts.append(part)
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// "Disconnect Slack (Acme)?": the workspace tells two Slack rows apart.
    func disconnectTitle(serverLabel: String?) -> String {
        let name = sourceName(serverLabel: serverLabel)
        guard let workspaceName else { return "Disconnect \(name)?" }
        return "Disconnect \(name) (\(workspaceName))?"
    }

    var statusText: String {
        if needsReconnect { return "Reconnect needed. The saved sign-in no longer works." }
        var pieces = ["Connected"]
        if let date = lastSyncedAt {
            pieces.append("synced \(date.formatted(.relative(presentation: .named)))")
        }
        if let itemCount { pieces.append("\(itemCount.formatted()) items") }
        return pieces.joined(separator: " · ")
    }

    /// The quiet note under a working connection whose last sync had a problem.
    var syncProblemText: String? {
        syncProblem.map { "Last sync had a problem: \($0). It will try again." }
    }
}

struct ConnectionsSettingsView: View {
    @Environment(AppEnvironment.self) private var environment

    private typealias Connection = ConnectedSourceConnection
    private typealias Server = ConnectedSourceServer

    @State private var connections: [Connection] = []
    @State private var servers: [Server] = []
    @State private var isLoading = true
    @State private var busyID: String?
    @State private var errorMessage: String?
    @State private var tokenServer: Server?
    @State private var token = ""
    @State private var displayName = ""
    @State private var disconnectTarget: Connection?

    var body: some View {
        List {
            Section {
                if isLoading, connections.isEmpty {
                    HStack { ProgressView(); Text("Loading connections…") }
                } else if connections.isEmpty {
                    ContentUnavailableView(
                        "No connected sources",
                        systemImage: "link",
                        description: Text("Add a source below for Brief, Areas, and search.")
                    )
                } else {
                    ForEach(connections) { connection in
                        connectionRow(connection)
                    }
                }
            } header: {
                Text("Connected sources")
            }

            Section("Add a source") {
                ForEach(addRows) { row in
                    Button {
                        startConnect(row.server)
                    } label: {
                        addSourceRow(row)
                    }
                    #if os(macOS)
                    // A Mac button in a list row draws a bordered push button.
                    .buttonStyle(.plain)
                    #endif
                    .disabled(busyID != nil)
                    .accessibilityHint(connectHint(row.server))
                }
            }

            if let errorMessage {
                Section {
                    Label(errorMessage, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(.red)
                    Button("Try again") { Task { await load() } }
                }
            }
        }
        .navigationTitle("Connections")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
        .sheet(item: $tokenServer) { server in
            NavigationStack {
                Form {
                    Section {
                        SecureField(server.tokenLabel, text: $token)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        TextField("Display name (optional)", text: $displayName)
                    } footer: {
                        Text(server.tokenHelp)
                    }
                    if let errorMessage {
                        Text(errorMessage).font(.footnote).foregroundStyle(.red)
                    }
                }
                .navigationTitle("Connect \(server.label)")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { tokenServer = nil }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Connect") { Task { await connectToken(server) } }
                            .disabled(token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || busyID != nil)
                    }
                }
            }
            .presentationDetents([.medium, .large])
        }
        .confirmationDialog(
            disconnectTitle,
            isPresented: Binding(
                get: { disconnectTarget != nil },
                set: { if !$0 { disconnectTarget = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Disconnect", role: .destructive) {
                guard let target = disconnectTarget else { return }
                disconnectTarget = nil
                Task { await disconnect(target) }
            }
            Button("Cancel", role: .cancel) { disconnectTarget = nil }
        } message: {
            Text("Indexed source data is detached from Albatross; the external service is not modified.")
        }
    }

    // A connected server leaves "Add a source", except a server that allows
    // several accounts: its row adds one more workspace.
    private var addRows: [ConnectedSourceAddRow] {
        ConnectedSourceAddRow.rows(servers: servers, connections: connections)
    }

    private func serverLabel(for connection: Connection) -> String? {
        servers.first(where: { $0.id == connection.server })?.label
    }

    private var disconnectTitle: String {
        guard let target = disconnectTarget else { return "Disconnect source?" }
        return target.disconnectTitle(serverLabel: serverLabel(for: target))
    }

    private func connectHint(_ server: Server) -> String {
        server.signsInWithBrowser ? "Opens the \(server.label) sign-in page." : "Asks for an access token."
    }

    // The source name (or "Add another Slack workspace"), the sign-in help
    // for a browser sign-in, and a quiet Connect at the trailing edge.
    private func addSourceRow(_ row: ConnectedSourceAddRow) -> some View {
        let server = row.server
        return HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(row.title)
                    .foregroundStyle(Color.primary)
                if let note = row.note {
                    Text(note)
                        .font(.caption)
                        .foregroundStyle(Color.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 8)
            if busyID == "server:\(server.id)" {
                ProgressView().controlSize(.small)
            } else {
                Text("Connect")
                    .font(.subheadline)
                    .foregroundStyle(.tint)
                    .opacity(busyID == nil ? 1 : 0.5)
            }
        }
        .contentShape(Rectangle())
    }

    private func connectionRow(_ connection: Connection) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    // The tool name, then the user's own name when it differs.
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        Text(connection.sourceName(serverLabel: serverLabel(for: connection)))
                            .font(.headline)
                        if let nickname = connection.nickname(serverLabel: serverLabel(for: connection)) {
                            Text(verbatim: "· \(nickname)")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                    if let identity = connection.identityText {
                        Text(identity)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                    Text(connection.statusText)
                        .font(.caption)
                        .foregroundStyle(connection.needsReconnect ? .red : .secondary)
                    if let note = connection.syncProblemText {
                        Text(note)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
                Spacer()
                if connection.needsReconnect, let server = servers.first(where: { $0.id == connection.server }) {
                    Button("Reconnect") { startConnect(server) }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .disabled(busyID != nil)
                }
                Menu {
                    Button("Resync", systemImage: "arrow.clockwise") {
                        Task { await resync(connection) }
                    }
                    Button("Disconnect", systemImage: "trash", role: .destructive) {
                        disconnectTarget = connection
                    }
                } label: {
                    if busyID == connection.id {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "ellipsis.circle")
                    }
                }
                .disabled(busyID != nil)
            }
            Toggle(
                "Include in Daily Report",
                isOn: toggleBinding(connection, key: "includeInBrief", value: connection.includeInBrief)
            )
            Toggle(
                "Include in search",
                isOn: toggleBinding(connection, key: "includeInSearch", value: connection.includeInSearch)
            )
        }
        .padding(.vertical, 4)
    }

    private func toggleBinding(_ connection: Connection, key: String, value: Bool) -> Binding<Bool> {
        Binding(
            get: { connections.first(where: { $0.id == connection.id }).map {
                key == "includeInBrief" ? $0.includeInBrief : $0.includeInSearch
            } ?? value },
            set: { next in Task { await toggle(connection, key: key, value: next) } }
        )
    }

    private func load() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let result = try await environment.backend.get(path: "/api/mcp/status")
            connections = (result["connections"]?.arrayValue ?? []).compactMap(Connection.init(json:))
            servers = (result["servers"]?.arrayValue ?? []).compactMap(Server.init(json:))
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // Starts a sign-in. For a server whose connection needs a reconnect, the
    // server replaces that broken connection in place.
    private func startConnect(_ server: Server) {
        if server.signsInWithBrowser {
            Task { await connectOAuth(server) }
        } else {
            token = ""
            displayName = ""
            tokenServer = server
        }
    }

    private func connectOAuth(_ server: Server) async {
        busyID = "server:\(server.id)"
        defer { busyID = nil }
        do {
            try await environment.webAuthentication.connectOAuthSource(server: server.id)
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func connectToken(_ server: Server) async {
        busyID = "server:\(server.id)"
        errorMessage = nil
        defer { busyID = nil }
        do {
            let result = try await environment.backend.post(
                path: "/api/mcp/connect",
                body: .object([
                    "server": .string(server.id),
                    "token": .string(token.trimmingCharacters(in: .whitespacesAndNewlines)),
                    "displayName": .string(displayName.trimmingCharacters(in: .whitespacesAndNewlines)),
                ])
            )
            if result["validation"]?["ok"]?.boolValue == false {
                throw BackendError.server(
                    status: 502,
                    message: result["validation"]?["error"]?.stringValue ?? "The source rejected that token."
                )
            }
            tokenServer = nil
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func resync(_ connection: Connection) async {
        busyID = connection.id
        defer { busyID = nil }
        do {
            let result = try await environment.backend.post(
                path: "/api/mcp/resync",
                body: .object(["connectionId": .string(connection.id)])
            )
            if result["result"]?["ok"]?.boolValue == false {
                throw BackendError.server(
                    status: 502,
                    message: result["result"]?["error"]?.stringValue ?? "Resync failed."
                )
            }
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func disconnect(_ connection: Connection) async {
        busyID = connection.id
        defer { busyID = nil }
        do {
            _ = try await environment.backend.post(
                path: "/api/mcp/disconnect",
                body: .object(["connectionId": .string(connection.id)])
            )
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func toggle(_ connection: Connection, key: String, value: Bool) async {
        busyID = connection.id
        defer { busyID = nil }
        do {
            _ = try await environment.backend.post(
                path: "/api/mcp/toggle",
                body: .object([
                    "connectionId": .string(connection.id),
                    key: .bool(value),
                ])
            )
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
