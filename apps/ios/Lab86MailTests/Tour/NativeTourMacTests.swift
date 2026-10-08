#if os(macOS)
import AppKit
import ClerkKit
import SwiftUI
import XCTest
@testable import Lab86Mail

/// The screenshot tour for the Mac: the main window at a desktop size, in
/// light and dark, drawn by the real `MacShellView` from fixture data through
/// a stub backend (no network). Settings and compose open as real sheets;
/// the image puts the sheet over the dimmed window.
///
/// Each image is a PNG with a JSON sidecar in `TOUR_DIR`. Without `TOUR_DIR`
/// the tour skips. Run it with
/// `-only-testing:Lab86MailMacTests/NativeTourMacTests`.
///
/// `cacheDisplay` draws the views, not the window server: vibrancy and some
/// materials (the sidebar, the title bar) can show flat.
@MainActor
final class NativeTourMacTests: XCTestCase {
    func testMacTour01Today() async throws {
        try await tour(Screen(id: "mac-today", title: "Today with a full brief", section: "Today", tab: .today))
    }

    func testMacTour02Mail() async throws {
        var screen = Screen(id: "mac-mail", title: "Mail with the reading pane", section: "Mail", tab: .mail)
        screen.setUp = { environment in
            environment.navigation.threadRoute = ThreadRoute(accountID: "acct-work", threadID: "t-venue")
        }
        try await tour(screen)
    }

    func testMacTour03Compose() async throws {
        var screen = Screen(id: "mac-compose", title: "Reply sheet", section: "Compose", tab: .mail)
        screen.setUp = { environment in
            environment.navigation.threadRoute = ThreadRoute(accountID: "acct-work", threadID: "t-venue")
            environment.navigation.pendingCompose = ComposePrefill(
                recipient: "Sarah Chen <sarah.chen@northwind.example>",
                cc: "Marcus Webb <marcus@northwind.example>",
                bcc: "",
                subject: "Re: Offsite venue: final head count",
                body: "Hi Sarah,\n\nThe count is 24. We do not need the projector in the second room.\n\nCasey",
                mode: "reply",
                accountID: "acct-work",
                threadID: "t-venue",
                messageID: "m-venue-3",
                replyAll: false,
                attachmentsKey: nil,
                draftID: nil
            )
            environment.navigation.sheet = .compose
        }
        try await tour(screen)
    }

    func testMacTour04CalendarWeek() async throws {
        var screen = Screen(id: "mac-calendar-week", title: "Calendar, week", section: "Calendar", tab: .calendar)
        screen.calendarMode = "week"
        try await tour(screen)
    }

    func testMacTour05CalendarMonth() async throws {
        var screen = Screen(id: "mac-calendar-month", title: "Calendar, month", section: "Calendar", tab: .calendar)
        screen.calendarMode = "month"
        try await tour(screen)
    }

    func testMacTour06Tasks() async throws {
        try await tour(Screen(id: "mac-tasks", title: "Tasks board", section: "Tasks and Work", tab: .tasks))
    }

    func testMacTour07Work() async throws {
        try await tour(Screen(id: "mac-work", title: "Albatrosses (Work list)", section: "Tasks and Work", tab: .work))
    }

    func testMacTour08WorkDetail() async throws {
        var screen = Screen(id: "mac-work-detail", title: "One Albatross (Work detail)", section: "Tasks and Work", tab: .work)
        // The Work list pushes the detail when the route changes, so the route
        // is set after the list is on screen.
        screen.afterAppear = { environment in
            environment.navigation.openWork(id: "w-passport", title: "Renew my passport before the Denver trip")
        }
        try await tour(screen)
    }

    func testMacTour09Files() async throws {
        try await tour(Screen(id: "mac-files", title: "Files", section: "Files", tab: .files))
    }

