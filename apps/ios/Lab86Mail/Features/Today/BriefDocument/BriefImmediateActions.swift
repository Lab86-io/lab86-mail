import Foundation
import MobileAPI

// The round 2 immediate brief actions (FEATURES items 7, 8, 9), as the web
// runs them in `components/report/brief-canvas/BriefCanvas.tsx`:
//
//   steer_item      steer_brief_item {mode, account, threadId, ...}  Undo: undo_operation
//   undo_operation  undo_operation {operationId}                     no Undo of its own
//   defer_task      tasks_update_card {cardId, dueIso}               Undo: undo_operation
//   defer_thread    snooze_thread {account, threadId, untilTs}       Undo: undo_operation, else unsnooze_thread
//
// The calls and the Undo plan are pure, so tests prove the request bodies.

struct BriefToolCall: Equatable, Sendable {
    let name: String
    let arguments: [String: JSONValue]
}

enum BriefRoundTwoActions {
    static let names: Set<String> = ["steer_item", "undo_operation", "defer_task", "defer_thread"]

    /// Whether the action takes its item out of the live edition. Keep
    /// showing is the one steering choice that leaves the item in place.
    static func hidesItem(_ action: String, payload: BriefActionPayload) -> Bool {
        switch action {
        case "steer_item":
            return payload.mode.flatMap(BriefSteeringMode.init(rawValue:))?.hidesItem ?? true
        case "undo_operation", "defer_task", "defer_thread":
            return true
        default:
            return false
        }
    }

    /// The tool call for one action. Throws a plain message when the brief
    /// sent an incomplete payload, so nothing half-formed reaches the server.
    static func call(_ action: String, payload: BriefActionPayload, now: Date = .now) throws -> BriefToolCall {
        switch action {
        case "steer_item":
            guard let arguments = BriefSteeringRequest.arguments(payload) else {
                throw BackendError.server(status: 400, message: "The brief omitted the item to steer.")
            }
            return BriefToolCall(name: "steer_brief_item", arguments: arguments)
        case "undo_operation":
            guard let operationID = payload.operationID?.nilIfBlank else {
                throw BackendError.server(status: 400, message: "The brief omitted the change to undo.")
            }
            return BriefToolCall(name: "undo_operation", arguments: ["operationId": .string(operationID)])
        case "defer_task":
            guard let cardID = payload.cardID?.nilIfBlank, let dueAt = payload.dueAt,
                  let dueDate = CalendarDateParser.date(fromNumber: dueAt) else {
                throw BackendError.server(status: 400, message: "The brief omitted the new due date.")
            }
            return BriefToolCall(
                name: "tasks_update_card",
                arguments: ["cardId": .string(cardID), "dueIso": .string(isoString(dueDate))]
            )
        case "defer_thread":
            guard let account = payload.account?.nilIfBlank, let threadID = payload.threadID?.nilIfBlank else {
                throw BackendError.server(status: 400, message: "The brief omitted the conversation.")
            }
            guard let until = payload.until, until.isFinite, until > now.timeIntervalSince1970 * 1_000 else {
                throw BackendError.server(status: 400, message: "The brief omitted a future time.")
            }
            return BriefToolCall(
                name: "snooze_thread",
                arguments: [
                    "account": .string(account),
                    "threadId": .string(threadID),
                    "untilTs": .number(until.rounded()),
                ]
            )
        default:
            throw BackendError.server(status: 400, message: "This brief action is not supported here.")
        }
    }

    /// The Undo for an action that ran. Nil when there is none: an undo has
    /// no undo of its own, and Activity keeps the record.
    static func undoCall(_ action: String, payload: BriefActionPayload, operationID: String?) -> BriefToolCall? {
        let recorded = operationID?.nilIfBlank
        switch action {
        case "steer_item", "defer_task":
            guard let recorded else { return nil }
            return BriefToolCall(name: "undo_operation", arguments: ["operationId": .string(recorded)])
        case "defer_thread":
            if let recorded {
                return BriefToolCall(name: "undo_operation", arguments: ["operationId": .string(recorded)])
            }
            guard let account = payload.account, let threadID = payload.threadID else { return nil }
            return BriefToolCall(
                name: "unsnooze_thread",
                arguments: ["account": .string(account), "threadId": .string(threadID)]
            )
        default:
            return nil
        }
    }

    /// The line the undo bar shows after the action.
    static func message(_ action: String, payload: BriefActionPayload, resultSummary: String?) -> String {
        switch action {
        case "steer_item":
            if let resultSummary = resultSummary?.nilIfBlank { return resultSummary }
            return switch payload.mode.flatMap(BriefSteeringMode.init(rawValue:)) {
            case .notForMe: "This conversation stays out of your briefs"
            case .lessFromSender: "Less from this sender in your briefs"
            case .keepShowing: "This conversation keeps showing"
            case nil: "Brief updated"
            }
        case "undo_operation":
            return "Undone"
        case "defer_task":
            return "Moved to \(dayLabel(payload.dueAt))"
        case "defer_thread":
            return "Back in your inbox \(dayLabel(payload.until))"
        default:
            return "Updated"
        }
    }

    private static func dayLabel(_ milliseconds: Double?) -> String {
        guard let milliseconds, let date = CalendarDateParser.date(fromNumber: milliseconds) else { return "later" }
        return date.formatted(.dateTime.weekday(.wide).hour().minute())
    }

    private static func isoString(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
}

// The steering choices of one item sit behind its overflow control, not in
// its row of actions (FEATURES item 8).
extension BriefActionPolicy {
    static func isSteering(_ action: String) -> Bool { action == "steer_item" }

    /// The known steering actions of an item, in the order the server sent.
    static func steering(_ actions: [BriefDocumentAction]?) -> [BriefDocumentAction] {
        (actions ?? []).filter { isSteering($0.action) }
    }
}
