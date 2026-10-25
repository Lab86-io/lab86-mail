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
        if let connector = connectorSentences(toolName: toolName) {
            return connector
        }
        return generic(toolName: toolName, output: out)
    }

    /// The connected services (Slack, Jira, Confluence, Bitbucket, GitHub)
    /// register tools by prefix. The verb comes from the tool's own name, so
    /// a new connector tool still reads as a sentence.
    static func connectorSentences(toolName: String) -> ShapeActivity? {
        let families: [(prefix: String, name: String)] = [
            ("slack_", "Slack"), ("jira_", "Jira"), ("confluence_", "Confluence"),
            ("atlassian_confluence_", "Confluence"), ("atlassian_jira_", "Jira"), ("atlassian_", "Atlassian"),
            ("bitbucket_", "Bitbucket"), ("github_", "GitHub"), ("linear_", "Linear"), ("notion_", "Notion"),
        ]
        // The longest prefix wins: `atlassian_jira_` before `atlassian_`.
        guard let family = families
            .filter({ toolName.hasPrefix($0.prefix) })
            .max(by: { $0.prefix.count < $1.prefix.count }) else { return nil }
        let action = toolName.dropFirst(family.prefix.count)
        let service = family.name
        if action.contains("search") || action.contains("find") {
            return ShapeActivity(running: "Searching \(service)", done: "Searched \(service)", failed: "Searching \(service) failed")
        }
        if action.contains("list") {
            return ShapeActivity(running: "Loading \(service) items", done: "Loaded \(service) items", failed: "Loading \(service) items failed")
        }
        if action.contains("comment") {
            return ShapeActivity(running: "Commenting in \(service)", done: "Commented in \(service)", failed: "Commenting in \(service) failed")
        }
        if action.contains("create") || action.contains("post") || action.contains("send") {
            return ShapeActivity(running: "Posting to \(service)", done: "Posted to \(service)", failed: "Posting to \(service) failed")
        }
        if action.contains("update") || action.contains("edit") || action.contains("transition") {
            return ShapeActivity(running: "Updating \(service)", done: "Updated \(service)", failed: "Updating \(service) failed")
        }
        if action.contains("get") || action.contains("read") || action.contains("fetch") || action.contains("status") {
            return ShapeActivity(running: "Reading \(service)", done: "Read \(service)", failed: "Reading \(service) failed")
        }
        return ShapeActivity(running: "Working in \(service)", done: "Worked in \(service)", failed: "Working in \(service) failed")
    }

    /// True for the fallback line, which names the tool instead of the work.
    static func isGeneric(_ activity: ShapeActivity) -> Bool {
        activity.running.hasPrefix("Running ") || activity.done.hasPrefix("Finished ")
    }

    /// The old native line, kept as the last fallback so a tool never renders
    /// as a bare identifier.
    static func describe(_ toolName: String) -> String {
        "Working — \(human(toolName))"
    }

    /// A best-effort parse of a partially streamed JSON input. Closing the
    /// open string and object usually yields the `query` argument early, so a
    /// running row can already read “Searching your mail for …”.
    static func partialInput(from text: String, cacheKey: String? = nil) -> JSONValue? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if let cacheKey, let entry = PartialInputCache.shared.entry(for: cacheKey, length: trimmed.count) {
            return entry.value
        }
        let value = parsePartial(trimmed)
        if let cacheKey {
            PartialInputCache.shared.store(value, for: cacheKey, length: trimmed.count)
        }
        return value
    }

    private static func parsePartial(_ trimmed: String) -> JSONValue? {
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
}

/// The partial parses by tool call, so a redraw does not decode a long
/// streamed input again (C8). A longer input replaces the entry; the cache
/// clears itself at its limit.
final class PartialInputCache: @unchecked Sendable {
    struct Entry: Sendable {
        let length: Int
        let value: JSONValue?
    }

    static let shared = PartialInputCache()
    static let limit = 256

    private let lock = NSLock()
    private var entries: [String: Entry] = [:]