    func testMacTour12WorkDetailRun() async throws {
        // The step runner at work: the live log and "Stop" at the left, the
        // live pane at the right. Without Convex the pane shows its empty state.
        var screen = Screen(id: "mac-work-detail-run", title: "One Albatross while a step runs", section: "Tasks and Work", tab: .work)
        screen.afterAppear = { environment in
            environment.navigation.openWork(id: "w-dispute-run", title: "Dispute the duplicate charge")
        }
        try await tour(screen)
    }

    func testMacTour13WorkDetailHandoff() async throws {
        // A handoff: the summary, the artifacts, and "Read and send".
        var screen = Screen(id: "mac-work-detail-handoff", title: "One Albatross with a handoff", section: "Tasks and Work", tab: .work)
        screen.afterAppear = { environment in
            environment.navigation.openWork(id: "w-dispute-handoff", title: "Dispute the duplicate charge")
        }
        try await tour(screen)
    }

    func testMacTour10Chat() async throws {
        var screen = Screen(id: "mac-chat", title: "Chat panel with tool cards", section: "Chat", tab: .today)
        screen.setUp = { environment in
            environment.toggleAssistantChatPanel()
            await environment.assistantChat?.restore(sessionID: "tour-chat")
        }
        try await tour(screen)
    }

    func testMacTour11Settings() async throws {
        var screen = Screen(id: "mac-settings", title: "Settings sheet", section: "Settings", tab: .today)
        screen.setUp = { environment in
            environment.navigation.sheet = .settings
        }
        try await tour(screen)
    }

    func testMacTour14WorkThreadRun() async throws {
        // The Albatross thread (S6 to S8) in a wide window: the outcome block,
        // the run block inside the reply that started it, and the page pane
        // at the right. Without Convex the pane shows its closed state.
        var screen = Screen(id: "mac-work-thread-run", title: "The Albatross thread while a run works", section: "Tasks and Work", tab: .work)
        screen.scenarioID = "work-thread-run"
        screen.afterAppear = { environment in
            environment.navigation.openWork(id: "w-course-run", title: "Register for the Alive at 25 course", intent: .openPage)
        }
        try await tour(screen)
    }

    func testMacTour15WorkThreadForm() async throws {
        // The form (S9 and S10) in a wide window: the class choice with its
        // calendar notes, the prefilled details, and the empty phone.
        var screen = Screen(id: "mac-work-thread-form", title: "The Albatross thread with a form", section: "Tasks and Work", tab: .work)
        screen.scenarioID = "work-thread-form"
        screen.afterAppear = { environment in
            environment.navigation.openWork(id: "w-course-form", title: "Register for the Alive at 25 course")
        }
        try await tour(screen)
    }

    func testMacTour16WorkThreadHandoff() async throws {
        // The final page (S13): the answered form, the continued run, "Check
        // and pay" and "I paid", and the page pane.
        var screen = Screen(id: "mac-work-thread-handoff", title: "The Albatross thread at the final page", section: "Tasks and Work", tab: .work)
        screen.scenarioID = "work-thread-handoff"
        screen.afterAppear = { environment in
            environment.navigation.openWork(id: "w-course-handoff", title: "Register for the Alive at 25 course", intent: .openPage)
        }
        try await tour(screen)
    }

    func testMacTour17WorkThreadNarrow() async throws {
        // A narrow window: no pane. The page row offers "Open" (the sheet),
        // and the Details toggle opens a popover.
        var screen = Screen(id: "mac-work-thread-narrow", title: "The Albatross thread in a narrow window", section: "Tasks and Work", tab: .work)
        screen.scenarioID = "work-thread-handoff"
        screen.windowSize = NSSize(width: 760, height: 700)
        screen.afterAppear = { environment in
            environment.navigation.openWork(id: "w-course-handoff", title: "Register for the Alive at 25 course")
        }
        try await tour(screen)
    }

