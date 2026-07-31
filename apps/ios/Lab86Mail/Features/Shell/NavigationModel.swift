import Foundation
import Observation

enum PrimaryTab: String, Hashable, CaseIterable, Identifiable, Sendable {
    case today
    case tasks
    case calendar
    case work
    case files
    // Mail is intentionally not a peer in the visible source list. It remains
    // a routable root for Siri, search, notifications, and unfiled mail.
    case mail
    // A conversation with Albatross, separate from intent capture. Started
    // from the sidebar plus; never listed as a peer destination.
    case chat

    var id: Self { self }

    var title: String {
        switch self {
        case .today: "Brief"
        case .mail: "Mail"
        case .calendar: "Calendar"
        case .tasks: "Tasks"
        case .work: "Areas"
        case .files: "Files"
        case .chat: "Chat"
        }
    }

    var symbol: String {
        switch self {
        case .today: "doc.text.image"
        case .mail: "envelope"
        case .calendar: "calendar"
        case .tasks: "checklist"
        case .work: "square.stack.3d.up"
        case .files: "folder"
        case .chat: "bubble"
        }
    }

    // Files belongs with the personal productivity destinations. Areas stays
    // last as the handoff into the user's contextual workspace hierarchy.
    static let sourceList: [PrimaryTab] = [.today, .tasks, .calendar, .files, .work]
}

struct ThreadRoute: Identifiable, Hashable, Sendable {
    let accountID: String
    let threadID: String
    var id: String { "\(accountID):\(threadID)" }
}

struct EventRoute: Identifiable, Hashable, Sendable {
    let accountID: String
    let eventID: String
    let calendarID: String?
    // Optional preloaded summary so detail opened from an Area event (which is
    // not in the Calendar window) still renders its header immediately. Excluded
    // from identity so it never churns the navigation destination.
    let preview: CalendarEventSummary?

    var id: String { "\(accountID):\(eventID)" }

    static func == (lhs: EventRoute, rhs: EventRoute) -> Bool {
        lhs.accountID == rhs.accountID && lhs.eventID == rhs.eventID && lhs.calendarID == rhs.calendarID
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(accountID)
        hasher.combine(eventID)
        hasher.combine(calendarID)
    }
}

struct AreaRoute: Identifiable, Hashable, Sendable {
    let areaID: String
    let name: String?

    var id: String { areaID }

    static func == (lhs: AreaRoute, rhs: AreaRoute) -> Bool { lhs.areaID == rhs.areaID }

    func hash(into hasher: inout Hasher) { hasher.combine(areaID) }
}

struct WorkRoute: Identifiable, Hashable, Sendable {
    let workID: String
    let title: String?

    var id: String { workID }

    static func == (lhs: WorkRoute, rhs: WorkRoute) -> Bool { lhs.workID == rhs.workID }

    func hash(into hasher: inout Hasher) { hasher.combine(workID) }
}

struct ProjectRoute: Identifiable, Hashable, Sendable {
    let project: ProjectSummary
    var id: String { project.id }
}

struct GoogleDocumentRoute: Hashable, Sendable {
    let connectionID: String
    let fileID: String
    let mimeType: String
    let webURL: URL?
}

enum DocumentRouteSource: Hashable, Sendable {
    case albatross(documentID: String)
    case google(GoogleDocumentRoute)
}

struct DocumentRoute: Identifiable, Hashable, Sendable {
    let source: DocumentRouteSource

    var documentID: String {
        switch source {
        case .albatross(let documentID):
            return documentID
        case .google(let google):
            return google.fileID
        }
    }

    var id: String {
        switch source {
        case .albatross(let documentID):
            return "albatross:\(documentID)"
        case .google(let google):
            return "google:\(google.connectionID):\(google.fileID)"
        }
    }
}

