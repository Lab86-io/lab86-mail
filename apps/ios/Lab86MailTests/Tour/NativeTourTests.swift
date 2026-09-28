#if os(iOS)
import ClerkKit
import SwiftUI
import UIKit
import XCTest
@testable import Lab86Mail

/// The screenshot tour for iPhone and iPad: every main screen, drawn by the
/// real views from fixture data through a stub backend (no network), at
/// iPhone size (compact width, light, dark, and one large text size) and at
/// iPad size (regular width, portrait and landscape, light and dark).
///
/// Each image is a PNG with a JSON sidecar in `TOUR_DIR` (CI sets
/// `TEST_RUNNER_TOUR_DIR`). `.github/scripts/native-tour-gallery.mjs` turns
/// the files into one gallery. Without `TOUR_DIR` the tour skips, so a local
/// test run stays fast.
///
/// The iPad windows are larger than the iPhone simulator screen. A probe
/// finds out whether `drawHierarchy` draws past the screen edge; if it does
/// not, those frames use `layer.render`, which leaves out blur and glass.
/// The sidecar names the method for each image.
@MainActor
final class NativeTourTests: XCTestCase {
    func testTour01Shell() async throws {
        try await tour(Screen(id: "shell-sidebar", title: "Shell and sidebar", section: "Shell") { environment in
            // The compact shell opens its source list on request. The
            // regular-width shell always shows it.
            environment.navigation.requestsSourceList = true
        })
    }

    func testTour02TodayBrief() async throws {
        try await tour(Screen(id: "today-brief", title: "Today with a full brief", section: "Today", tab: .today))
    }

    func testTour03TodayEmpty() async throws {
        try await tour(Screen(id: "today-empty", title: "Today with no brief yet", section: "Today", tab: .today))
    }

    func testTour04TodayError() async throws {
        try await tour(Screen(id: "today-error", title: "Today when the brief does not load", section: "Today", tab: .today))
    }

    func testTour05MailList() async throws {
        try await tour(Screen(id: "mail-list", title: "Mail list", section: "Mail", tab: .mail))
    }

    func testTour06MailThread() async throws {
        var screen = Screen(id: "mail-thread", title: "Mail thread", section: "Mail", tab: .mail)
        screen.setUp = { environment in
            environment.navigation.threadRoute = ThreadRoute(accountID: "acct-work", threadID: "t-venue")
        }
        try await tour(screen)
    }

    func testTour07MailEmpty() async throws {
        try await tour(Screen(id: "mail-empty", title: "Mail with no messages", section: "Mail", tab: .mail))
    }

    func testTour08MailError() async throws {
        try await tour(Screen(id: "mail-error", title: "Mail when the server does not answer", section: "Mail", tab: .mail))
    }

    func testTour09ComposeNew() async throws {
        var screen = Screen(id: "compose-new", title: "Compose a new message", section: "Compose", tab: .mail)
        screen.setUp = { environment in
            environment.navigation.pendingCompose = NativeTourTests.prefill(
                recipient: "Sarah Chen <sarah.chen@northwind.example>, priya@ledgerworks.example, marcus",
                cc: "",
                subject: "Offsite head count",
                body: "Hi Sarah and Priya,\n\nThe final count is 24 people. Engineering confirmed this morning.\n\nCasey",
                mode: "new"
            )
            environment.navigation.sheet = .compose
        }
        try await tour(screen)
    }

    func testTour10ComposeReply() async throws {
        var screen = Screen(id: "compose-reply", title: "Reply to a thread", section: "Compose", tab: .mail)
        screen.setUp = { environment in
            environment.navigation.threadRoute = ThreadRoute(accountID: "acct-work", threadID: "t-venue")
            environment.navigation.pendingCompose = NativeTourTests.prefill(
                recipient: "Sarah Chen <sarah.chen@northwind.example>",
                cc: "Marcus Webb <marcus@northwind.example>",
                subject: "Re: Offsite venue: final head count",
                body: "Hi Sarah,\n\nThe count is 24. We do not need the projector in the second room.\n\nCasey",
                mode: "reply",
                threadID: "t-venue",
                messageID: "m-venue-3"
            )
            environment.navigation.sheet = .compose
        }
        try await tour(screen)
    }

    func testTour11CalendarDay() async throws {
        var screen = Screen(id: "calendar-day", title: "Calendar, day", section: "Calendar", tab: .calendar)
        screen.calendarMode = "day"
        try await tour(screen)
    }

    func testTour12CalendarWeek() async throws {
        var screen = Screen(id: "calendar-week", title: "Calendar, week", section: "Calendar", tab: .calendar)
        screen.calendarMode = "week"
        try await tour(screen)
    }

