import AppIntents
import Foundation

struct OpenTodayIntent: AppIntent {
    static let title: LocalizedStringResource = "Open Today in Albatross"
    static let description = IntentDescription("Open your combined mail, calendar, task, and Work brief.")
    static let openAppWhenRun = true

    func perform() async throws -> some IntentResult {
        UserDefaults.standard.set("today", forKey: "pendingAlbatrossRoute")
        return .result()
    }
}

struct CaptureWorkIntent: AppIntent {
    static let title: LocalizedStringResource = "Capture Work in Albatross"
    static let description = IntentDescription("Get something out of your head and into Albatross without losing your original words.")
    static let openAppWhenRun = true

    @Parameter(title: "What’s on your mind")
    var text: String

    init() {}
    init(text: String) { self.text = text }

    static var parameterSummary: some ParameterSummary {
        Summary("Capture \(\.$text)")
    }

    func perform() async throws -> some IntentResult {
        UserDefaults.standard.set(text, forKey: "pendingAlbatrossCapture")
        return .result()
    }
}

struct SearchMailIntent: AppIntent {
    static let title: LocalizedStringResource = "Search Mail in Albatross"
    static let description = IntentDescription("Open Albatross and search across the inboxes on your phone.")
    static let openAppWhenRun = true

    @Parameter(title: "Search")
    var query: String

    init() {}
    init(query: String) { self.query = query }

    static var parameterSummary: some ParameterSummary {
        Summary("Search mail for \(\.$query)")
    }

    func perform() async throws -> some IntentResult {
        UserDefaults.standard.set(query, forKey: "pendingAlbatrossMailSearch")
        return .result()
    }
}

struct ComposeEmailIntent: AppIntent {
    static let title: LocalizedStringResource = "Compose Email in Albatross"
    static let description = IntentDescription("Open a prefilled Albatross composer. Nothing sends until you review and tap Send.")
    static let openAppWhenRun = true

    @Parameter(title: "Recipient") var recipient: String
    @Parameter(title: "Subject") var subject: String
    @Parameter(title: "Message") var body: String

    init() {}

    static var parameterSummary: some ParameterSummary {
        Summary("Compose email to \(\.$recipient) about \(\.$subject)")
    }

    func perform() async throws -> some IntentResult {
        UserDefaults.standard.set(recipient, forKey: "pendingAlbatrossComposeRecipient")
        UserDefaults.standard.set(subject, forKey: "pendingAlbatrossComposeSubject")
        UserDefaults.standard.set(body, forKey: "pendingAlbatrossComposeBody")
        return .result()
    }
}

struct OpenCheckInIntent: AppIntent {
    static let title: LocalizedStringResource = "Answer Albatross Check-In"
    static let description = IntentDescription("Open the current Albatross check-in and activity queue.")
    static let openAppWhenRun = true

    func perform() async throws -> some IntentResult {
        UserDefaults.standard.set("/checkin", forKey: "pendingAlbatrossDeepLink")
        return .result()
    }
}

struct AlbatrossShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: OpenTodayIntent(),
            phrases: ["Open my day in \(.applicationName)", "What is on my plate in \(.applicationName)"],
            shortTitle: "Open Today",
            systemImageName: "sun.max"
        )
        AppShortcut(
            intent: CaptureWorkIntent(),
            phrases: ["Capture something in \(.applicationName)", "Tell \(.applicationName) what is on my mind"],
            shortTitle: "Capture Work",
            systemImageName: "plus.bubble"
        )
        AppShortcut(
            intent: SearchMailIntent(),
            phrases: ["Search mail in \(.applicationName)", "Find an email in \(.applicationName)"],
            shortTitle: "Search Mail",
            systemImageName: "envelope.badge.magnifyingglass"
        )
        AppShortcut(
            intent: ComposeEmailIntent(),
            phrases: ["Compose email in \(.applicationName)", "Write an email with \(.applicationName)"],
            shortTitle: "Compose Email",
            systemImageName: "square.and.pencil"
        )
        AppShortcut(
            intent: OpenCheckInIntent(),
            phrases: ["Check in with \(.applicationName)", "Tell \(.applicationName) what I got done"],
            shortTitle: "Daily Check-In",
            systemImageName: "checkmark.bubble"
        )
    }
}