struct ComposePrefill: Hashable, Sendable {
    let recipient: String
    let cc: String
    let bcc: String
    let subject: String
    let body: String
    let mode: String
    let accountID: String?
    let threadID: String?
    let messageID: String?
    let replyAll: Bool
    let attachmentsKey: String?
    let draftID: String?
}

enum SheetDestination: Identifiable, Sendable {
    case assistant
    case activity
    case compose
    case settings

    var id: String {
        switch self {
        case .assistant: "assistant"
        case .activity: "activity"
        case .compose: "compose"
        case .settings: "settings"
        }
    }
}

@MainActor
@Observable
final class NavigationModel {
    var selectedTab: PrimaryTab = .today
    var threadRoute: ThreadRoute?
    var eventRoute: EventRoute?
    var areaRoute: AreaRoute?
    var workRoute: WorkRoute?
    var projectRoute: ProjectRoute?
    var documentRoute: DocumentRoute?
    var sheet: SheetDestination?
    var pendingCapture: String?
    var pendingMailSearch: String?
    // Chrome-free surfaces (the area brief hides its navigation bar) raise
    // this to ask the compact shell to reveal the source list; the shell
    // consumes and resets it.
    var requestsSourceList = false
    // Raw MailCategoryScope value chosen from the sidebar's smart filters.
    var pendingMailCategory: String?
    var pendingCompose: ComposePrefill?

    var hasNestedDestination: Bool {
        threadRoute != nil || eventRoute != nil || workRoute != nil
            || projectRoute != nil || documentRoute != nil
    }

    // The compact shell's leading-edge reveal must never compete with the
    // system interactive-pop gesture. Once the pushed destination closes, the
    // same edge is available again to reveal the source list.
    var canRevealSourceList: Bool { !hasNestedDestination }

    func selectPrimary(_ destination: PrimaryTab) {
        selectedTab = destination
        areaRoute = nil
        threadRoute = nil
        eventRoute = nil
        workRoute = nil
        projectRoute = nil
        documentRoute = nil
    }

    // When opened from an Area, mail remains inside that Area's back stack.
    // Global notification/search routes use Mail as a hidden routable root.
    func openThread(accountID: String, threadID: String, preservingCurrentRoot: Bool = false) {
        guard !accountID.isEmpty, !threadID.isEmpty else { return }
        if !preservingCurrentRoot {
            selectedTab = .mail
            areaRoute = nil
            eventRoute = nil
            workRoute = nil
            projectRoute = nil
            documentRoute = nil
        }
        threadRoute = ThreadRoute(accountID: accountID, threadID: threadID)
    }

    func openEvent(_ summary: CalendarEventSummary, preservingCurrentRoot: Bool = false) {
        openEvent(
            accountID: summary.accountID,
            eventID: summary.id,
            calendarID: summary.calendarID,
            preview: summary,
            preservingCurrentRoot: preservingCurrentRoot
        )
    }

    func openEvent(
        accountID: String,
        eventID: String,
        calendarID: String?,
        preview: CalendarEventSummary?,
        preservingCurrentRoot: Bool = false
    ) {
        guard !accountID.isEmpty, !eventID.isEmpty else { return }
        if !preservingCurrentRoot {
            selectedTab = .calendar
            areaRoute = nil
            threadRoute = nil
            workRoute = nil
            projectRoute = nil
            documentRoute = nil
        }
        eventRoute = EventRoute(
            accountID: accountID,
            eventID: eventID,
            calendarID: calendarID,
            preview: preview
        )
    }

    func openArea(id: String, name: String?) {
        guard !id.isEmpty else { return }
        selectedTab = .work
        threadRoute = nil
        eventRoute = nil
        workRoute = nil
        projectRoute = nil
        documentRoute = nil
        areaRoute = AreaRoute(areaID: id, name: name)
    }

    func openWork(id: String, title: String?) {
        guard !id.isEmpty else { return }
        selectedTab = .work
        threadRoute = nil
        eventRoute = nil
        projectRoute = nil
        documentRoute = nil
        workRoute = WorkRoute(workID: id, title: title)
    }

