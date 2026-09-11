import Foundation

// Native port of the tool sentence grammar in `lib/albatross/teach-ui.ts`
// (docs/chat-agentic-pass.md, section 6). The server sends the resolved
// sentences with each shape as `ToolShape.activity`; this table covers the
// time before the shape arrives (running rows, streamed input), failures, and
// tools that never get a shape. Every sentence is sentence case, concrete, and
// free of raw tool identifiers.
enum AssistantToolGrammar {
    static func sentences(toolName: String, input: JSONValue?, output: JSONValue?) -> ShapeActivity {
        let args = input ?? .null
        let out = output ?? .null
        if let builder = table[toolName] {
            return builder(args, out)
        }
        return generic(toolName: toolName, output: out)
    }

    /// The old native line, kept as the last fallback so a tool never renders
    /// as a bare identifier.
    static func describe(_ toolName: String) -> String {
        "Working — \(human(toolName))"
    }

    /// A best-effort parse of a partially streamed JSON input. Closing the
    /// open string and object usually yields the `query` argument early, so a
    /// running row can already read “Searching your mail for …”.
    static func partialInput(from text: String) -> JSONValue? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        for candidate in [trimmed, trimmed + "\"}", trimmed + "}", trimmed + "\"]}", trimmed + "]}"] {
            if let data = candidate.data(using: .utf8),
               let value = try? JSONDecoder().decode(JSONValue.self, from: data),
               case .object = value {
                return value
            }
        }
        return nil
    }

    // MARK: - Helpers

    private typealias Builder = @Sendable (JSONValue, JSONValue) -> ShapeActivity

    private static func str(_ value: JSONValue?) -> String {
        value?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    private static func clip(_ value: String, max: Int = 120) -> String {
        let line = value.split(separator: "\n", omittingEmptySubsequences: false).first.map(String.init) ?? ""
        let clean = line.trimmingCharacters(in: .whitespaces)
        return clean.count > max ? String(clean.prefix(max - 1)) + "…" : clean
    }

    private static func resultCount(_ output: JSONValue) -> Int? {
        for key in ["items", "threads", "results", "events", "senders", "areas", "verdicts"] {
            if let rows = output[key]?.arrayValue { return rows.count }
        }
        return nil
    }

    private static func plural(_ count: Int, _ noun: String) -> String {
        "\(count) \(noun)\(count == 1 ? "" : "s")"
    }

    private static func human(_ toolName: String) -> String {
        let words = toolName
            .replacingOccurrences(of: "[_\\-.]+", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
            .lowercased()
        return words.isEmpty ? "a step" : words
    }

    private static func generic(toolName: String, output: JSONValue) -> ShapeActivity {
        let name = human(toolName)
        let capitalized = name.prefix(1).uppercased() + name.dropFirst()
        let done: String
        if let count = resultCount(output) {
            done = "Finished \(name) — \(plural(count, "result"))"
        } else {
            done = "Finished \(name)"
        }
        return ShapeActivity(running: "Running \(name)", done: done, failed: "\(capitalized) failed")
    }

    private static func fixed(_ running: String, _ done: String, _ failed: String) -> Builder {
        { _, _ in ShapeActivity(running: running, done: done, failed: failed) }
    }

    private static func search(_ what: String, failed: String) -> Builder {
        { args, out in
            let query = str(args["query"]).nilIfBlank ?? str(args["description"])
            let scope = query.isEmpty ? "" : " for “\(clip(query, max: 60))”"
            let done: String
            if let count = resultCount(out) {
                done = "Searched \(what)\(scope) — \(plural(count, "result"))"
            } else {
                done = "Searched \(what)\(scope)"
            }
            return ShapeActivity(running: "Searching \(what)\(scope)", done: done, failed: failed)
        }
    }

    private static func compose(_ running: String) -> Builder {
        { args, _ in
            let to = str(args["to"])
            return ShapeActivity(
                running: running,
                done: to.isEmpty ? "Prepared a message for your review" : "Prepared a message to \(to) for your review",
                failed: "\(running) failed"
            )
        }
    }

    // MARK: - Table

    private static let table: [String: Builder] = [
        // Mail reads
        "search_threads": search("your mail", failed: "Mail search failed"),
        "corpus_search": search("your mail", failed: "Mail search failed"),
        "nl_search": search("your mail", failed: "Mail search failed"),
        "corpus_count": fixed("Counting matching mail", "Counted the matching mail", "Mail count failed"),
        "get_thread": fixed("Loading the thread", "Read the thread", "Loading the thread failed"),
        "read_thread": fixed("Reading the thread", "Read the thread", "Reading the thread failed"),
        "thread_timeline": fixed("Reading the thread history", "Read the thread history", "Reading the thread history failed"),
        "get_message": fixed("Loading the message", "Read the message", "Loading the message failed"),
        "recent_threads": fixed("Loading recent threads", "Loaded recent threads", "Loading recent threads failed"),
        "list_account_threads": fixed("Loading the mailbox", "Loaded the mailbox", "Loading the mailbox failed"),
        "list_accounts": fixed("Checking connected accounts", "Checked your connected accounts", "Checking accounts failed"),
        "list_labels": fixed("Listing your labels", "Listed your labels", "Listing labels failed"),
        "list_attachments": fixed("Listing attachments", "Listed the attachments", "Listing attachments failed"),
        "sender_profile": { args, _ in
            let who = str(args["email"])
            return ShapeActivity(
                running: who.isEmpty ? "Looking up the sender" : "Looking up \(who)",
                done: who.isEmpty ? "Looked up the sender" : "Looked up \(who)",
                failed: "Sender lookup failed"
            )
        },
        "contact_lookup": fixed("Looking up the contact", "Looked up the contact", "Contact lookup failed"),

        // Mail mutations
        "archive_thread": fixed("Archiving the thread", "Archived the thread", "Archiving the thread failed"),
        "trash_thread": fixed("Moving the thread to trash", "Moved the thread to trash", "Moving to trash failed"),
        "mark_read": fixed("Marking as read", "Marked as read", "Marking as read failed"),
        "mark_unread": fixed("Marking as unread", "Marked as unread", "Marking as unread failed"),
        "mute_thread": fixed("Muting the thread", "Muted the thread", "Muting the thread failed"),
        "snooze_thread": { args, _ in
            var until = ""
            if let ts = args["untilTs"]?.doubleValue, let date = CalendarDateParser.date(fromNumber: ts) {
                until = date.formatted(date: .abbreviated, time: .shortened)
            }
            return ShapeActivity(
                running: "Snoozing the thread",
                done: until.isEmpty ? "Snoozed the thread" : "Snoozed until \(until)",
                failed: "Snoozing the thread failed"
            )
        },
        "unsnooze_thread": fixed("Unsnoozing the thread", "Unsnoozed the thread", "Unsnoozing the thread failed"),
        "send_message": compose("Sending the message"),
        "reply": compose("Writing the reply"),
        "reply_all": compose("Writing the reply to everyone"),
        "forward": compose("Forwarding the message"),
        "draft_reply": fixed("Drafting a reply", "Drafted a reply for your review", "Drafting the reply failed"),
        "summarize_thread": fixed("Summarizing the thread", "Summarized the thread", "Summarizing failed"),
        "undo_operation": fixed("Undoing that change", "Undid that change", "Undoing the change failed"),

        // Memory
        "remember": { args, _ in
            let who = str(args["email"])
            return ShapeActivity(
                running: who.isEmpty ? "Saving a note" : "Saving a note about \(who)",
                done: who.isEmpty ? "Saved a note" : "Saved a note about \(who)",
                failed: "Saving the note failed"
            )
        },
        "recall": { args, _ in
            let who = str(args["email"])
            return ShapeActivity(
                running: who.isEmpty ? "Recalling notes" : "Recalling notes about \(who)",
                done: who.isEmpty ? "Recalled my notes" : "Recalled notes about \(who)",
                failed: "Recalling notes failed"
            )
        },

        // Calendar
        "calendar_list_events": { _, out in
            let count = out["events"]?.arrayValue?.count
            return ShapeActivity(
                running: "Checking your calendar",
                done: count.map { "Found \(plural($0, "calendar event"))" } ?? "Listed your calendar events",
                failed: "Checking the calendar failed"
            )
        },
        "calendar_search_events": search("your calendar", failed: "Calendar search failed"),
        "calendar_free_busy": fixed("Checking your availability", "Checked your calendar availability", "Checking availability failed"),
        "calendar_suggest_times": fixed("Suggesting meeting times", "Suggested some meeting times", "Suggesting times failed"),
        "calendar_create_event": { args, _ in
            let title = str(args["title"])
            return ShapeActivity(
                running: title.isEmpty ? "Creating a calendar event" : "Creating the event “\(clip(title, max: 60))”",
                done: title.isEmpty ? "Created a calendar event" : "Created the event “\(clip(title, max: 60))”",
                failed: "Creating the event failed"
            )
        },
        "calendar_update_event": fixed("Updating the event", "Updated the event", "Updating the event failed"),
        "calendar_delete_event": fixed("Deleting the event", "Deleted the event", "Deleting the event failed"),
        "calendar_rsvp_event": fixed("Sending your reply to the invite", "Replied to the invite", "Replying to the invite failed"),

        // Tasks
        "tasks_list_boards": fixed("Listing your boards", "Listed your boards", "Listing boards failed"),
        "tasks_get_board": fixed("Loading the board", "Loaded the board", "Loading the board failed"),
        "tasks_get_card": fixed("Loading the task", "Loaded the task", "Loading the task failed"),
        "tasks_create_board": fixed("Creating the board", "Created the board", "Creating the board failed"),
        "tasks_create_card": { args, _ in
            let title = str(args["title"])
            return ShapeActivity(
                running: title.isEmpty ? "Creating a task" : "Creating task “\(clip(title, max: 60))”",
                done: title.isEmpty ? "Created a task" : "Created task “\(clip(title, max: 60))”",
                failed: "Creating the task failed"
            )
        },
        "tasks_update_card": { args, out in
            let card = out["card"] ?? .null
            let title = str(card["title"]).nilIfBlank ?? str(args["title"]).nilIfBlank ?? "the task"
            let column = str(card["columnName"])
            let done: String
            if args["completed"]?.boolValue == true, !column.isEmpty {
                done = "Marked “\(title)” complete in \(column)"
            } else if !column.isEmpty {
                done = "Updated “\(title)” in \(column)"
            } else {
                done = "Updated the task"
            }
            return ShapeActivity(running: "Updating the task", done: done, failed: "Updating the task failed")
        },
        "tasks_move_card": { args, out in
            let column = str(out["card"]?["columnName"]).nilIfBlank ?? str(args["column"])
            let done: String
            if out["noOp"]?.boolValue == true {
                done = "Task already in \(column.isEmpty ? "that column" : column)"
            } else if !column.isEmpty {
                done = "Moved the task to \(column)"
            } else {
                done = "Moved the task"
            }
            return ShapeActivity(running: "Moving the task", done: done, failed: "Moving the task failed")
        },
        "tasks_delete_card": fixed("Deleting the task", "Deleted the task", "Deleting the task failed"),
        "tasks_search_cards": search("your tasks", failed: "Task search failed"),
        "tasks_list_cards": fixed("Listing your tasks", "Listed your tasks", "Listing tasks failed"),

        // Albatross work and areas
        "albatross_list_work": fixed("Checking your Work", "Checked your Work", "Checking Work failed"),
        "albatross_work_detail": fixed("Opening the Work", "Read the Work", "Opening the Work failed"),
        "albatross_capture": fixed("Holding that as Work", "Held that as Work", "Holding the Work failed"),
        "albatross_record_progress": fixed("Recording progress", "Recorded progress", "Recording progress failed"),
        "albatross_replan_work": fixed("Replanning the Work", "Replanned the Work", "Replanning failed"),
        "albatross_area_brief": fixed("Reading the area brief", "Read the area brief", "Reading the area brief failed"),
        "area_list": fixed("Checking saved areas", "Checked saved areas", "Checking saved areas failed"),
        "area_home": fixed("Opening the area", "Read the area", "Opening the area failed"),
        "area_create": { args, out in
            let name = str(args["name"]).nilIfBlank ?? str(out["name"])
            return ShapeActivity(
                running: name.isEmpty ? "Creating the area" : "Creating area \(name)",
                done: name.isEmpty ? "Created the area" : "Created area \(name)",
                failed: name.isEmpty ? "Creating the area failed" : "Creating area \(name) failed"
            )
        },

        // Documents and files
        "document_create": fixed("Creating the file", "Created the editable file", "Creating the file failed"),
        "document_list": fixed("Listing your files", "Listed your files", "Listing files failed"),
        "document_get": fixed("Opening the file", "Opened the file", "Opening the file failed"),
        "document_edit": { _, out in
            let done: String
            switch str(out["status"]) {
            case "applied": done = "Saved a new file revision"
            case "proposed": done = "Added file edits for review — not yet applied"
            default: done = "No file edits were applied"
            }
            return ShapeActivity(running: "Preparing file edits", done: done, failed: "Applying file edits failed")
        },
        "document_suggest_changes": fixed("Preparing file suggestions", "Added suggestions for review", "Preparing suggestions failed"),
        "document_apply_instruction": fixed("Editing the file", "Saved a new file revision", "Editing the file failed"),
        "document_publish_google": fixed("Syncing the Google file", "Synced the Google file", "Syncing the Google file failed"),
        "document_export": fixed("Preparing the export", "Prepared the export", "Preparing the export failed"),
        "cloud_file_search": fixed("Searching connected drives", "Searched connected drives", "Drive search failed"),
        "google_file_import": fixed("Opening the Google file", "Opened the Google file in Albatross", "Google file import failed"),

        // Web
        "browserbase_search": { args, _ in
            let query = str(args["query"])
            return ShapeActivity(
                running: query.isEmpty ? "Searching the web" : "Searching the web for “\(clip(query, max: 60))”",
                done: query.isEmpty ? "Searched the web" : "Searched the web for “\(clip(query, max: 60))”",
                failed: "Web search failed"
            )
        },
        "browserbase_fetch": { args, _ in
            let url = str(args["url"])
            return ShapeActivity(
                running: url.isEmpty ? "Fetching a web page" : "Reading \(clip(url, max: 80))",
                done: url.isEmpty ? "Read a web page" : "Read \(clip(url, max: 80))",
                failed: "Reading the page failed"
            )
        },

        // On-demand tool groups loaded mid-turn. Never gets a shape.
        "enable_tools": { args, _ in
            let groups = (args["groups"]?.arrayValue ?? []).compactMap { $0.stringValue?.nilIfBlank }
            let list = groups.isEmpty ? "more" : groups.joined(separator: ", ")
            return ShapeActivity(
                running: "Loading \(list) tools",
                done: "Loaded \(list) tools",
                failed: "Could not load more tools"
            )
        },

        // Questions (rows only cover transcripts where the form is not shown)
        "ask_user": fixed("Asking you a question", "You answered", "The question failed"),
        "ask_approval": fixed("Waiting for your approval", "You decided", "The approval failed"),
        "ask_parameters": fixed("Waiting for your numbers", "You set the values", "The parameter form failed"),
        "ask_preferences": fixed("Waiting for your preferences", "You set your preferences", "The preferences form failed"),
        "ask_question_flow": fixed("Walking you through the steps", "You finished the steps", "The guided steps failed"),

        // Display tools
        "show_weather": { args, _ in
            let place = str(args["place"])
            return ShapeActivity(
                running: place.isEmpty ? "Checking the weather" : "Checking the weather in \(place)",
                done: place.isEmpty ? "Fetched the weather" : "Fetched the weather for \(place)",
                failed: "Weather lookup failed"
            )
        },
        "show_chart": { args, _ in
            let title = str(args["title"])
            return ShapeActivity(
                running: title.isEmpty ? "Drawing a chart" : "Drawing “\(clip(title, max: 60))”",
                done: title.isEmpty ? "Drew the chart" : "Drew “\(clip(title, max: 60))”",
                failed: "Drawing the chart failed"
            )
        },
        "show_stats": fixed("Laying out the numbers", "Laid out the numbers", "Laying out the numbers failed"),
        "show_table": fixed("Building the table", "Built the table", "Building the table failed"),
        "show_code": fixed("Formatting the code", "Formatted the code", "Formatting the code failed"),
        "show_code_diff": fixed("Building the diff", "Built the diff", "Building the diff failed"),
        "show_terminal": fixed("Formatting the output", "Formatted the output", "Formatting the output failed"),
        "show_plan": fixed("Laying out the plan", "Laid out the plan", "Laying out the plan failed"),
        "show_progress": fixed("Summarizing the progress", "Summarized the progress", "Summarizing the progress failed"),
        "show_citations": fixed("Collecting the sources", "Collected the sources", "Collecting the sources failed"),
        "show_link_preview": fixed("Previewing the link", "Previewed the link", "Previewing the link failed"),
        "show_image": fixed("Preparing the image", "Showed the image", "Preparing the image failed"),
        "show_image_gallery": fixed("Preparing the gallery", "Showed the gallery", "Preparing the gallery failed"),
        "show_map": fixed("Placing the map markers", "Placed the map markers", "Placing the map markers failed"),
        "show_message_draft": fixed("Preparing the draft", "Prepared the draft for review", "Preparing the draft failed"),
        "show_email_preview": fixed("Pulling up the email", "Showed the email", "Pulling up the email failed"),
    ]
}