    func testMacTour18SettingsPersonalDetails() async throws {
        // Settings, Account, Personal details (S21) as a grouped Mac form:
        // each detail with where it came from, one trailing button per row.
        var screen = Screen(id: "mac-settings-personal-details", title: "Settings, Personal details", section: "Settings", tab: .today)
        screen.windowSize = NSSize(width: 640, height: 640)
        screen.rootView = {
            AnyView(
                NavigationStack { PersonalDetailsSettingsView() }
                    .formStyle(.grouped)
            )
        }
        try await tour(screen)
    }

    func testMacTour19SettingsPasswordsAndIDs() async throws {
        // Settings, Account, Passwords and IDs (V1 to V3) as a grouped Mac
        // form: three groups, the masked hints, "Used Oct 5", the add rows,
        // and the date of birth slot. No value anywhere.
        var screen = Screen(id: "mac-settings-passwords-ids", title: "Settings, Passwords and IDs", section: "Settings", tab: .today)
        screen.windowSize = NSSize(width: 640, height: 760)
        screen.rootView = {
            AnyView(
                NavigationStack { SecureDetailsSettingsView() }
                    .formStyle(.grouped)
            )
        }
        try await tour(screen)
    }

    func testMacTour20SettingsPasswordsAndIDsDetail() async throws {
        // One ID (V4 and V8): the facts, each secret field with "Replace",
        // the sites with "Remove" at the trailing edge, the recent uses, and
        // the "Delete…" row with its bordered button.
        var screen = Screen(id: "mac-settings-passwords-ids-detail", title: "Settings, a driver's license", section: "Settings", tab: .today)
        screen.windowSize = NSSize(width: 640, height: 900)
        screen.rootView = {
            AnyView(
                NavigationStack { SecureItemDetailView(itemID: "sec-license") }
                    .formStyle(.grouped)
            )
        }
        try await tour(screen)
    }

    func testMacTour21WorkThreadAllow() async throws {
        // The allow card (V6) in a wide window: a run on a new site asks to
        // use the driver's license, with "Allow once" (Command-Return),
        // "Always on ny.gov", and "Do not allow". Without Convex the page
        // pane shows its closed state.
        var screen = Screen(id: "mac-work-thread-allow", title: "The Albatross thread with an allow", section: "Tasks and Work", tab: .work)
        screen.scenarioID = "work-thread-allow"
        screen.afterAppear = { environment in
            environment.navigation.openWork(id: "w-license", title: "Renew the driver's license", intent: .openPage)
        }
        try await tour(screen)
    }

    // MARK: - Screens

    private struct Screen {
        let id: String
        let title: String
        let section: String
        var tab: PrimaryTab = .today
        var calendarMode: String?
        /// The fixture scenario, when it is not the screen id. The thread
        /// screens share the iOS scenarios.
        var scenarioID: String?
        /// The window, when it is not the desktop size (the narrow thread,
        /// a settings page).
        var windowSize: NSSize?
        /// A screen that is not the shell (a Settings subpage): the view to
        /// host instead of `MacShellView`.
        var rootView: (@MainActor () -> AnyView)?
        var setUp: (@MainActor (AppEnvironment) async -> Void)?
        var afterAppear: (@MainActor (AppEnvironment) async -> Void)?

        init(id: String, title: String, section: String, tab: PrimaryTab) {
            self.id = id
            self.title = title
            self.section = section
            self.tab = tab
        }
    }

    private static let windowSize = NSSize(width: 1_440, height: 900)

    private static let screenOrder = [
        "mac-today", "mac-mail", "mac-compose", "mac-calendar-week", "mac-calendar-month", "mac-tasks", "mac-work",
        "mac-work-detail", "mac-work-detail-run", "mac-work-detail-handoff", "mac-work-thread-run",
        "mac-work-thread-form", "mac-work-thread-handoff", "mac-work-thread-narrow", "mac-work-thread-allow", "mac-files",
        "mac-chat", "mac-settings", "mac-settings-personal-details", "mac-settings-passwords-ids",
        "mac-settings-passwords-ids-detail",
    ]