    func testTour13CalendarMonth() async throws {
        var screen = Screen(id: "calendar-month", title: "Calendar, month", section: "Calendar", tab: .calendar)
        screen.calendarMode = "month"
        try await tour(screen)
    }

    func testTour14Tasks() async throws {
        try await tour(Screen(id: "tasks", title: "Tasks board", section: "Tasks and Work", tab: .tasks))
    }

    func testTour15Work() async throws {
        try await tour(Screen(id: "work", title: "Albatrosses (Work list)", section: "Tasks and Work", tab: .work))
    }

    func testTour16WorkDetail() async throws {
        var screen = Screen(id: "work-detail", title: "One Albatross (Work detail)", section: "Tasks and Work", tab: .work)
        screen.setUp = { environment in
            environment.navigation.openWork(id: "w-passport", title: "Renew my passport before the Denver trip")
        }
        try await tour(screen)
    }

    func testTour17Files() async throws {
        try await tour(Screen(id: "files", title: "Files", section: "Files", tab: .files))
    }

    func testTour18Chat() async throws {
        var screen = Screen(id: "chat", title: "Chat with tool cards", section: "Chat", tab: .chat)
        screen.setUp = { environment in
            environment.startAssistantChat()
            await environment.assistantChat?.restore(sessionID: "tour-chat")
        }
        try await tour(screen)
    }

    func testTour19Settings() async throws {
        var screen = Screen(id: "settings", title: "Settings", section: "Settings", tab: .today)
        screen.setUp = { environment in
            environment.navigation.sheet = .settings
        }
        try await tour(screen)
    }

    // MARK: - Screens and variants

    private struct Screen {
        let id: String
        let title: String
        let section: String
        var tab: PrimaryTab = .today
        var calendarMode: String?
        var setUp: (@MainActor (AppEnvironment) async -> Void)?
        var afterAppear: (@MainActor (AppEnvironment) async -> Void)?

        init(
            id: String,
            title: String,
            section: String,
            tab: PrimaryTab = .today,
            afterAppear: (@MainActor (AppEnvironment) async -> Void)? = nil
        ) {
            self.id = id
            self.title = title
            self.section = section
            self.tab = tab
            self.afterAppear = afterAppear
        }
    }

    private struct Variant {
        let id: String
        let device: String
        let size: CGSize
        let horizontal: UIUserInterfaceSizeClass
        let vertical: UIUserInterfaceSizeClass
        let orientation: String
        let style: UIUserInterfaceStyle
        let category: UIContentSizeCategory
        let safeArea: UIEdgeInsets
        let scale: CGFloat

        var appearance: String { style == .dark ? "dark" : "light" }
        var textSize: String { category == .large ? "default" : "AX3 (accessibility extra large)" }
        var sizeClass: String { horizontal == .regular ? "regular width" : "compact width" }
    }

    private static func variants(scene: UIWindowScene) -> [Variant] {
        let phone = scene.screen.bounds.size
        let hostInsets = scene.windows.first { $0.windowLevel == .normal }?.safeAreaInsets ?? .zero
        let phoneInsets = hostInsets.top > 0 ? hostInsets : UIEdgeInsets(top: 62, left: 0, bottom: 34, right: 0)
        // iPad Air 11-inch, in points. The status bar and the home indicator
        // give the insets.
        let padPortrait = CGSize(width: 820, height: 1_180)
        let padLandscape = CGSize(width: 1_180, height: 820)
        let padInsets = UIEdgeInsets(top: 24, left: 0, bottom: 20, right: 0)
        func phoneVariant(_ id: String, _ style: UIUserInterfaceStyle, _ category: UIContentSizeCategory) -> Variant {
            Variant(
                id: id, device: "iPhone", size: phone, horizontal: .compact, vertical: .regular,
                orientation: "portrait", style: style, category: category, safeArea: phoneInsets, scale: 2
            )
        }
        func padVariant(_ id: String, _ size: CGSize, _ orientation: String, _ style: UIUserInterfaceStyle) -> Variant {
            Variant(
                id: id, device: "iPad", size: size, horizontal: .regular, vertical: .regular,
                orientation: orientation, style: style, category: .large, safeArea: padInsets, scale: 1.5
            )
        }
        return [
            phoneVariant("iphone-light", .light, .large),
            phoneVariant("iphone-dark", .dark, .large),
            phoneVariant("iphone-ax3", .light, .accessibilityExtraLarge),
            padVariant("ipad-portrait-light", padPortrait, "portrait", .light),
            padVariant("ipad-portrait-dark", padPortrait, "portrait", .dark),
            padVariant("ipad-landscape-light", padLandscape, "landscape", .light),
            padVariant("ipad-landscape-dark", padLandscape, "landscape", .dark),
        ]
    }