    func openProject(_ project: ProjectSummary) {
        selectedTab = .tasks
        threadRoute = nil
        eventRoute = nil
        workRoute = nil
        areaRoute = nil
        documentRoute = nil
        projectRoute = ProjectRoute(project: project)
    }

    func openDocument(id: String) {
        guard !id.isEmpty else { return }
        selectedTab = .files
        threadRoute = nil
        eventRoute = nil
        workRoute = nil
        areaRoute = nil
        projectRoute = nil
        documentRoute = DocumentRoute(source: .albatross(documentID: id))
    }

    func openGoogleDocument(_ item: CloudFileItem) {
        guard let connectionID = item.connectionID,
              let mimeType = item.mimeType else { return }
        selectedTab = .files
        threadRoute = nil
        eventRoute = nil
        workRoute = nil
        areaRoute = nil
        projectRoute = nil
        documentRoute = DocumentRoute(
            source: .google(
                GoogleDocumentRoute(
                    connectionID: connectionID,
                    fileID: item.id,
                    mimeType: mimeType,
                    webURL: item.webURL
                )
            )
        )
    }

    func openPrimaryView(_ raw: String) {
        let normalized = raw.lowercased()
        if Self.isFilesRoute(normalized) {
            selectPrimary(.files)
            return
        }
        switch normalized {
        case "mail", "inbox": selectPrimary(.mail)
        case "calendar", "events": selectPrimary(.calendar)
        case "tasks", "board": selectPrimary(.tasks)
        case "work", "area", "areas": selectPrimary(.work)
        default: selectPrimary(.today)
        }
    }

    // A notification tap and a Siri deep link both write the route down before
    // announcing it, because the tap that launches the app has nobody to
    // announce to. Reading it here, once, is what makes either arrival open the
    // destination exactly one time.
    func consumePendingDeepLink(defaults: UserDefaults = .standard) {
        guard let route = defaults.string(forKey: "pendingAlbatrossDeepLink") else { return }
        defaults.removeObject(forKey: "pendingAlbatrossDeepLink")
        open(route: route)
    }

    func consumeAppIntentRequests(defaults: UserDefaults = .standard) {
        if defaults.string(forKey: "pendingAlbatrossRoute") == "today" {
            defaults.removeObject(forKey: "pendingAlbatrossRoute")
            selectPrimary(.today)
        }
        consumePendingDeepLink(defaults: defaults)
        if let query = defaults.string(forKey: "pendingAlbatrossMailSearch") {
            defaults.removeObject(forKey: "pendingAlbatrossMailSearch")
            selectPrimary(.mail)
            pendingMailSearch = query
        }
        if let recipient = defaults.string(forKey: "pendingAlbatrossComposeRecipient") {
            pendingCompose = ComposePrefill(
                recipient: recipient,
                cc: defaults.string(forKey: "pendingAlbatrossComposeCC") ?? "",
                bcc: defaults.string(forKey: "pendingAlbatrossComposeBCC") ?? "",
                subject: defaults.string(forKey: "pendingAlbatrossComposeSubject") ?? "",
                body: defaults.string(forKey: "pendingAlbatrossComposeBody") ?? "",
                mode: defaults.string(forKey: "pendingAlbatrossComposeMode") ?? "new",
                accountID: defaults.string(forKey: "pendingAlbatrossComposeAccount"),
                threadID: defaults.string(forKey: "pendingAlbatrossComposeThread"),
                messageID: defaults.string(forKey: "pendingAlbatrossComposeMessage"),
                replyAll: defaults.bool(forKey: "pendingAlbatrossComposeReplyAll"),
                attachmentsKey: defaults.string(forKey: "pendingAlbatrossComposeAttachmentsKey"),
                draftID: defaults.string(forKey: "pendingAlbatrossComposeDraftID")
            )
            for key in [
                "pendingAlbatrossComposeRecipient",
                "pendingAlbatrossComposeCC",
                "pendingAlbatrossComposeBCC",
                "pendingAlbatrossComposeSubject",
                "pendingAlbatrossComposeBody",
                "pendingAlbatrossComposeMode",
                "pendingAlbatrossComposeAccount",
                "pendingAlbatrossComposeThread",
                "pendingAlbatrossComposeMessage",
                "pendingAlbatrossComposeReplyAll",
                "pendingAlbatrossComposeAttachmentsKey",
                "pendingAlbatrossComposeDraftID",
            ] { defaults.removeObject(forKey: key) }
            sheet = .compose
        }
        if let capture = defaults.string(forKey: "pendingAlbatrossCapture") {
            defaults.removeObject(forKey: "pendingAlbatrossCapture")
            pendingCapture = capture
            sheet = .assistant
        }
    }

