#if os(iOS)
import SwiftUI
import UIKit
import XCTest
@testable import Lab86Mail

/// Renders the real Mail screen, with its real toolbar, from a synthetic and
/// isolated environment: no account, no server, no network, and an in-memory
/// store. The "All tools" button, which opened a web copy of this same screen,
/// must not be there.
///
/// A window capture rather than `ImageRenderer`: the navigation bar and the
/// bottom toolbar are UIKit bars, which `ImageRenderer` does not draw. When
/// `EVIDENCE_DIR` is set (CI exports `TEST_RUNNER_EVIDENCE_DIR`), each image is
/// also written there as a PNG, with a text file of every label and
/// identifier the window exposes.
@MainActor
final class MailToolbarRenderingTests: XCTestCase {
    func testMailToolbarHasNoAllToolsButton() async throws {
        for (name, scheme) in [("mail-toolbar-light", ColorScheme.light), ("mail-toolbar-dark", ColorScheme.dark)] {
            let suite = "MailToolbarRenderingTests-\(UUID().uuidString)"
            let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
            defer { defaults.removePersistentDomain(forName: suite) }
            let configuration = AppConfiguration(bundle: Bundle(for: MailToolbarRenderingTests.self), defaults: defaults)
            XCTAssertNil(configuration.apiBaseURL, "The rendering must not reach a server")
            let environment = AppEnvironment(configuration: configuration, inMemoryPersistence: true)
            environment.store.threads = Self.threads

            let appeared = expectation(description: "Mail appeared: \(name)")
            let controller = UIHostingController(rootView:
                NavigationStack { MailView() }
                    .tint(environment.theme.accentColor)
                    .environment(environment)
                    .environment(\.colorScheme, scheme)
                    .onAppear { appeared.fulfill() }
            )
            let window = try makeWindow()
            window.overrideUserInterfaceStyle = scheme == .dark ? .dark : .light
            window.rootViewController = controller
            window.makeKeyAndVisible()
            defer { window.isHidden = true; window.rootViewController = nil }
            await fulfillment(of: [appeared], timeout: 5)
            controller.view.setNeedsLayout()
            controller.view.layoutIfNeeded()
            try await Task.sleep(for: .milliseconds(400))
            controller.view.layoutIfNeeded()

            let labels = exposedLabels(in: window)
            for label in labels {
                XCTAssertFalse(label.localizedCaseInsensitiveContains("All tools"), "The toolbar still offers: \(label)")
                XCTAssertNotEqual(label, "workspace.allTools")
            }
            XCTAssertNil(controller.presentedViewController, "Nothing opens on its own")
            XCTAssertNil(environment.navigation.sheet)
            capture(window, name: name)
            writeEvidence(Data(labels.sorted().joined(separator: "\n").utf8), fileName: "\(name)-labels.txt")
        }
    }

    // MARK: - What the window exposes

    // Every label, title, and identifier reachable through the view tree, the
    // accessibility tree, and the bar items, so the check covers a button
    // however UIKit or SwiftUI chose to host it.
    private func exposedLabels(in window: UIWindow) -> [String] {
        var found = Set<String>()
        var visited = Set<ObjectIdentifier>()

        func add(_ value: String?) {
            guard let value, !value.isEmpty else { return }
            found.insert(value)
        }

        func visitBarItem(_ item: UIBarButtonItem) {
            add(item.title)
            add(item.accessibilityLabel)
            add(item.accessibilityIdentifier)
            if let custom = item.customView { visitElement(custom, depth: 0) }
        }

        func visitNavigationItem(_ item: UINavigationItem) {
            add(item.title)
            let groups = item.leadingItemGroups + item.centerItemGroups + item.trailingItemGroups
            let items = (item.leftBarButtonItems ?? []) + (item.rightBarButtonItems ?? [])
                + groups.flatMap(\.barButtonItems)
            for barItem in items { visitBarItem(barItem) }
        }

        func visitElement(_ element: Any, depth: Int) {
            guard depth < 64, let object = element as? NSObject else { return }
            guard visited.insert(ObjectIdentifier(object)).inserted else { return }
            add(object.accessibilityLabel)
            if let identified = object as? UIAccessibilityIdentification {
                add(identified.accessibilityIdentifier)
            }
            for child in object.accessibilityElements ?? [] {
                visitElement(child, depth: depth + 1)
            }
            guard let view = object as? UIView else { return }
            if let label = view as? UILabel { add(label.text) }
            if let button = view as? UIButton { add(button.currentTitle) }
            if let bar = view as? UINavigationBar {
                for item in bar.items ?? [] { visitNavigationItem(item) }
            }
            if let toolbar = view as? UIToolbar {
                for item in toolbar.items ?? [] { visitBarItem(item) }
            }
            for subview in view.subviews { visitElement(subview, depth: depth + 1) }
        }

        visitElement(window, depth: 0)
        return Array(found)
    }

    // MARK: - Evidence

    private func capture(_ window: UIWindow, name: String) {
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            XCTAssertTrue(window.drawHierarchy(in: window.bounds, afterScreenUpdates: true), "The actual window must render")
        }
        if let pixelData = image.cgImage?.dataProvider?.data as Data? {
            XCTAssertGreaterThan(Set(pixelData).count, 16, "A blank screenshot is not evidence")
        } else {
            XCTFail("Missing rendered image pixels")
        }
        let attachment = XCTAttachment(image: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let data = image.pngData() {
            writeEvidence(data, fileName: "\(name).png")
        } else {
            XCTFail("Could not encode \(name) as PNG")
        }
    }

    private func writeEvidence(_ data: Data, fileName: String) {
        guard let path = ProcessInfo.processInfo.environment["EVIDENCE_DIR"], !path.isEmpty else { return }
        let directory = URL(fileURLWithPath: path, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try data.write(to: directory.appending(path: fileName))
        } catch {
            XCTFail("Could not write evidence \(fileName): \(error)")
        }
    }

    private func makeWindow() throws -> UIWindow {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
        window.windowLevel = .normal + 1
        return window
    }

    // MARK: - Fixtures

    private static let threads: [MailThreadSummary] = {
        let now = Date()
        return [
            MailThreadSummary(
                id: "synthetic-1", accountID: "synthetic-account",
                subject: "Quarterly plan review",
                sender: "Ari Moreno <ari@example.com>",
                snippet: "I moved the review to Thursday at ten. The notes are in the shared folder.",
                date: now.addingTimeInterval(-600), unread: true, starred: false, category: "main"
            ),
            MailThreadSummary(
                id: "synthetic-2", accountID: "synthetic-account",
                subject: "Your receipt from the hardware store",
                sender: "Receipts <receipts@example.com>",
                snippet: "Thank you for your order. Pickup is ready at the front desk.",
                date: now.addingTimeInterval(-3_600), unread: false, starred: false, category: "main"
            ),
            MailThreadSummary(
                id: "synthetic-3", accountID: "synthetic-account",
                subject: "Soccer practice moves to Saturday",
                sender: "Sam Lee <sam@example.com>",
                snippet: "The field is closed on Friday, so practice is on Saturday morning.",
                date: now.addingTimeInterval(-7_200), unread: true, starred: true, category: "main"
            ),
            MailThreadSummary(
                id: "synthetic-4", accountID: "synthetic-account",
                subject: "Lease renewal documents",
                sender: "Jordan Park <jordan@example.com>",
                snippet: "Attached are the renewal documents. Sign them before the end of the month.",
                date: now.addingTimeInterval(-86_400), unread: false, starred: false, category: "main"
            ),
        ]
    }()
}
#endif
