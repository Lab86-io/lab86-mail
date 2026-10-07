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

    // MARK: - Screens

    private struct Screen {
        let id: String
        let title: String
        let section: String
        var tab: PrimaryTab = .today
        var calendarMode: String?
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
        "mac-work-detail", "mac-work-detail-run", "mac-work-detail-handoff", "mac-files", "mac-chat", "mac-settings",
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
        let backend = TourBackend(routes: TourRoutes(fixtures: fixtures, scenarioID: screen.id))
        defer { backend.tearDown() }
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

        let controller = NSHostingController(rootView: AnyView(
            MacShellView()
                .tint(environment.theme.accentColor)
                .environment(environment)
                .environment(Clerk.shared)
        ))
        // The window's toolbar and title come from the SwiftUI content, as
        // in the app's window group.
        controller.sceneBridgingOptions = [.toolbars, .title]
        let frame = NSRect(origin: NSPoint(x: 40, y: 40), size: Self.windowSize)
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
        window.setContentSize(Self.windowSize)
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
            width: Double(Self.windowSize.width),
            height: Double(Self.windowSize.height),
            scale: Double(image.pixelsWide) / Double(max(1, Self.windowSize.width)),
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