    func open(_ url: URL) {
        if url.scheme == "mailto" {
            let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
            let query = Dictionary(
                (components?.queryItems ?? []).compactMap { item in item.value.map { (item.name.lowercased(), $0) } },
                uniquingKeysWith: { _, latest in latest }
            )
            pendingCompose = ComposePrefill(
                recipient: components?.path.removingPercentEncoding ?? components?.path ?? "",
                cc: query["cc"] ?? "",
                bcc: query["bcc"] ?? "",
                subject: query["subject"] ?? "",
                body: query["body"] ?? "",
                mode: "new",
                accountID: nil,
                threadID: nil,
                messageID: nil,
                replyAll: false,
                attachmentsKey: nil,
                draftID: nil
            )
            sheet = .compose
            return
        }
        guard url.scheme == "lab86" || url.host?.contains("lab86.io") == true else { return }
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        var query: [String: String] = [:]
        for item in components?.queryItems ?? [] {
            if let value = item.value { query[item.name] = value }
        }
        let route = [url.host, url.path].compactMap { $0 }.joined(separator: "/").lowercased()
        if route.contains("thread"), let account = query["account"] ?? query["accountId"],
           let thread = query["thread"] ?? query["threadId"] ?? query["id"] {
            openThread(accountID: account, threadID: thread)
        } else if route.contains("event"), let account = query["account"] ?? query["accountId"],
                  let event = query["event"] ?? query["eventId"] ?? query["id"] {
            openEvent(
                accountID: account,
                eventID: event,
                calendarID: query["calendar"] ?? query["calendarId"],
                preview: nil
            )
        } else if route.contains("work"), let work = query["work"] ?? query["workId"] ?? query["id"] {
            if let area = query["area"] ?? query["areaId"] {
                openArea(id: area, name: nil)
            }
            openWork(id: work, title: nil)
        } else if route.contains("area"), let area = query["area"] ?? query["areaId"] ?? query["id"] {
            openArea(id: area, name: nil)
        } else if route.contains("document"),
                  let document = query["document"] ?? query["documentId"] ?? query["id"] {
            openDocument(id: document)
        } else if Self.isFilesRoute(route) {
            selectPrimary(.files)
        } else if route.contains("calendar") {
            selectPrimary(.calendar)
        } else if route.contains("task") {
            selectPrimary(.tasks)
        } else if route.contains("work") || route.contains("area") {
            selectPrimary(.work)
        } else if route.contains("activity") || route.contains("approval") || route.contains("checkin") {
            sheet = .activity
        } else {
            selectPrimary(.today)
        }
    }

    func open(route: String) {
        if let url = URL(string: route), url.scheme != nil {
            open(url)
        } else if let url = URL(string: "lab86://open\(route.hasPrefix("/") ? route : "/\(route)")") {
            open(url)
        }
    }

    private static let filesRouteAliases: Set<Substring> = ["files", "drive", "documents"]

    private static func isFilesRoute(_ raw: String) -> Bool {
        raw.lowercased()
            .split(whereSeparator: { !$0.isLetter && !$0.isNumber })
            .contains(where: filesRouteAliases.contains)
    }
}