    // MARK: - The tour

    private func tour(_ screen: Screen) async throws {
        guard let directory = TourOutput.directory else {
            throw XCTSkip("Set TOUR_DIR (TEST_RUNNER_TOUR_DIR in CI) to render the screenshot tour.")
        }
        let fixtures = try TourFixtures.load()
        for (index, dark) in [false, true].enumerated() {
            do {
                try await render(screen, dark: dark, variantOrder: index, fixtures: fixtures, directory: directory)
            } catch {
                XCTFail("\(screen.id) \(dark ? "dark" : "light"): \(error)")
            }
        }
    }

    private func render(
        _ screen: Screen,
        dark: Bool,
        variantOrder: Int,
        fixtures: JSONValue,
        directory: URL
    ) async throws {
        let backend = TourBackend(routes: TourRoutes(fixtures: fixtures, scenarioID: screen.scenarioID ?? screen.id))
        defer { backend.tearDown() }
        let size = screen.windowSize ?? Self.windowSize
        let suite = "NativeTourMacTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let modeKey = "calendarViewMode"
        let previousMode = UserDefaults.standard.string(forKey: modeKey)
        if let mode = screen.calendarMode { UserDefaults.standard.set(mode, forKey: modeKey) }
        defer {
            if let previousMode {
                UserDefaults.standard.set(previousMode, forKey: modeKey)
            } else {
                UserDefaults.standard.removeObject(forKey: modeKey)
            }
        }

        let configuration = AppConfiguration(bundle: Bundle(for: NativeTourMacTests.self), defaults: defaults)
        let environment = AppEnvironment(
            configuration: configuration,
            inMemoryPersistence: true,
            backend: backend.client,
            sendAs: TourSendAs(fixtures: fixtures)
        )
        let ownerID = await TourSession.signIn(environment)
        environment.navigation.selectPrimary(screen.tab)
        await environment.store.bootstrap(cacheOwner: ownerID)
        if let setUp = screen.setUp { await setUp(environment) }

        let root = screen.rootView?() ?? AnyView(MacShellView())
        let controller = NSHostingController(rootView: AnyView(
            root
                .tint(environment.theme.accentColor)
                .environment(environment)
                .environment(Clerk.shared)
        ))
        // The window's toolbar and title come from the SwiftUI content, as
        // in the app's window group.
        controller.sceneBridgingOptions = [.toolbars, .title]
        let frame = NSRect(origin: NSPoint(x: 40, y: 40), size: size)
        let window = TourMacWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        window.title = "Albatross"
        window.toolbarStyle = .unified
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        window.contentViewController = controller
        window.setContentSize(size)
        window.orderFrontRegardless()
        defer {
            if let sheet = window.attachedSheet { window.endSheet(sheet) }
            window.orderOut(nil)
            window.contentViewController = nil
        }
        if let afterAppear = screen.afterAppear {
            // A change made before the first frame is the initial value, and
            // navigation destinations do not react to it.
            try? await Task.sleep(for: .milliseconds(500))
            await afterAppear(environment)
        }
        await settle(window, backend: backend)

        let file = "macos-\(screen.id)-\(dark ? "dark" : "light").png"
        let main = try snapshot(of: window)
        var notes = ["Drawn with cacheDisplay from the window frame view. Vibrancy and some materials can show flat."]
        let image: NSBitmapImageRep
        if let sheet = window.attachedSheet, let sheetImage = try? snapshot(of: sheet) {
            image = try composite(main, window: window, sheet: sheetImage, sheetWindow: sheet)
            notes.append("The sheet is drawn over the dimmed main window.")
        } else {
            image = main
        }
        guard let png = image.representation(using: .png, properties: [:]) else { throw TourError.unreadableImage(file) }
        let distinct = image.bitmapData.map { pointer in
            TourPixels.distinctBytes(Data(bytes: pointer, count: image.bytesPerRow * image.pixelsHigh))
        } ?? 0
        let log = backend.log
        let record = TourRecord(
            file: file,
            platform: "macOS",
            screen: screen.id,
            screenTitle: screen.title,
            section: screen.section,
            screenOrder: Self.screenOrder.firstIndex(of: screen.id) ?? Self.screenOrder.count,
            variant: dark ? "mac-dark" : "mac-light",
            variantOrder: variantOrder,
            device: "Mac",
            sizeClass: "desktop window",
            orientation: "window",
            appearance: dark ? "dark" : "light",
            textSize: "default",
            width: Double(size.width),
            height: Double(size.height),
            scale: Double(image.pixelsWide) / Double(max(1, size.width)),
            captureMethod: "cacheDisplay",
            distinctBytes: distinct,
            blankWarning: distinct <= TourPixels.blankThreshold,
            notes: notes,
            requests: log,
            uncovered: log.filter { !$0.covered }.map { "\($0.method) \($0.path)" }
        )
        try TourOutput.write(png: png, record: record, to: directory)
        // Removes the owner's cache and search index entries.
        await environment.store.clearForSignOut()
    }