    func entry(for key: String, length: Int) -> Entry? {
        lock.withLock {
            guard let entry = entries[key], entry.length == length else { return nil }
            return entry
        }
    }

    func store(_ value: JSONValue?, for key: String, length: Int) {
        lock.withLock {
            if entries.count >= Self.limit { entries.removeAll(keepingCapacity: true) }
            entries[key] = Entry(length: length, value: value)
        }
    }

    var count: Int { lock.withLock { entries.count } }

    func removeAll() {
        lock.withLock { entries.removeAll() }
    }
}

extension AssistantToolGrammar {

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

    /// A file saved in Files: "Saved <title> in Files" once the result names it.
    private static func savedFile(running: String, fallback: String, failed: String) -> Builder {
        { _, out in
            let title = clip(str(out["title"]), max: 80)
            return ShapeActivity(
                running: running,
                done: title.isEmpty ? fallback : "Saved \(title) in Files",
                failed: failed
            )
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
        "corpus_search": { args, out in
            // Mail and the connected sources, counted apart, as on the web.
            let what = args["includeConnectedTools"]?.boolValue == false ? "your mail" : "mail and connected sources"
            let base = search(what, failed: "Search failed")(args, out)
            guard let items = out["items"]?.arrayValue else { return base }
            let mail = items.filter { $0["source"]?.stringValue != "mcp" }.count
            let connected = items.count - mail
            let query = str(args["query"])
            let scope = query.isEmpty ? "" : " for “\(query)”"
            let failures = out["errors"]?.arrayValue?.count ?? 0
            return ShapeActivity(
                running: base.running,
                done: "Searched\(scope) — \(plural(mail, "mail result")), \(plural(connected, "connected result"))\(failures > 0 ? "; some searches failed" : "")",
                failed: base.failed
            )
        },
        "nl_search": search("your mail", failed: "Mail search failed"),
        "mcp_search": { args, out in
            search(str(args["server"]).nilIfBlank ?? "connected sources", failed: "Connected search failed")(args, out)
        },
        "mcp_list_items": { args, out in
            let source = str(args["server"]).nilIfBlank ?? "connected sources"
            let count = resultCount(out)
            return ShapeActivity(
                running: "Loading recent items from \(source)",
                done: "Loaded recent items from \(source)" + (count.map { " — \(plural($0, "result"))" } ?? ""),
                failed: "Loading items from \(source) failed"
            )
        },
        "mcp_connection_status": fixed("Checking connection sync status", "Checked connection sync status", "Connection status check failed"),
        "corpus_count": fixed("Counting matching mail", "Counted the matching mail", "Mail count failed"),
        "get_thread": fixed("Loading the thread", "Read the thread", "Loading the thread failed"),
        "read_thread": fixed("Reading the thread", "Read the thread", "Reading the thread failed"),
        "thread_timeline": fixed("Reading the thread history", "Read the thread history", "Reading the thread history failed"),
        "get_message": fixed("Loading the message", "Read the message", "Loading the message failed"),
        "list_account_threads": fixed("Loading the mailbox", "Loaded the mailbox", "Loading the mailbox failed"),
        "list_accounts": fixed("Checking connected accounts", "Checked your connected accounts", "Checking accounts failed"),
        "list_labels": fixed("Listing your labels", "Listed your labels", "Listing labels failed"),
        "list_attachments": fixed("Listing attachments", "Listed the attachments", "Listing attachments failed"),
        "mail_attachment_save": savedFile(running: "Saving the attachment in Files", fallback: "Saved the attachment in Files", failed: "Saving the attachment failed"),
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

        // The Albatross thread (docs/albatross-thread.md)
        "albatross_handle_step": { _, out in
            switch out["action"]?.stringValue {
            case "resumed":
                return ShapeActivity(running: "Continuing the step", done: "Continued the step", failed: "Continuing the step failed")
            case "steered":
                return ShapeActivity(running: "Passing your note to the step", done: "Passed your note to the step in progress", failed: "Passing your note failed")
            case "stopped":
                return ShapeActivity(running: "Stopping the step", done: "Stopped the step", failed: "Stopping the step failed")
            default:
                return ShapeActivity(running: "Starting the step", done: "Started on the step", failed: "Starting the step failed")
            }
        },
        "personal_details_get": fixed("Reading your personal details", "Read your personal details", "Reading your personal details failed"),
        "personal_details_save": { _, out in
            let labels = (out["saved"]?.arrayValue ?? []).compactMap { str($0["label"]).nilIfBlank }
            return ShapeActivity(
                running: "Saving to your details",
                done: labels.isEmpty ? "Saved nothing to your details" : "Saved to your details: \(labels.joined(separator: ", "))",
                failed: "Saving to your details failed"
            )
        },
        "secure_details_list": fixed("Checking Passwords and IDs", "Checked what is in Passwords and IDs", "Checking Passwords and IDs failed"),
        "ask_form": fixed("Asking you a question", "You answered", "The question failed"),
        "ask_secure_detail": { args, _ in
            let site = str(args["site"])
            let what: String
            switch str(args["kind"]) {
            case "sign_in": what = site.isEmpty ? "a sign-in" : "a sign-in for \(site)"
            case "api_key": what = site.isEmpty ? "an API key" : "an API key for \(site)"
            case "date_of_birth": what = "your date of birth"
            default: what = "an ID number"
            }
            return ShapeActivity(
                running: "Asking you to add \(what)",
                done: "Asked you to add \(what)",
                failed: "Asking you to add \(what) failed"
            )
        },
        "ask_presentation_choices": fixed("Choosing your presentation direction", "Your presentation choices", "Loading the presentation choices failed"),

        // Albatross work and areas
        "albatross_record_progress": fixed("Recording progress", "Recorded progress", "Recording progress failed"),
        "albatross_replan_work": fixed("Replanning the Work", "Replanned the Work", "Replanning failed"),
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

        "web_research": { args, out in
            let question = clip(str(args["question"]), max: 80)
            let count = out["sources"]?.arrayValue?.count
            let done: String
            if let count {
                done = "Read \(plural(count, "source"))" + (question.isEmpty ? "" : " for “\(question)”")
            } else {
                done = "Researched on the web"
            }
            return ShapeActivity(
                running: question.isEmpty ? "Researching on the web" : "Researching “\(question)”",
                done: done,
                failed: "Web research failed"
            )
        },
        "web_file_save": savedFile(running: "Saving the file in Files", fallback: "Saved the file in Files", failed: "Saving the file failed"),

        // PDF forms
        "pdf_form_fields": fixed("Reading the form fields", "Read the form fields", "Reading the form fields failed"),
        "pdf_form_fill": { _, out in
            let title = str(out["title"])
            return ShapeActivity(
                running: "Filling the form",
                done: title.isEmpty ? "Filled the form" : "Filled the form: \(title)",
                failed: "Filling the form failed"
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
        "show_video": fixed("Preparing the video", "Showed the video", "Preparing the video failed"),
        "show_audio": fixed("Preparing the audio", "Showed the audio", "Preparing the audio failed"),
        "show_carousel": fixed("Laying out the collection", "Laid out the collection", "Laying out the collection failed"),
        "show_order_summary": fixed("Itemizing the order", "Itemized the order", "Itemizing the order failed"),
        "show_social_post": fixed("Rendering the post", "Rendered the post", "Rendering the post failed"),

        // The rest of the web table (lib/albatross/teach-ui.ts), so no
        // registered tool falls back to the generic line.
        "area_domain_activity": { args, _ in
            let scope = str(args["domain"]).nilIfBlank ?? str(args["senderEmail"])
            return ShapeActivity(
                running: scope.isEmpty ? "Checking recent senders" : "Checking recent senders for \(scope)",
                done: scope.isEmpty ? "Checked recent senders" : "Checked recent senders for \(scope)",
                failed: "Checking recent senders failed"
            )
        },
        "area_discover_context": fixed("Searching connected context for Areas", "Searched connected context for Areas", "Area context search failed"),
        "area_artifact_set_status": fixed("Saving your answer about this relationship", "Saved your answer about this relationship", "Saving the relationship answer failed"),
        "area_archive": { args, _ in
            let reason = str(args["reason"])
            return ShapeActivity(
                running: "Archiving the area",
                done: reason.isEmpty ? "Area archived — history kept" : "Area archived — \(reason)",
                failed: "Archiving the area failed"
            )
        },
        "area_add_fact": { args, out in
            let value = str(args["value"])
            let status = out["status"] ?? .null
            let verified = str(status) == "verified" || (status == .null && args["confirmedByUser"]?.boolValue == true)
            return ShapeActivity(
                running: value.isEmpty ? "Recording a fact" : "Recording \(clip(value, max: 80))",
                done: verified ? "Recorded fact — verified" : "Recorded fact — to confirm",
                failed: "Recording the fact failed"
            )
        },
        "area_fact_set_status": { args, _ in
            switch str(args["status"]) {
            case "verified": return ShapeActivity(running: "Verifying the fact", done: "Fact verified", failed: "Verifying the fact failed")
            case "rejected": return ShapeActivity(running: "Rejecting the fact", done: "Fact rejected", failed: "Rejecting the fact failed")
            case "superseded": return ShapeActivity(running: "Retiring the fact", done: "Fact superseded", failed: "Retiring the fact failed")
            default: return ShapeActivity(running: "Updating the fact", done: "Fact updated", failed: "Updating the fact failed")
            }
        },
        "salvage_context": fixed("Recovering earlier context", "Recovered earlier context", "Recovering earlier context failed"),
        "restore_from_trash": fixed("Restoring from trash", "Restored from trash", "Restoring from trash failed"),
        "star": fixed("Starring the thread", "Starred the thread", "Starring the thread failed"),
        "unstar": fixed("Unstarring the thread", "Unstarred the thread", "Unstarring the thread failed"),
        "add_label": { args, _ in
            let label = str(args["label"])
            return ShapeActivity(
                running: label.isEmpty ? "Adding a label" : "Adding the “\(label)” label",
                done: label.isEmpty ? "Added a label" : "Added the “\(label)” label",
                failed: label.isEmpty ? "Adding the label failed" : "Adding the “\(label)” label failed"
            )
        },
        "remove_label": { args, _ in
            let label = str(args["label"])
            return ShapeActivity(
                running: label.isEmpty ? "Removing a label" : "Removing the “\(label)” label",
                done: label.isEmpty ? "Removed a label" : "Removed the “\(label)” label",
                failed: "Removing the label failed"
            )
        },
        "create_label": { args, _ in
            let name = str(args["name"]).nilIfBlank ?? str(args["label"])
            return ShapeActivity(
                running: name.isEmpty ? "Creating a label" : "Creating the “\(name)” label",
                done: name.isEmpty ? "Created a label" : "Created the “\(name)” label",
                failed: "Creating the label failed"
            )
        },
        "save_draft": fixed("Saving the draft", "Saved the draft", "Saving the draft failed"),
        "update_draft": fixed("Updating the draft", "Updated the draft", "Updating the draft failed"),
        "delete_draft": fixed("Deleting the draft", "Deleted the draft", "Deleting the draft failed"),
        "list_drafts": fixed("Listing your drafts", "Listed your drafts", "Listing drafts failed"),
        "schedule_send": fixed("Scheduling the send", "Scheduled the send", "Scheduling the send failed"),
        "cancel_scheduled": fixed("Canceling the scheduled send", "Canceled the scheduled send", "Canceling the scheduled send failed"),
        "undo_send": fixed("Undoing the send", "Undid the send", "Undoing the send failed"),
        "triage_thread": { _, out in
            let reason = str(out["reason"])
            return ShapeActivity(
                running: "Triaging the thread",
                done: reason.isEmpty ? "Triaged the thread" : "Triaged — \(clip(reason))",
                failed: "Triaging the thread failed"
            )
        },
        "bulk_triage": fixed("Triaging the batch", "Triaged the batch", "Triaging the batch failed"),
        "extract_action_items": fixed("Pulling out action items", "Pulled out the action items", "Pulling action items failed"),
        "translate_thread": fixed("Translating the thread", "Translated the thread", "Translating failed"),
        "pre_send_critique": fixed("Reviewing the draft", "Reviewed the draft", "Reviewing the draft failed"),
        "presentation_plan": fixed("Planning the evidence and visuals for every slide", "Planned the presentation slides", "Presentation planning failed; retrying needs the gathered evidence"),
        "document_review_slides": fixed("Checking every slide visually", "Finished the slide check", "Slide check failed"),
        "word_document_create": fixed("Creating the Word document", "Created the Word document", "Creating the Word document failed"),
        "word_document_get": fixed("Reading the Word document", "Read the Word document", "Reading the Word document failed"),
        "word_document_edit": fixed("Editing the Word document", "Saved a new Word revision", "Editing the Word document failed"),
        "forget": fixed("Forgetting that note", "Forgot that note", "Forgetting the note failed"),
        "list_memories": fixed("Listing saved notes", "Listed the saved notes", "Listing notes failed"),
        "calendar_delete_recurring_series": fixed("Deleting the recurring series", "Deleted the recurring series", "Deleting the series failed"),
        "calendar_unsubscribe_calendar": fixed("Unsubscribing the calendar", "Unsubscribed the calendar", "Unsubscribing the calendar failed"),
        "tasks_attach_link": { args, _ in
            let url = str(args["url"])
            return ShapeActivity(
                running: "Attaching a link to the task",
                done: url.isEmpty ? "Attached a link to the task" : "Attached \(clip(url, max: 80)) to the task",
                failed: "Attaching the link failed"
            )
        },
        "tasks_attach_file": { _, out in
            let name = str(out["name"])
            return ShapeActivity(
                running: "Attaching a file to the task",
                done: name.isEmpty ? "Attached a file to the task" : "Attached \(name) to the task",
                failed: "Attaching the file failed"
            )
        },
        "tasks_attach_calendar_event_link": { _, out in
            let name = str(out["name"])
            return ShapeActivity(
                running: "Attaching a calendar link to the task",
                done: name.isEmpty ? "Attached a calendar link to the task" : "Attached calendar link “\(name)” to the task",
                failed: "Attaching the calendar link failed"
            )
        },
        "expand_alias": fixed("Expanding the alias", "Expanded the alias", "Expanding the alias failed"),
        "browser_download": savedFile(running: "Saving the file from the page", fallback: "Saved the file in Files", failed: "Saving the file failed"),
        "ui_focus_thread": fixed("Opening the thread", "Opened that thread in your reader", "Opening the thread failed"),
        "ui_set_query": { args, _ in
            let query = str(args["query"])
            return ShapeActivity(
                running: "Filtering your inbox",
                done: query.isEmpty ? "Filtered your inbox" : "Filtered your inbox to “\(query)”",
                failed: "Filtering the inbox failed"
            )
        },
        "ui_open_compose": { args, _ in
            let to = str(args["to"])
            return ShapeActivity(
                running: "Opening the composer",
                done: to.isEmpty ? "Opened the composer" : "Opened the composer to \(to)",
                failed: "Opening the composer failed"
            )
        },
        "ui_open_reply": fixed("Opening a reply", "Opened a reply for you to review", "Opening the reply failed"),
        "ui_toast": fixed("Sending a notification", "Notified you", "Sending the notification failed"),
        "ui_close_bar": fixed("Closing the assistant", "Closed the assistant", "Closing the assistant failed"),
        "ui_switch_account": { args, _ in
            let account = str(args["account"])
            return ShapeActivity(
                running: account.isEmpty ? "Switching accounts" : "Switching to \(account)",
                done: account.isEmpty ? "Switched accounts" : "Switched to \(account)",
                failed: "Switching accounts failed"
            )
        },
    ]
}
