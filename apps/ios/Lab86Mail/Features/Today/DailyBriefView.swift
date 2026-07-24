import SwiftUI
import WebKit

// The Daily Report artifact — the same self-contained editorial HTML the desktop
// renders — shown in a dedicated sandboxed WKWebView inside a native SwiftUI
// shell. The stored/model-authored HTML is untrusted: every script and dangerous
// element/handler is stripped, and the ONLY script that runs is a nonce-scoped
// native click bridge that posts a message solely from a real user click on a
// `data-action` element. Actions never mutate a provider directly — read-only
// open_* routes navigate; everything else is handed back to the caller.

struct DailyBriefView: View {
    let report: DailyReportModel
    let lastRefresh: Date?
    let isOffline: Bool
    let onAction: (String, BriefActionPayload) -> Void
    let onRegenerate: () -> Void

    @Environment(AppEnvironment.self) private var environment
    @Environment(\.openURL) private var openURL
    @State private var artifactHeight: CGFloat = 360
    // A fresh nonce per rendered edition; only the injected bridge carries it, so
    // any other inline/remote script is refused by the CSP.
    @State private var nonce = UUID().uuidString

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            statusStrip
            // The web view exposes the artifact's headings, text, and action
            // buttons to VoiceOver via its DOM — no wrapper label that would
            // collapse it into a single element.
            BriefArtifactWebView(
                html: BriefArtifactDocument.make(
                    from: report.html ?? "",
                    nonce: nonce,
                    themeCSS: environment.theme.briefThemeCSS
                ),
                contentHeight: $artifactHeight,
                onAction: onAction,
                onOpenURL: { openURL($0) }
            )
            .frame(height: artifactHeight)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(report.title))
    }

    @ViewBuilder private var statusStrip: some View {
        HStack(spacing: 8) {
            if report.isGenerating {
                ProgressView().controlSize(.small)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Putting today’s brief together…")
                        .font(.footnote.weight(.medium))
                    if let progress = report.progress, progress.total > 0 {
                        ProgressView(value: progress.fraction)
                            .frame(maxWidth: 200)
                    }
                }
            } else {
                Image(systemName: isOffline ? "wifi.slash" : "checkmark.seal")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Text(freshnessText)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            if !report.isGenerating {
                Button("Regenerate", action: onRegenerate)
                    .font(.footnote.weight(.medium))
                    .buttonStyle(.plain)
                    .foregroundStyle(.tint)
                    .accessibilityHint("Builds a fresh edition of today’s brief")
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .accessibilityElement(children: .combine)
    }

    private var freshnessText: String {
        if isOffline { return "Showing your last saved brief." }
        guard let lastRefresh else { return report.title }
        return "Updated \(lastRefresh.formatted(date: .omitted, time: .shortened))"
    }
}

// Typed, Sendable projection of a `data-action` payload. Only the fields native
// routing needs are read; nothing model-authored is trusted beyond these strings.
struct BriefActionPayload: Hashable, Sendable {
    var account: String?
    var threadID: String?
    var eventID: String?
    var areaID: String?
    var workID: String?
    var calendarID: String?
    var view: String?
    var url: String?
    var cardID: String?
    var title: String?
    var subject: String?
    var body: String?
    var status: String?
    var trackedThreadID: String?
    var previousStatus: String?
    var text: String?
    var questionID: String?
    var answeredOptionID: String?
    var completed: Bool?
    var receivedAt: Double?
    var dueAt: Double?
    var startAt: Double?
    var endAt: Double?
    var allDay: Bool?
    var location: String?
    var description: String?

    init(
        account: String? = nil,
        threadID: String? = nil,
        eventID: String? = nil,
        areaID: String? = nil,
        workID: String? = nil,
        calendarID: String? = nil,
        view: String? = nil,
        url: String? = nil,
        cardID: String? = nil,
        title: String? = nil,
        subject: String? = nil,
        body: String? = nil,
        status: String? = nil,
        trackedThreadID: String? = nil,
        previousStatus: String? = nil,
        text: String? = nil,
        questionID: String? = nil,
        answeredOptionID: String? = nil,
        completed: Bool? = nil,
        receivedAt: Double? = nil,
        dueAt: Double? = nil,
        startAt: Double? = nil,
        endAt: Double? = nil,
        allDay: Bool? = nil,
        location: String? = nil,
        description: String? = nil
    ) {
        self.account = account
        self.threadID = threadID
        self.eventID = eventID
        self.areaID = areaID
        self.workID = workID
        self.calendarID = calendarID
        self.view = view
        self.url = url
        self.cardID = cardID
        self.title = title
        self.subject = subject
        self.body = body
        self.status = status
        self.trackedThreadID = trackedThreadID
        self.previousStatus = previousStatus
        self.text = text
        self.questionID = questionID
        self.answeredOptionID = answeredOptionID
        self.completed = completed
        self.receivedAt = receivedAt
        self.dueAt = dueAt
        self.startAt = startAt
        self.endAt = endAt
        self.allDay = allDay
        self.location = location
        self.description = description
    }

    init(rawMessageBody: Any?) {
        let dict = (rawMessageBody as? [String: Any]) ?? [:]
        func string(_ keys: String...) -> String? {
            for key in keys {
                if let value = dict[key] as? String, !value.isEmpty { return value }
            }
            return nil
        }
        account = string("account", "accountId")
        threadID = string("threadId", "thread")
        eventID = string("eventId", "event")
        areaID = string("areaId", "area")
        workID = string("workId", "work")
        calendarID = string("calendarId", "calendar")
        view = string("view")
        url = string("url")
        cardID = string("cardId", "card")
        title = string("title")
        subject = string("subject")
        body = string("body")
        status = string("status")
        trackedThreadID = string("trackedThreadId")
        previousStatus = string("previousStatus")
        text = string("text")
        questionID = string("questionId")
        answeredOptionID = string("answeredOptionId")
        func number(_ key: String) -> Double? {
            if let value = dict[key] as? NSNumber { return value.doubleValue }
            if let value = dict[key] as? Double { return value }
            return nil
        }
        func boolean(_ key: String) -> Bool? {
            if let value = dict[key] as? NSNumber { return value.boolValue }
            return dict[key] as? Bool
        }
        completed = boolean("completed")
        allDay = boolean("allDay")
        receivedAt = number("receivedAt")
        dueAt = number("dueAt")
        startAt = number("startAt")
        endAt = number("endAt")
        location = string("location")
        description = string("description")
    }
}

struct ArtifactReviewRequest: Identifiable, Hashable, Sendable {
    let action: String
    let payload: BriefActionPayload
    let source: String
    let id = UUID()

    var title: String {
        switch action {
        case "toggle_task":
            return payload.completed == true
                ? "Complete “\(payload.title ?? "this task")”?"
                : "Reopen “\(payload.title ?? "this task")”?"
        case "dismiss_task": return "Remove “\(payload.title ?? "this task")” from future briefs?"
        case "resolve_thread": return "Resolve “\(payload.subject ?? "this thread")”?"
        case "dismiss_thread": return "Remove “\(payload.subject ?? "this conversation")” from future briefs?"
        case "archive_thread": return "Archive “\(payload.subject ?? "this conversation")”?"
        case "rsvp_event": return "Send a “\(payload.status ?? "response")” RSVP?"
        case "create_task": return "Add “\(payload.title ?? "this task")”?"
        case "create_event": return "Add “\(payload.title ?? "this event")” to your calendar?"
        case "draft_reply": return "Open this reply for review?"
        case "capture_intent": return "Capture “\(payload.text ?? "this thought")”?"
        case "answer_question": return "Submit “\(payload.text ?? "this answer")”?"
        default: return "Review \(action.replacingOccurrences(of: "_", with: " "))"
        }
    }

    var destructive: Bool {
        ["dismiss_task", "resolve_thread", "dismiss_thread", "archive_thread"].contains(action)
    }

    var supported: Bool {
        [
            "toggle_task", "dismiss_task", "resolve_thread", "dismiss_thread",
            "archive_thread", "rsvp_event", "create_task", "create_event",
            "draft_reply", "capture_intent", "answer_question",
        ].contains(action)
    }
}

struct ArtifactActionReviewSheet: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss
    let request: ArtifactReviewRequest
    let onApplied: () async -> Void
    @State private var isApplying = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Source") {
                    Label(request.source, systemImage: "doc.text")
                }
                Section("Proposed action") {
                    Text(request.title)
                        .font(.headline)
                    LabeledContent("Action", value: request.action.replacingOccurrences(of: "_", with: " ").capitalized)
                    if let account = request.payload.account {
                        LabeledContent("Account", value: account)
                    }
                    if let status = request.payload.status {
                        LabeledContent("Response", value: status.capitalized)
                    }
                    if !request.supported {
                        Text("This edition requested an action the native client cannot validate. Nothing has changed.")
                            .foregroundStyle(.secondary)
                    }
                }
                if let errorMessage {
                    Section {
                        Label(errorMessage, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Review Action")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(request.destructive ? "Confirm" : "Apply") {
                        Task { await apply() }
                    }
                    .tint(request.destructive ? .red : .accentColor)
                    .disabled(isApplying || !request.supported)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func apply() async {
        isApplying = true
        defer { isApplying = false }
        do {
            try await perform()
            await onApplied()
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func perform() async throws {
        let payload = request.payload
        switch request.action {
        case "toggle_task":
            guard let cardID = payload.cardID, let completed = payload.completed else {
                throw BackendError.server(status: 400, message: "The report omitted the task state.")
            }
            _ = try await environment.tools.invoke(
                "tasks_update_card",
                arguments: ["cardId": .string(cardID), "completed": .bool(completed)]
            )
            if completed {
                _ = try? await environment.tools.invoke(
                    "dismiss_daily_report_task",
                    arguments: [
                        "cardId": .string(cardID),
                        "title": payload.title.map(JSONValue.string) ?? .null,
                    ]
                )
            }
        case "dismiss_task":
            guard let cardID = payload.cardID else {
                throw BackendError.server(status: 400, message: "The report omitted the task identifier.")
            }
            _ = try await environment.tools.invoke(
                "dismiss_daily_report_task",
                arguments: [
                    "cardId": .string(cardID),
                    "title": payload.title.map(JSONValue.string) ?? .null,
                ]
            )
        case "resolve_thread", "dismiss_thread":
            try await dismissThread(resolved: request.action == "resolve_thread")
            if request.action == "resolve_thread", let trackedID = payload.trackedThreadID {
                _ = try await environment.tools.invoke(
                    "resolve_tracked_thread",
                    arguments: ["id": .string(trackedID)]
                )
            }
        case "archive_thread":
            guard let account = payload.account, let threadID = payload.threadID else {
                throw BackendError.server(status: 400, message: "The report omitted the mail identity.")
            }
            _ = try await environment.tools.invoke(
                "archive_thread",
                arguments: ["account": .string(account), "threadId": .string(threadID)]
            )
            try await dismissThread(resolved: false)
        case "rsvp_event":
            guard let account = payload.account,
                  let eventID = payload.eventID,
                  let calendarID = payload.calendarID,
                  let status = payload.status,
                  ["yes", "no", "maybe"].contains(status) else {
                throw BackendError.server(status: 400, message: "The report omitted valid RSVP context.")
            }
            _ = try await environment.tools.invoke(
                "calendar_rsvp_event",
                arguments: [
                    "account": .string(account),
                    "calendarId": .string(calendarID),
                    "eventId": .string(eventID),
                    "status": .string(status),
                ]
            )
        case "create_task":
            guard let title = payload.title?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !title.isEmpty else {
                throw BackendError.server(status: 400, message: "The report omitted the task title.")
            }
            var arguments: [String: JSONValue] = ["title": .string(title)]
            if let dueAt = payload.dueAt {
                arguments["dueIso"] = .string(Self.date(dueAt).formatted(.iso8601))
            }
            _ = try await environment.tools.invoke("tasks_create_card", arguments: arguments)
        case "create_event":
            guard let account = payload.account,
                  let title = payload.title?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !title.isEmpty,
                  let startAt = payload.startAt,
                  let endAt = payload.endAt else {
                throw BackendError.server(status: 400, message: "The report omitted required event details.")
            }
            var arguments: [String: JSONValue] = [
                "account": .string(account),
                "title": .string(title),
                "startIso": .string(Self.date(startAt).formatted(.iso8601)),
                "endIso": .string(Self.date(endAt).formatted(.iso8601)),
                "allDay": .bool(payload.allDay ?? false),
                "attendees": .array([]),
            ]
            if let calendarID = payload.calendarID { arguments["calendarId"] = .string(calendarID) }
            if let location = payload.location { arguments["location"] = .string(location) }
            if let description = payload.description { arguments["description"] = .string(description) }
            _ = try await environment.tools.invoke("calendar_create_event", arguments: arguments)
        case "draft_reply":
            guard let account = payload.account, let threadID = payload.threadID else {
                throw BackendError.server(status: 400, message: "The brief omitted the reply context.")
            }
            await MainActor.run {
                environment.navigation.pendingCompose = ComposePrefill(
                    recipient: "",
                    cc: "",
                    bcc: "",
                    subject: payload.subject ?? "",
                    body: payload.body ?? "",
                    mode: "reply",
                    accountID: account,
                    threadID: threadID,
                    messageID: nil,
                    replyAll: false,
                    attachmentsKey: nil,
                    draftID: nil
                )
                environment.navigation.sheet = .compose
            }
        case "capture_intent":
            guard let text = payload.text?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !text.isEmpty else {
                throw BackendError.server(status: 400, message: "The brief omitted the text to capture.")
            }
            _ = try await environment.backend.post(
                path: "/api/albatross/capture",
                body: .object([
                    "rawText": .string(text),
                    "source": .string("chat"),
                    "areaId": payload.areaID.map(JSONValue.string) ?? .null,
                    "timezone": .string(TimeZone.current.identifier),
                ])
            )
        case "answer_question":
            guard let questionID = payload.questionID,
                  let text = payload.text?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !text.isEmpty else {
                throw BackendError.server(status: 400, message: "The brief omitted the answer context.")
            }
            _ = try await environment.backend.post(
                path: "/api/albatross/work/questions/\(questionID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? questionID)/answer",
                body: .object([
                    "answer": .string(text),
                    "answeredOptionId": payload.answeredOptionID.map(JSONValue.string) ?? .null,
                    "timezone": .string(TimeZone.current.identifier),
                ])
            )
        default:
            throw BackendError.server(status: 400, message: "Unsupported report action.")
        }
    }

    private func dismissThread(resolved: Bool) async throws {
        guard let account = request.payload.account, let threadID = request.payload.threadID else {
            throw BackendError.server(status: 400, message: "The report omitted the mail identity.")
        }
        _ = try await environment.tools.invoke(
            "dismiss_daily_report_thread",
            arguments: [
                "account": .string(account),
                "threadId": .string(threadID),
                "subject": request.payload.subject.map(JSONValue.string) ?? .null,
                "receivedAt": request.payload.receivedAt.map(JSONValue.number) ?? .null,
                "action": .string(resolved ? "resolved" : "dismissed"),
            ]
        )
    }

    private static func date(_ timestamp: Double) -> Date {
        Date(timeIntervalSince1970: timestamp > 10_000_000_000 ? timestamp / 1_000 : timestamp)
    }
}

enum BriefArtifactDocument {
    // Strip every script/handler/dangerous element from the untrusted artifact,
    // then inject a strict CSP (whose only allowed script is our nonce) plus the
    // trusted click bridge. Idempotence is not required — a fresh nonce/document
    // is produced per render.
    static func make(from rawHTML: String, nonce: String, themeCSS: String = "") -> String {
        var html = rawHTML

        html = html.replacingOccurrences(
            of: #"<script\b[^>]*>[\s\S]*?</script\s*>"#,
            with: "",
            options: [.regularExpression, .caseInsensitive]
        )
        html = html.replacingOccurrences(
            // Keep ordinary buttons: the report artifact deliberately uses
            // <button data-action=...> for its native-routed controls. Forms,
            // inputs, model scripts, and inline handlers are removed, while
            // CSP `form-action 'none'` provides defense in depth.
            of: #"<(?:script|iframe|object|embed|form|input|base)\b[^>]*/?>"#,
            with: "",
            options: [.regularExpression, .caseInsensitive]
        )
        html = html.replacingOccurrences(
            of: #"<meta\b[^>]*http-equiv\s*=\s*['"]?refresh['"]?[^>]*>"#,
            with: "",
            options: [.regularExpression, .caseInsensitive]
        )
        // Inline event handlers and srcdoc — the model must not smuggle script in.
        html = html.replacingOccurrences(
            of: #"\s(?:on[a-z]+|srcdoc)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)"#,
            with: "",
            options: [.regularExpression, .caseInsensitive]
        )
        // Neutralize javascript: URLs (defense in depth; link policy also blocks them).
        html = html.replacingOccurrences(
            of: #"(href|src)\s*=\s*(['"])\s*javascript:[^'"]*(['"])"#,
            with: "$1=$2#$3",
            options: [.regularExpression, .caseInsensitive]
        )

        let head = securityHead(nonce: nonce)
        let bridge = "<script nonce=\"\(nonce)\">\(bridgeJS)</script>"

        if let headRange = html.range(of: #"<head\b[^>]*>"#, options: [.regularExpression, .caseInsensitive]) {
            html.insert(contentsOf: head, at: headRange.upperBound)
        } else if let htmlRange = html.range(of: #"<html\b[^>]*>"#, options: [.regularExpression, .caseInsensitive]) {
            html.insert(contentsOf: "<head>\(head)</head>", at: htmlRange.upperBound)
        } else {
            html = "<!doctype html><html><head>\(head)</head><body>\(html)</body></html>"
        }

        // Theme tokens go at the END of the head so they override the
        // artifact's own :root declarations — the same precedence the desktop
        // host achieves by posting resolved variables into the live document.
        if !themeCSS.isEmpty {
            let themedStyle = "<style data-host-theme>\(themeCSS)</style>"
            if let headClose = html.range(of: "</head>", options: [.caseInsensitive]) {
                html.insert(contentsOf: themedStyle, at: headClose.lowerBound)
            } else {
                html = themedStyle + html
            }
        }

        if let bodyClose = html.range(of: "</body>", options: [.caseInsensitive, .backwards]) {
            html.insert(contentsOf: bridge, at: bodyClose.lowerBound)
        } else {
            html += bridge
        }
        return html
    }

    private static func securityHead(nonce: String) -> String {
        """
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob: https: http:; style-src 'unsafe-inline' https:; font-src data: https:; script-src 'nonce-\(nonce)'; connect-src 'none'; frame-src 'none'; child-src 'none'; object-src 'none'; media-src 'none'; form-action 'none'; base-uri 'none'">
        <meta name="referrer" content="no-referrer">
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=6">
        <style>
        /* Mobile correction for stored editions: this webview grows to its
           content, so vh-based masthead sizing resolves against the full
           artifact height and blows the painting up to several screens tall.
           Editions have used both `.hero > .masthead` and `header.masthead`
           vocabularies — pin either container to a fixed editorial height. */
        @media (max-width: 700px) {
            .hero, header.masthead {
                height: 300px !important;
                min-height: 240px !important;
                max-height: 340px !important;
                overflow: hidden !important;
            }
            .masthead { min-height: 0 !important; padding: 1.5rem !important; }
            .masthead-title { padding: 1.25rem !important; }
            .masthead h1, .masthead-title h1 { font-size: clamp(2.4rem, 12vw, 4rem) !important; }
            .spine { display: none !important; }
        }
        </style>
        """
    }

    // The whole trusted surface: report height, and forward a click on a
    // `data-action` element — only when the event is user-generated.
    static let bridgeJS = """
    (function(){
      function post(name, body){ try { window.webkit.messageHandlers[name].postMessage(body); } catch (e) {} }
      function reportHeight(){ post('briefHeight', Math.ceil(document.documentElement.scrollHeight || document.body.scrollHeight || 0)); }
      document.addEventListener('click', function(e){
        if (!e.isTrusted) { return; }
        var el = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
        if (!el) { return; }
        var action = el.getAttribute('data-action') || '';
        if (!action) { return; }
        var payload = {};
        try { payload = JSON.parse(el.getAttribute('data-payload') || '{}') || {}; } catch (_) { payload = {}; }
        e.preventDefault();
        post('briefAction', { action: action, payload: payload });
      }, false);
      if (document.readyState !== 'loading') { reportHeight(); }
      window.addEventListener('load', reportHeight);
      window.addEventListener('resize', reportHeight);
      if (window.ResizeObserver && document.body) {
        try { new ResizeObserver(reportHeight).observe(document.body); } catch (_) {}
      }
    })();
    """
}

struct BriefArtifactWebView: UIViewRepresentable {
    static let minimumHeight: CGFloat = 200
    static let maximumHeight: CGFloat = 20_000

    let html: String
    @Binding var contentHeight: CGFloat
    let onAction: (String, BriefActionPayload) -> Void
    let onOpenURL: (URL) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    func makeUIView(context: Context) -> WKWebView {
        let controller = WKUserContentController()
        controller.add(context.coordinator, name: "briefAction")
        controller.add(context.coordinator, name: "briefHeight")

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController = controller
        // JS is required for the nonce bridge; the CSP allows nothing else.
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.mediaTypesRequiringUserActionForPlayback = .all

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.isOpaque = false
        webView.backgroundColor = .clear
        // The outer SwiftUI ScrollView owns scrolling; the artifact sizes to content.
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        webView.scrollView.showsVerticalScrollIndicator = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        context.coordinator.load(html, in: webView)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.load(html, in: webView)
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        let controller = webView.configuration.userContentController
        controller.removeScriptMessageHandler(forName: "briefAction")
        controller.removeScriptMessageHandler(forName: "briefHeight")
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        var parent: BriefArtifactWebView
        private var loadedDocument: String?

        init(parent: BriefArtifactWebView) {
            self.parent = parent
        }

        func load(_ document: String, in webView: WKWebView) {
            guard loadedDocument != document else { return }
            loadedDocument = document
            #if DEBUG
            // Diagnostics for development installs: persist the composed
            // document so it can be pulled from the app container.
            try? document.write(
                to: FileManager.default.temporaryDirectory.appendingPathComponent("brief-debug.html"),
                atomically: true,
                encoding: .utf8
            )
            #endif
            webView.loadHTMLString(document, baseURL: nil)
        }

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            switch message.name {
            case "briefHeight":
                guard let value = (message.body as? NSNumber)?.doubleValue else { return }
                let bounded = min(
                    max(CGFloat(value), BriefArtifactWebView.minimumHeight),
                    BriefArtifactWebView.maximumHeight
                )
                if abs(parent.contentHeight - bounded) > 1 { parent.contentHeight = bounded }
            case "briefAction":
                guard let dictionary = message.body as? [String: Any] else { return }
                let action = (dictionary["action"] as? String) ?? ""
                guard !action.isEmpty else { return }
                parent.onAction(action, BriefActionPayload(rawMessageBody: dictionary["payload"]))
            default:
                break
            }
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction
        ) async -> WKNavigationActionPolicy {
            guard navigationAction.navigationType == .linkActivated,
                  let url = navigationAction.request.url else {
                return .allow
            }
            guard EmailLinkPolicy.canOpen(url) else { return .cancel }
            parent.onOpenURL(url)
            return .cancel
        }
    }
}
