import Foundation
import Testing
@testable import Lab86Mail

// Browser sign-in for Atlassian, Bitbucket, and Slack (2026-10-09): a
// connected row shows its signed-in account, a server id never shows as
// text, and a Confluence page under the `jira` server reads as Confluence.
@MainActor
struct ConnectedSourceIdentityTests {
    @Test
    func aSignedInRowReadsItsAccountIdentity() throws {
        let row = try #require(ConnectedSourceConnection(json: .object([
            "connectionId": .string("jira_1"), "server": .string("jira"), "authKind": .string("oauth"),
            "status": .string("connected"), "displayName": .string("Atlassian"),
            "accountEmail": .string("ann@example.com"), "workspaceName": .string("Acme, Beta"),
        ])))
        #expect(row.authKind == "oauth")
        #expect(row.accountEmail == "ann@example.com")
        #expect(row.workspaceName == "Acme, Beta")
        #expect(row.identityText == "Acme, Beta · ann@example.com")
        #expect(row.sourceName(serverLabel: "Atlassian") == "Atlassian")
        // The default display name is no nickname.
        #expect(row.nickname(serverLabel: "Atlassian") == nil)
    }

    @Test
    func theIdentityLineShowsOnlyTheFieldsThatArrive() throws {
        let slack = try #require(ConnectedSourceConnection(json: .object([
            "connectionId": .string("slack_1"), "server": .string("slack"), "authKind": .string("oauth"),
            "workspaceName": .string("Acme"), "accountEmail": .string("  "),
        ])))
        #expect(slack.accountEmail == nil)
        #expect(slack.identityText == "Acme")

        let email = try #require(ConnectedSourceConnection(json: .object([
            "connectionId": .string("granola_1"), "server": .string("granola"),
            "accountEmail": .string("ann@example.com"), "workspaceName": .null,
        ])))
        #expect(email.workspaceName == nil)
        #expect(email.identityText == "ann@example.com")

        // The same value in both fields shows once.
        let same = try #require(ConnectedSourceConnection(json: .object([
            "connectionId": .string("granola_2"), "server": .string("granola"),
            "accountEmail": .string("ann@example.com"), "workspaceName": .string("ann@example.com"),
        ])))
        #expect(same.identityText == "ann@example.com")
    }

    @Test
    func aRowFromAnOlderServerDecodesWithoutIdentity() throws {
        let row = try #require(ConnectedSourceConnection(json: .object([
            "connectionId": .string("github_1"), "server": .string("github"), "status": .string("connected"),
        ])))
        #expect(row.authKind == nil)
        #expect(row.accountEmail == nil)
        #expect(row.workspaceName == nil)
        #expect(row.identityText == nil)
        #expect(row.sourceName(serverLabel: nil) == "GitHub")
        #expect(row.nickname(serverLabel: nil) == nil)
    }

    @Test
    func aConnectedRowNeverShowsARawServerID() {
        func name(_ server: String, _ authKind: String? = nil, label: String? = nil) -> String {
            ConnectedSourceNames.connectionName(server: server, authKind: authKind, serverLabel: label)
        }
        #expect(name("jira", "oauth") == "Atlassian")
        #expect(name("jira", "token") == "Jira")
        #expect(name("jira") == "Jira")
        #expect(name("github") == "GitHub")
        #expect(name("bitbucket", "oauth") == "Bitbucket")
        #expect(name("slack", "oauth") == "Slack")
        #expect(name("granola", "oauth") == "Granola")
        #expect(name("linear") == "Linear")
        // The label from the status wins, and a blank label falls back.
        #expect(name("jira", "token", label: "Atlassian / Jira") == "Atlassian / Jira")
        #expect(name("jira", "oauth", label: " ") == "Atlassian")
    }

    @Test
    func aDisplayNameIsANicknameOnlyWhenItIsNotAToolName() throws {
        let named = try #require(ConnectedSourceConnection(json: .object([
            "connectionId": .string("github_2"), "server": .string("github"), "displayName": .string("Work"),
        ])))
        #expect(named.sourceName(serverLabel: "GitHub") == "GitHub")
        #expect(named.nickname(serverLabel: "GitHub") == "Work")

        // An Atlassian token row saved before the browser sign-in keeps the
        // old default name, which is no nickname under the new label.
        let legacy = try #require(ConnectedSourceConnection(json: .object([
            "connectionId": .string("jira_2"), "server": .string("jira"), "authKind": .string("token"),
            "displayName": .string("Atlassian / Jira"),
        ])))
        #expect(legacy.sourceName(serverLabel: "Atlassian") == "Atlassian")
        #expect(legacy.nickname(serverLabel: "Atlassian") == nil)
        #expect(legacy.nickname(serverLabel: nil) == nil)

        let github = try #require(ConnectedSourceConnection(json: .object([
            "connectionId": .string("github_3"), "server": .string("github"), "displayName": .string("github"),
        ])))
        #expect(github.nickname(serverLabel: nil) == nil)
    }

    @Test
    func aJiraPageReadsAsConfluence() {
        #expect(ConnectedSourceNames.itemSourceName(server: "jira", kind: "page") == "Confluence")
        #expect(ConnectedSourceNames.itemSourceName(server: "jira", kind: "ticket") == "Jira")
        #expect(ConnectedSourceNames.itemSourceName(server: "jira", kind: nil) == "Jira")
        #expect(ConnectedSourceNames.itemSourceName(server: "github", kind: "page") == "GitHub")
        #expect(ConnectedSourceNames.itemSourceName(server: "slack", kind: "message") == "Slack")

        // The Brief footer names Confluence as its own service.
        let counts = DailyReportModel.SectionCounts(
            replyOwed: 0, followUpOwed: 0, newPeople: 0, timeSensitive: 0,
            tracked: 0, fyi: 0, tasks: 0, calendar: 0
        )
        let marks = DailyBriefServices.derive(serviceIDs: ["jira", "confluence"], sectionCounts: counts)
        #expect(marks.map(\.label) == ["Jira", "Confluence"])
        #expect(marks.last?.symbol == "doc.text")
    }

    @Test
    func aServerSaysHowItConnects() throws {
        let help = "Sign in with Atlassian to add your Jira issues and the Confluence pages that you work on."
        let atlassian = try #require(ConnectedSourceServer(json: .object([
            "id": .string("jira"), "label": .string("Atlassian"), "tokenLabel": .string("Atlassian sign-in"),
            "tokenHelp": .string(help), "connectMode": .string("oauth"),
        ])))
        #expect(atlassian.signsInWithBrowser)
        #expect(atlassian.addNote == help)

        let token = try #require(ConnectedSourceServer(json: .object([
            "id": .string("jira"), "label": .string("Atlassian / Jira"), "tokenLabel": .string("Atlassian token"),
            "tokenHelp": .string("Paste email:api_token for an Atlassian API token."),
            "connectMode": .string("token"),
        ])))
        #expect(!token.signsInWithBrowser)
        #expect(token.addNote == nil)
        #expect(token.tokenHelp == "Paste email:api_token for an Atlassian API token.")

        // An older server sends only the id.
        let older = try #require(ConnectedSourceServer(json: .object(["id": .string("github")])))
        #expect(older.label == "GitHub")
        #expect(older.connectMode == "token")
        #expect(older.tokenLabel == "Access token")
        #expect(older.addNote == nil)

        #expect(ConnectedSourceServer(json: .object(["label": .string("Slack")])) == nil)
    }

    // Several Slack workspaces (2026-10-09): one sign-in for each workspace,
    // and each workspace is its own connection.

    private static let slackHelp =
        "Sign in with Slack to search your channels and direct messages. Add each workspace that you use."

    private func server(_ id: String, multipleAccounts: JSONValue? = nil) throws -> ConnectedSourceServer {
        var row: [String: JSONValue] = [
            "id": .string(id), "label": .string(ConnectedSourceNames.serverName(id)),
            "tokenHelp": .string(id == "slack" ? Self.slackHelp : ""),
            "connectMode": .string(id == "github" ? "token" : "oauth"),
        ]
        if let multipleAccounts { row["multipleAccounts"] = multipleAccounts }
        return try #require(ConnectedSourceServer(json: .object(row)))
    }

    private func connection(
        _ id: String, server: String, status: String = "connected", workspace: String? = nil
    ) throws -> ConnectedSourceConnection {
        var row: [String: JSONValue] = [
            "connectionId": .string(id), "server": .string(server), "authKind": .string("oauth"),
            "status": .string(status), "displayName": .string(ConnectedSourceNames.serverName(server)),
        ]
        if let workspace { row["workspaceName"] = .string(workspace) }
        return try #require(ConnectedSourceConnection(json: .object(row)))
    }

    @Test
    func aServerSaysWhetherItAllowsSeveralAccounts() throws {
        let several = try server("slack", multipleAccounts: .bool(true))
        let one = try server("slack", multipleAccounts: .bool(false))
        #expect(several.multipleAccounts)
        #expect(!one.multipleAccounts)
        // An older server sends no field, and a wrong type reads as false.
        let absent = try server("slack")
        let nullValue = try server("slack", multipleAccounts: .null)
        let text = try server("slack", multipleAccounts: .string("true"))
        #expect(!absent.multipleAccounts)
        #expect(!nullValue.multipleAccounts)
        #expect(!text.multipleAccounts)
        let older = try #require(ConnectedSourceServer(json: .object(["id": .string("jira")])))
        #expect(!older.multipleAccounts)
    }

    @Test
    func withNoConnectionEveryServerIsAPlainAddRow() throws {
        let servers = try [
            server("github"), server("jira"), server("slack", multipleAccounts: .bool(true)),
        ]
        let rows = ConnectedSourceAddRow.rows(servers: servers, connections: [])
        #expect(rows.map(\.id) == ["github", "jira", "slack"])
        #expect(rows.allSatisfy { !$0.addsAnother })

        // With no connection, the Slack row is unchanged: its label and help.
        let slack = try #require(rows.last)
        #expect(slack.title == "Slack")
        #expect(slack.note == Self.slackHelp)
        // A token server keeps its help for the token form.
        #expect(rows.first?.title == "GitHub")
        #expect(rows.first?.note == nil)
    }

    @Test
    func aConnectedSlackStaysToAddAnotherWorkspace() throws {
        let servers = try [
            server("github"), server("jira"), server("slack", multipleAccounts: .bool(true)),
        ]
        let connections = try [
            connection("github_1", server: "github"),
            connection("slack_t1u1", server: "slack", workspace: "Acme"),
        ]
        let rows = ConnectedSourceAddRow.rows(servers: servers, connections: connections)
        // GitHub leaves the list. Slack stays to add one more workspace.
        #expect(rows.map(\.id) == ["jira", "slack"])
        #expect(rows.map(\.addsAnother) == [false, true])

        let slack = try #require(rows.last)
        #expect(slack.server.signsInWithBrowser)
        #expect(slack.title == "Add another Slack workspace")
        #expect(slack.note == "Sign in to one more workspace. Each workspace is its own connection.")

        // Two Slack connections keep the one add row.
        let more = try connections + [connection("slack_t2u1", server: "slack", workspace: "Beta")]
        #expect(ConnectedSourceAddRow.rows(servers: servers, connections: more).map(\.id) == ["jira", "slack"])

        // A Slack connection that needs a reconnect still counts as a connection.
        let broken = try [connection("slack_t1u1", server: "slack", status: "error", workspace: "Acme")]
        let brokenRows = ConnectedSourceAddRow.rows(servers: servers, connections: broken)
        #expect(brokenRows.last?.title == "Add another Slack workspace")
    }

    @Test
    func aServerWithOneAccountLeavesTheListOnceConnected() throws {
        // An older server sends no `multipleAccounts`, so a connected Slack leaves the list.
        let servers = try [server("jira"), server("slack")]
        let connections = try [
            connection("jira_1", server: "jira", workspace: "Acme"),
            connection("slack_1", server: "slack", workspace: "Acme"),
        ]
        #expect(ConnectedSourceAddRow.rows(servers: servers, connections: connections).isEmpty)
    }

    @Test
    func theAddAnotherTitleUsesTheServerLabel() throws {
        let team = try #require(ConnectedSourceServer(json: .object([
            "id": .string("teams"), "label": .string("Teams"), "connectMode": .string("oauth"),
            "tokenHelp": .string("Sign in with Teams."), "multipleAccounts": .bool(true),
        ])))
        let first = ConnectedSourceAddRow(server: team, addsAnother: false)
        #expect(first.title == "Teams")
        #expect(first.note == "Sign in with Teams.")
        let another = ConnectedSourceAddRow(server: team, addsAnother: true)
        #expect(another.title == "Add another Teams workspace")
        #expect(another.note == "Sign in to one more workspace. Each workspace is its own connection.")
    }

    @Test
    func twoSlackRowsAreToldApartByTheirWorkspace() throws {
        let acme = try connection("slack_t1u1", server: "slack", workspace: "Acme")
        let beta = try connection("slack_t2u1", server: "slack", workspace: "Beta")
        // Both rows have the same title and no nickname, so the identity line tells them apart.
        #expect(acme.sourceName(serverLabel: "Slack") == beta.sourceName(serverLabel: "Slack"))
        #expect(acme.nickname(serverLabel: "Slack") == nil)
        #expect(beta.nickname(serverLabel: "Slack") == nil)
        #expect(acme.identityText == "Acme")
        #expect(beta.identityText == "Beta")
        #expect(acme.identityText != beta.identityText)

        // The disconnect question names the workspace too.
        #expect(acme.disconnectTitle(serverLabel: "Slack") == "Disconnect Slack (Acme)?")
        #expect(beta.disconnectTitle(serverLabel: "Slack") == "Disconnect Slack (Beta)?")
        let github = try connection("github_1", server: "github")
        #expect(github.disconnectTitle(serverLabel: nil) == "Disconnect GitHub?")
    }
}