    private static func prefill(
        recipient: String,
        cc: String,
        subject: String,
        body: String,
        mode: String,
        threadID: String? = nil,
        messageID: String? = nil
    ) -> ComposePrefill {
        ComposePrefill(
            recipient: recipient,
            cc: cc,
            bcc: "",
            subject: subject,
            body: body,
            mode: mode,
            accountID: "acct-work",
            threadID: threadID,
            messageID: messageID,
            replyAll: false,
            attachmentsKey: nil,
            draftID: nil
        )
    }

    private static let screenOrder = [
        "shell-sidebar", "today-brief", "today-empty", "today-error", "mail-list", "mail-thread", "mail-empty",
        "mail-error", "compose-new", "compose-reply", "calendar-day", "calendar-week", "calendar-month", "tasks",
        "work", "work-detail", "files", "chat", "settings",
    ]

    // MARK: - The tour

    private func tour(_ screen: Screen) async throws {
        guard let directory = TourOutput.directory else {
            throw XCTSkip("Set TOUR_DIR (TEST_RUNNER_TOUR_DIR in CI) to render the screenshot tour.")
        }
        let fixtures = try TourFixtures.load()
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        UIView.setAnimationsEnabled(false)
        defer { UIView.setAnimationsEnabled(true) }
        for (index, variant) in Self.variants(scene: scene).enumerated() {
            do {
                try await render(screen, variant: variant, variantOrder: index, fixtures: fixtures, scene: scene, directory: directory)
            } catch {
                XCTFail("\(screen.id) \(variant.id): \(error)")
            }
        }
    }

    private func render(
        _ screen: Screen,
        variant: Variant,
        variantOrder: Int,
        fixtures: JSONValue,
        scene: UIWindowScene,
        directory: URL
    ) async throws {
        let backend = TourBackend(routes: TourRoutes(fixtures: fixtures, scenarioID: screen.id))
        defer { backend.tearDown() }
        let suite = "NativeTourTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        // The calendar keeps its mode in standard defaults (@AppStorage).
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

        let configuration = AppConfiguration(bundle: Bundle(for: NativeTourTests.self), defaults: defaults)
        let environment = AppEnvironment(configuration: configuration, inMemoryPersistence: true, backend: backend.client)
        environment.navigation.selectPrimary(screen.tab)
        await environment.store.bootstrap()
        if let setUp = screen.setUp { await setUp(environment) }

        let controller = UIHostingController(rootView: AnyView(
            AppShellView()
                .tint(environment.theme.accentColor)
                .environment(environment)
                .environment(Clerk.shared)
        ))
        let window = TourWindow(windowScene: scene)
        window.frame = CGRect(origin: .zero, size: variant.size)
        window.tourSafeArea = variant.safeArea
        window.windowLevel = .normal + 1
        window.backgroundColor = .systemBackground
        window.overrideUserInterfaceStyle = variant.style
        window.traitOverrides.horizontalSizeClass = variant.horizontal
        window.traitOverrides.verticalSizeClass = variant.vertical
        window.traitOverrides.preferredContentSizeCategory = variant.category
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer {
            controller.presentedViewController?.dismiss(animated: false)
            window.isHidden = true
            window.rootViewController = nil
        }
        if let afterAppear = screen.afterAppear { await afterAppear(environment) }
        await settle(window, backend: backend)

        let screenBounds = scene.screen.bounds.size
        let fitsScreen = variant.size.width <= screenBounds.width + 0.5 && variant.size.height <= screenBounds.height + 0.5
        let useHierarchy = fitsScreen || TourCapture.drawHierarchyCoversOffscreen(scene: scene)
        let format = UIGraphicsImageRendererFormat()
        format.scale = variant.scale
        let renderer = UIGraphicsImageRenderer(bounds: window.bounds, format: format)
        let image: UIImage
        let method: String
        if useHierarchy {
            image = renderer.image { _ in
                _ = window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            method = "drawHierarchy"
        } else {
            image = renderer.image { context in
                window.layer.render(in: context.cgContext)
            }
            method = "layer.render"
        }

        let file = "ios-\(screen.id)-\(variant.id).png"
        let pixels = image.cgImage?.dataProvider?.data as Data?
        let distinct = pixels.map { TourPixels.distinctBytes($0) } ?? 0
        guard let png = image.pngData() else { throw TourError.unreadableImage(file) }
        var notes: [String] = []
        if method == "layer.render" {
            notes.append("Drawn with layer.render because the window is larger than the simulator screen. Blur, glass, and system materials do not show.")
        }
        if variant.device == "iPad" {
            notes.append("An iPad-sized window on the iPhone simulator, with iPad size classes and safe area.")
        }
        let log = backend.log
        let record = TourRecord(
            file: file,
            platform: "iOS",
            screen: screen.id,
            screenTitle: screen.title,
            section: screen.section,
            screenOrder: Self.screenOrder.firstIndex(of: screen.id) ?? Self.screenOrder.count,
            variant: variant.id,
            variantOrder: variantOrder,
            device: variant.device,
            sizeClass: variant.sizeClass,
            orientation: variant.orientation,
            appearance: variant.appearance,
            textSize: variant.textSize,
            width: Double(variant.size.width),
            height: Double(variant.size.height),
            scale: Double(variant.scale),
            captureMethod: method,
            distinctBytes: distinct,
            blankWarning: distinct <= TourPixels.blankThreshold,
            notes: notes,
            requests: log,
            uncovered: log.filter { !$0.covered }.map { "\($0.method) \($0.path)" }
        )
        try TourOutput.write(png: png, record: record, to: directory)
    }

    /// Waits until the screen stops asking the backend for data, then gives
    /// layout and images a moment to finish.
    private func settle(_ window: UIWindow, backend: TourBackend) async {
        let clock = ContinuousClock()
        let start = clock.now
        var lastCount = -1
        var quietSince = start
        while clock.now - start < .seconds(6) {
            window.layoutIfNeeded()
            try? await Task.sleep(for: .milliseconds(100))
            let count = backend.requestCount
            if count != lastCount {
                lastCount = count
                quietSince = clock.now
            }
            if clock.now - start >= .milliseconds(900), clock.now - quietSince >= .milliseconds(400) { break }
        }
        // A focused field would reserve room for a keyboard that this window
        // does not draw.
        window.endEditing(true)
        window.layoutIfNeeded()
        try? await Task.sleep(for: .milliseconds(250))
        window.layoutIfNeeded()
    }
}

/// A window with a fixed safe area, so an iPad-sized window on the iPhone
/// simulator gets iPad insets.
private final class TourWindow: UIWindow {
    var tourSafeArea: UIEdgeInsets = .zero