    /// The window's frame view holds the title bar and the toolbar as well
    /// as the content.
    private func snapshot(of window: NSWindow) throws -> NSBitmapImageRep {
        guard let view = window.contentView?.superview ?? window.contentView else {
            throw TourError.unreadableImage(window.title)
        }
        view.layoutSubtreeIfNeeded()
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else {
            throw TourError.unreadableImage(window.title)
        }
        view.cacheDisplay(in: view.bounds, to: rep)
        return rep
    }

    /// The main window image, dimmed, with the sheet drawn where AppKit put it.
    private func composite(
        _ main: NSBitmapImageRep,
        window: NSWindow,
        sheet: NSBitmapImageRep,
        sheetWindow: NSWindow
    ) throws -> NSBitmapImageRep {
        let size = window.frame.size
        guard let canvas = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: main.pixelsWide,
            pixelsHigh: main.pixelsHigh,
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        ), let context = NSGraphicsContext(bitmapImageRep: canvas) else {
            throw TourError.unreadableImage(window.title)
        }
        canvas.size = size
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        let bounds = NSRect(origin: .zero, size: size)
        main.draw(in: bounds)
        NSColor.black.withAlphaComponent(0.18).setFill()
        bounds.fill(using: .sourceOver)
        // Both frames are in screen coordinates with the origin at the bottom.
        let sheetRect = NSRect(
            x: sheetWindow.frame.minX - window.frame.minX,
            y: sheetWindow.frame.minY - window.frame.minY,
            width: sheetWindow.frame.width,
            height: sheetWindow.frame.height
        )
        sheet.draw(in: sheetRect)
        NSGraphicsContext.restoreGraphicsState()
        return canvas
    }

    private func settle(_ window: NSWindow, backend: TourBackend) async {
        let clock = ContinuousClock()
        let start = clock.now
        var lastCount = -1
        var quietSince = start
        while clock.now - start < .seconds(6) {
            window.contentView?.layoutSubtreeIfNeeded()
            try? await Task.sleep(for: .milliseconds(100))
            let count = backend.requestCount
            if count != lastCount {
                lastCount = count
                quietSince = clock.now
            }
            if clock.now - start >= .milliseconds(1_200), clock.now - quietSince >= .milliseconds(400) { break }
        }
        window.makeFirstResponder(nil)
        window.contentView?.layoutSubtreeIfNeeded()
        try? await Task.sleep(for: .milliseconds(300))
        window.contentView?.layoutSubtreeIfNeeded()
        window.displayIfNeeded()
    }
}

/// A window that keeps its size when it does not fit the runner's display.
/// AppKit would otherwise shrink it to the screen as it orders it front.
private final class TourMacWindow: NSWindow {
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect {
        frameRect
    }
}
#endif
