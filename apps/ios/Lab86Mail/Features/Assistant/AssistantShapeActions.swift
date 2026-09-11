import SwiftUI
import CryptoKit

private struct AssistantShapeActionScopeKey: EnvironmentKey {
    static let defaultValue = ""
}

extension EnvironmentValues {
    var assistantShapeActionScope: String {
        get { self[AssistantShapeActionScopeKey.self] }
        set { self[AssistantShapeActionScopeKey.self] = newValue }
    }
}

/// Action controls stay with their result, including confirmation and outcomes.
struct AssistantShapeActions: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.openURL) private var openURL
    @Environment(\.assistantShapeActionScope) private var actionScope
    let actions: [ShapeAction]
    @State private var pending: ShapeAction?
    @State private var busy: String?
    @State private var completed: Set<String> = []
    @State private var outcomes: [String: String] = [:]
    @State private var error: String?
    @State private var notes = ""
    @State private var snoozeDate = Date.now.addingTimeInterval(86_400)
    @State private var rsvp = "yes"
    @State private var thread: ThreadRoute?
    @State private var task: TaskSummary?
    @State private var commandKeys: [String: String] = [:]

    private var available: [ShapeAction] {
        var seen: Set<String> = []
        return actions.filter {
            if case .unknown = $0 { return false }
            return seen.insert($0.id).inserted
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 16) {
                ForEach(available.prefix(2)) { action in actionButton(action) }
                if available.count > 2 {
                    Menu("More") {
                        ForEach(available.dropFirst(2)) { action in actionButton(action) }
                    }
                    .font(.caption.weight(.medium))
                }
            }
            if let pending {
                confirmation(pending)
            }
            ForEach(available) { action in
                if let outcome = outcomes[action.id] {
                    Text(outcome).font(.caption).foregroundStyle(.secondary)
                }
            }
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
        }
        .task {
            guard !actionScope.isEmpty, let ownerID = environment.sessionStore.ownerID,
                  let receipts = try? await environment.commandOutbox.commands(ownerID: ownerID) else { return }
            for action in available {
                guard let receipt = receipts.first(where: { $0.idempotencyKey == stableKey(action) }),
                      let message = try? AssistantShapeMutationOutcome.message(
                        status: receipt.status, success: "Applied", error: receipt.lastErrorMessage,
                        retryable: receipt.lastErrorRetryable
                      ) else { continue }
                outcomes[action.id] = message
                completed.insert(action.id)
            }
        }
        .sheet(item: $thread) { route in
            NavigationStack {
                ThreadView(route: route, summary: nil)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) { Button("Close") { thread = nil } }
                    }
            }
        }
        .sheet(item: $task) { TaskDetailView(task: $0) }
    }

    private func actionButton(_ action: ShapeAction) -> some View {
        Button(action.label, role: action.kind == "delete_event" ? .destructive : nil) {
            error = nil
            switch action {
            case .deleteEvent, .rsvpEvent, .snoozeThread, .rememberSender:
                pending = action
            default: start(action)
            }
        }
        .font(.caption.weight(.medium))
        .buttonStyle(.plain)
        .foregroundStyle(environment.theme.accentColor)
        .padding(.vertical, 8)
        .disabled(busy != nil || completed.contains(action.id))
        .accessibilityLabel(busy == action.id ? "\(action.label), in progress" : action.label)
    }

    @ViewBuilder private func confirmation(_ action: ShapeAction) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            switch action {
            case .snoozeThread:
                DatePicker("Snooze until", selection: $snoozeDate, in: Date.now..., displayedComponents: [.date, .hourAndMinute])
            case .rememberSender(let email):
                TextField("Note about \(email)", text: $notes, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
            case .rsvpEvent:
                Text("Send your response to the organizer?").font(.caption)
                Picker("Response", selection: $rsvp) {
                    Text("Yes").tag("yes")
                    Text("Maybe").tag("maybe")
                    Text("No").tag("no")
                }.pickerStyle(.segmented)
            case .deleteEvent:
                Text("Delete this event?").font(.caption)
            default: EmptyView()
            }
            HStack(spacing: 16) {
                Button(action.kind == "delete_event" ? "Delete event" : "Confirm") { start(action) }
                    .disabled(busy != nil || (action.kind == "remember_sender" && notes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
                Button("Cancel") { pending = nil }.disabled(busy != nil)
            }.font(.caption.weight(.medium))
        }
    }

    private func start(_ action: ShapeAction) {
        guard busy == nil, !completed.contains(action.id) else { return }
        busy = action.id
        Task { @MainActor in
            defer { busy = nil }
            do {
                let outcome = try await execute(action)
                if action.isMutation {
                    outcomes[action.id] = outcome
                    completed.insert(action.id)
                }
                pending = nil
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    @MainActor private func execute(_ action: ShapeAction) async throws -> String {
        switch action {
        case .openThread(let account, let threadID):
            thread = ThreadRoute(accountID: account, threadID: threadID)
        case .replyThread(let account, let threadID):
            let detail = try await environment.store.loadThread(ThreadRoute(accountID: account, threadID: threadID))
            guard let message = detail.messages.last else { throw BackendError.invalidResponse }
            environment.navigation.pendingCompose = ComposePrefill(
                recipient: message.sender, cc: "", bcc: "",
                subject: detail.subject.lowercased().hasPrefix("re:") ? detail.subject : "Re: " + detail.subject,
                body: "", mode: "reply", accountID: account, threadID: threadID,
                messageID: message.id, replyAll: false, attachmentsKey: nil, draftID: nil
            )
            environment.navigation.sheet = .compose
        case .openWork(let id): environment.navigation.openWork(id: id, title: nil)
        case .openArea(let id): environment.navigation.openArea(id: id, name: nil)
        case .openDocument(let id, _): environment.navigation.openDocument(id: id)
        case .openBoard(let boardID):
            await environment.store.switchBoard(to: boardID)
            environment.navigation.selectPrimary(.tasks)
        case .openTask(_, let cardID):
            let result = try await environment.tools.invoke("tasks_get_card", arguments: ["cardId": .string(cardID)])
            guard let loaded = result["card"].flatMap({ TaskSummary(json: $0) }) else { throw BackendError.invalidResponse }
            task = loaded
        case .openEvent(let account, let calendarID, let eventID, let startISO):
            environment.navigation.pendingCalendarDay = startISO.flatMap(CalendarDateParser.date(fromString:))
            environment.navigation.openEvent(accountID: account, eventID: eventID, calendarID: calendarID, preview: nil)
        case .openURL(let raw, _):
            guard let url = URL(string: raw), ["https", "http"].contains(url.scheme?.lowercased() ?? "") else {
                throw BackendError.invalidResponse
            }
            openURL(url)
        case .archiveThread(let account, let threadID):
            return try await submit(.mailArchive(.init(accountID: account, threadID: threadID)), action: action, success: "Archived")
        case .completeTask(let cardID):
            return try await submit(.taskSetCompleted(.init(cardID: cardID, completed: true)), action: action, success: "Completed")
        case .snoozeThread(let account, let threadID, let suppliedID):
            var messageID = suppliedID
            if messageID == nil {
                let result = try await environment.tools.invoke("get_thread", arguments: ["account": .string(account), "threadId": .string(threadID)])
                messageID = (result["messages"]?.arrayValue ?? []).sorted {
                    (CalendarDateParser.date($0["date"]) ?? .distantPast) > (CalendarDateParser.date($1["date"]) ?? .distantPast)
                }.first?["_id"]?.stringValue
            }
            guard let messageID else { throw BackendError.server(status: 400, message: "Could not find the message to snooze.") }
            return try await submit(.mailSnooze(.init(accountID: account, threadID: threadID, messageID: messageID, untilAt: snoozeDate)), action: action, success: "Snoozed")
        case .holdSlot(let suppliedAccount, let startISO, let endISO, let title):
            guard let account = suppliedAccount ?? environment.store.accounts.first(where: \.isPrimary)?.id ?? environment.store.accounts.first?.id,
                  let start = CalendarDateParser.date(fromString: startISO), let end = CalendarDateParser.date(fromString: endISO), end > start else {
                throw BackendError.server(status: 400, message: "A calendar account and valid time are required.")
            }
            return try await submit(.calendarCreate(.init(accountID: account, calendarID: nil, title: title ?? "Hold", startAt: start, endAt: end, allDay: false, description: nil, location: nil, attendees: [], recurrence: nil, busy: true)), action: action, success: "Time held")
        case .rsvpEvent(let account, let suppliedCalendar, let eventID):
            let calendarID: String
            if let suppliedCalendar { calendarID = suppliedCalendar }
            else {
                guard let resolved = environment.store.events.first(where: { $0.id == eventID && $0.accountID == account })?.calendarID else {
                    throw BackendError.server(status: 400, message: "Open the event to choose its calendar before you RSVP.")
                }
                calendarID = resolved
            }
            try await invoke("calendar_rsvp_event", ["account": .string(account), "calendarId": .string(calendarID), "eventId": .string(eventID), "status": .string(rsvp)])
            return "Response sent"
        case .deleteEvent(let account, let suppliedCalendar, let eventID):
            guard let calendarID = suppliedCalendar ?? environment.store.events.first(where: {
                $0.id == eventID && $0.accountID == account
            })?.calendarID else {
                throw BackendError.server(status: 400, message: "Open the event to choose its calendar before you delete it.")
            }
            try await invoke("calendar_delete_event", [
                "account": .string(account), "calendarId": .string(calendarID),
                "eventId": .string(eventID), "notifyParticipants": .bool(false)
            ])
            return "Event deleted"
        case .undoOperation(let operationID):
            try await invoke("undo_operation", ["operationId": .string(operationID)])
            return "Undone"
        case .importFile(let connectionID, let fileID, let mimeType):
            guard let mimeType else { throw BackendError.server(status: 400, message: "Open Files to import this file. Its format is unavailable.") }
            try await invoke("google_file_import", ["connectionId": .string(connectionID), "fileId": .string(fileID), "mimeType": .string(mimeType)])
            return "Imported"
        case .rememberSender(let email):
            try await invoke("remember", ["email": .string(email), "notes": .string(notes.trimmingCharacters(in: .whitespacesAndNewlines))])
            return "Note saved"
        case .unknown: throw BackendError.invalidResponse
        }
        return "Opened"
    }

    private func invoke(_ name: String, _ arguments: [String: JSONValue]) async throws {
        let result = try await environment.tools.invoke(name, arguments: arguments)
        if result["ok"]?.boolValue == false || result["error"]?.stringValue != nil {
            throw BackendError.server(status: 400, message: result["error"]?.stringValue ?? "The action did not complete.")
        }
    }

    private func stableKey(_ action: ShapeAction) -> String {
        let digest = SHA256.hash(data: Data("\(actionScope):\(action.id)".utf8))
        return "chat-" + digest.map { String(format: "%02x", $0) }.joined()
    }

    private func submit(_ command: DurableMobileCommand, action: ShapeAction, success: String) async throws -> String {
        guard let ownerID = environment.sessionStore.ownerID else { throw BackendError.unauthorized }
        let key = commandKeys[action.id] ?? (actionScope.isEmpty ? UUID().uuidString : stableKey(action))
        commandKeys[action.id] = key
        _ = try await environment.commandOutbox.enqueue(ownerID: ownerID, command: command, idempotencyKey: key)
        _ = await environment.flushCommandOutbox(ownerID: ownerID)
        guard let receipt = try await environment.commandOutbox.commands(ownerID: ownerID).first(where: { $0.idempotencyKey == key }) else {
            throw BackendError.invalidResponse
        }
        return try AssistantShapeMutationOutcome.message(status: receipt.status, success: success, error: receipt.lastErrorMessage, retryable: receipt.lastErrorRetryable)
    }
}

enum AssistantShapeMutationOutcome {
    static func message(status: OutboxCommandStatus, success: String, error: String?, retryable: Bool) throws -> String {
        switch status {
        case .applied: return success
        case .needsApproval: return "Approval required. Review this action in Activity."
        case .pending, .queued, .submitting: return "Saved. Waiting to sync."
        case .failed where retryable: return "Saved. Sync will try again."
        case .failed, .conflicted: throw BackendError.server(status: 409, message: error ?? "The action did not complete.")
        }
    }
}