    override var safeAreaInsets: UIEdgeInsets { tourSafeArea }
}

@MainActor
private enum TourCapture {
    private static var offscreenCovered: Bool?

    /// Draws a window that reaches past the screen, with a green square in
    /// the far corner, and checks that `drawHierarchy` drew the square.
    static func drawHierarchyCoversOffscreen(scene: UIWindowScene) -> Bool {
        if let offscreenCovered { return offscreenCovered }
        let screen = scene.screen.bounds.size
        let size = CGSize(width: screen.width + 300, height: screen.height + 300)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(origin: .zero, size: size)
        window.windowLevel = .normal + 2
        let controller = UIViewController()
        controller.view.backgroundColor = .red
        let marker = UIView(frame: CGRect(x: size.width - 150, y: size.height - 150, width: 150, height: 150))
        marker.backgroundColor = .green
        controller.view.addSubview(marker)
        window.rootViewController = controller
        window.isHidden = false
        window.layoutIfNeeded()
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { _ in
            _ = window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        window.isHidden = true
        window.rootViewController = nil
        let covered = pixel(image, x: Int(size.width) - 75, y: Int(size.height) - 75)
            .map { $0.green > 180 && $0.red < 90 } ?? false
        offscreenCovered = covered
        return covered
    }

    private static func pixel(_ image: UIImage, x: Int, y: Int) -> (red: UInt8, green: UInt8, blue: UInt8)? {
        guard let cgImage = image.cgImage else { return nil }
        let px = Int(CGFloat(x) * image.scale)
        let py = Int(CGFloat(y) * image.scale)
        guard px >= 0, py >= 0, px < cgImage.width, py < cgImage.height else { return nil }
        var bytes = [UInt8](repeating: 0, count: 4)
        let drawn = bytes.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(
                data: buffer.baseAddress,
                width: 1,
                height: 1,
                bitsPerComponent: 8,
                bytesPerRow: 4,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) else { return false }
            // Moves pixel (px, py), counted from the top, onto the one
            // pixel of the context (whose origin is at the bottom).
            context.draw(
                cgImage,
                in: CGRect(x: -px, y: py + 1 - cgImage.height, width: cgImage.width, height: cgImage.height)
            )
            return true
        }
        guard drawn else { return nil }
        return (bytes[0], bytes[1], bytes[2])
    }
}
#endif
