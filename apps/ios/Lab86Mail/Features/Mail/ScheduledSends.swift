import Foundation
import Observation

// Scheduled sends: mail that waits at the provider to go out later. The
// web's Scheduled list (components/inbox/ScheduledSends.tsx) reads every
// connected mailbox with `list_scheduled` and cancels one send with
// `cancel_scheduled`; this is the same contract on the phone.

struct ScheduledSendRow: Identifiable, Hashable, Sendable {
    enum Status: String, Sendable {
        case pending, sent, failed, cancelled
    }

    let accountID: String
    let accountLabel: String
    let scheduleID: String
    let status: Status
    /// When the provider sends it, when the provider says.
    let sendAt: Date?

    var id: String { "\(accountID):\(scheduleID)" }

    init(accountID: String, accountLabel: String, scheduleID: String, status: Status, sendAt: Date?) {
        self.accountID = accountID
        self.accountLabel = accountLabel
        self.scheduleID = scheduleID
        self.status = status
        self.sendAt = sendAt
    }

    /// One provider row. The id, the status, and the close time each come
    /// under more than one key (lib/shell/scheduled-sends.ts).
    init?(json: JSONValue, accountID: String, accountLabel: String) {
        guard let id = Self.identifier(json["scheduleId"] ?? json["schedule_id"] ?? json["id"]) else { return nil }
        self.accountID = accountID
        self.accountLabel = accountLabel
        scheduleID = id
        status = Self.status(from: json["status"]?["code"]?.stringValue ?? json["status"]?.stringValue)
        sendAt = Self.date(from: json["closeTime"] ?? json["close_time"] ?? json["sendAt"] ?? json["send_at"])
    }

    static func status(from code: String?) -> Status {
        let text = (code ?? "").lowercased()
        if text.range(of: "succ?ess|sent", options: .regularExpression) != nil { return .sent }
        if text.range(of: "fail|error", options: .regularExpression) != nil { return .failed }
        if text.contains("cancel") { return .cancelled }
        return .pending
    }

    /// The provider sends epoch seconds; milliseconds are accepted too.
    static func date(from value: JSONValue?) -> Date? {
        guard let value else { return nil }
        let number: Double?
        if let direct = value.doubleValue {
            number = direct
        } else if let text = value.stringValue {
            number = Double(text)
        } else {
            number = nil
        }
        guard let number, number.isFinite, number > 0 else { return nil }
        return Date(timeIntervalSince1970: number < 1e12 ? number : number / 1_000)
    }

    private static func identifier(_ value: JSONValue?) -> String? {
        // A number first: its string form would read "42.0".
        if case .number(let number)? = value, number.isFinite, abs(number) < 1e15 {
            return number == number.rounded() ? String(Int64(number)) : String(number)
        }
        return value?.stringValue?.nilIfBlank
    }

    /// The sends that still wait, soonest first; a send with no time last.
    static func pending(_ rows: [ScheduledSendRow]) -> [ScheduledSendRow] {
        rows
            .filter { $0.status == .pending }
            .sorted { ($0.sendAt ?? .distantFuture) < ($1.sendAt ?? .distantFuture) }
    }

    /// The row's first line.
    func sendLine(locale: Locale = .autoupdatingCurrent, calendar: Calendar = .autoupdatingCurrent) -> String {
        guard let sendAt else { return "Send time not known" }
        let when = sendAt.formatted(
            Date.FormatStyle(date: .abbreviated, time: .shortened, locale: locale, calendar: calendar, timeZone: calendar.timeZone)
        )
        return "Sends \(when)"
    }
}

struct ScheduledSendsClient: Sendable {
    let tools: any ToolInvoking

    func list(accountID: String, accountLabel: String) async throws -> [ScheduledSendRow] {
        let result = try await tools.invoke("list_scheduled", arguments: ["account": .string(accountID)])
        return (result["scheduled"]?.arrayValue ?? []).compactMap {
            ScheduledSendRow(json: $0, accountID: accountID, accountLabel: accountLabel)
        }
    }

    static func cancelArguments(_ row: ScheduledSendRow) -> [String: JSONValue] {
        ["account": .string(row.accountID), "scheduleId": .string(row.scheduleID)]
    }

    func cancel(_ row: ScheduledSendRow) async throws {
        _ = try await tools.invoke("cancel_scheduled", arguments: Self.cancelArguments(row))
    }
}

/// The list's state: loading, loaded (with the mailboxes that did not
/// answer), or failed when no mailbox answered.
@MainActor
@Observable
final class ScheduledSendsModel {
    enum Phase: Equatable {
        case loading, loaded, failed
    }

    private(set) var phase: Phase = .loading
    private(set) var rows: [ScheduledSendRow] = []
    private(set) var failedAccounts: [String] = []
    private(set) var cancellingID: String?
    var cancelError: String?

    nonisolated static func phase(accountCount: Int, failedCount: Int) -> Phase {
        accountCount > 0 && failedCount == accountCount ? .failed : .loaded
    }

    func load(accounts: [AccountSummary], client: ScheduledSendsClient) async {
        phase = .loading
        var collected: [ScheduledSendRow] = []
        var failed: [String] = []
        let mailboxes = accounts.filter { !$0.id.isEmpty }
        for account in mailboxes {
            do {
                collected += try await client.list(accountID: account.id, accountLabel: account.email)
            } catch {
                if error.isCancellation { return }
                failed.append(account.email)
            }
        }
        rows = ScheduledSendRow.pending(collected)
        failedAccounts = failed
        phase = Self.phase(accountCount: mailboxes.count, failedCount: failed.count)
    }

    func cancel(_ row: ScheduledSendRow, client: ScheduledSendsClient) async {
        cancellingID = row.id
        cancelError = nil
        defer { cancellingID = nil }
        do {
            try await client.cancel(row)
            rows.removeAll { $0.id == row.id }
        } catch {
            if error.isCancellation { return }
            cancelError = error.localizedDescription.nilIfBlank ?? "Could not cancel this send."
        }
    }
}
