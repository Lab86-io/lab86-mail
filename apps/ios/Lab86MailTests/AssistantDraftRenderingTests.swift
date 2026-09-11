#if os(iOS)
import SwiftUI
import UIKit
import XCTest
@testable import Lab86Mail

/// Hosts the actual production artifact with isolated state and a scripted
/// transport. No auth bypass, live model, account, or mail service is involved.
@MainActor
final class AssistantDraftRenderingTests: XCTestCase {
    func testInlineEmailLightDarkAndAccessibilityRendering() async throws {
        for (name, scheme, size) in [
            ("light", ColorScheme.light, DynamicTypeSize.large),
            ("dark", ColorScheme.dark, DynamicTypeSize.large),
            ("accessibility", ColorScheme.light, DynamicTypeSize.accessibility3)
        ] {
            let fixture = Fixture()
            defer { fixture.tearDown() }
            fixture.store.receive(fixture.seed, key: fixture.key, ownerID: "synthetic-owner")
            fixture.store.resolveAccountIfNeeded(fixture.key, ownerID: "synthetic-owner", accounts: fixture.accounts)
            await fixture.store.addAttachments([
                ComposeAttachment(filename: "meeting-notes.txt", contentType: "text/plain", data: Data("Synthetic notes".utf8))
            ], to: fixture.key, ownerID: "synthetic-owner")
            let appeared = expectation(description: "Production artifact appeared: \(name)")
            let controller = UIHostingController(rootView:
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        Text("Albatross").font(.largeTitle.bold())
                        Text("Draft a follow-up to Ari about tomorrow’s plan.").font(.body)
                        fixture.artifact
                    }
                    .padding(20)
                }
                .background(fixture.theme.paperColor)
                .environment(\.colorScheme, scheme)
                .environment(\.dynamicTypeSize, size)
                .onAppear { appeared.fulfill() }
            )
            let window = try makeWindow()
            window.overrideUserInterfaceStyle = scheme == .dark ? .dark : .light
            window.rootViewController = controller
            window.makeKeyAndVisible()
            defer { window.isHidden = true; window.rootViewController = nil }
            await fulfillment(of: [appeared], timeout: 5)
            controller.view.layoutIfNeeded()
            XCTAssertGreaterThan(controller.view.bounds.width, 0)
            XCTAssertEqual(fixture.store.record(for: fixture.key, ownerID: "synthetic-owner")?.body, fixture.seed.body)
            XCTAssertEqual(fixture.transport.sendCount, 0, "Rendering must never send mail")
            capture(window, name: "inline-email-\(name)")

            // Edit the actual UIKit control SwiftUI hosts, not a duplicate UI.
            if name == "light" {
                let fields = descendants(of: controller.view).compactMap { $0 as? UITextField }
                let recipient = try XCTUnwrap(fields.first { $0.text == "ari@example.com" })
                recipient.text = "ari@example.com, sam@example.com"
                recipient.sendActions(for: .editingChanged)
                XCTAssertEqual(fixture.store.record(for: fixture.key, ownerID: "synthetic-owner")?.to, "ari@example.com, sam@example.com")
                XCTAssertEqual(window.rootViewController, controller)
                XCTAssertNil(controller.presentedViewController, "Editing stays in chat, without a composer screen")
                recipient.becomeFirstResponder()
                controller.view.layoutIfNeeded()
                capture(window, name: "inline-email-editing")
                recipient.resignFirstResponder()
                fixture.store.reportAttachmentError("Couldn’t read the selected file. No files were attached. Try selecting it again.", for: fixture.key, ownerID: "synthetic-owner")
                controller.view.layoutIfNeeded()
                capture(window, name: "inline-email-attachment-error")
            }
            if name == "accessibility" {
                let scroll = try XCTUnwrap(descendants(of: controller.view).compactMap { $0 as? UIScrollView }
                    .first { $0.contentSize.height > $0.bounds.height })
                scroll.setContentOffset(CGPoint(x: 0, y: max(0, scroll.contentSize.height - scroll.bounds.height)), animated: false)
                controller.view.layoutIfNeeded()
                capture(window, name: "inline-email-accessibility-actions")
            }
        }
    }

    func testPendingAndUnconfirmedRenderWithoutFalseSentState() async throws {
        for (name, submission) in [
            ("pending", ComposeSubmission.pending(PendingSendReceipt(id: "synthetic-pending", fireAt: .now.addingTimeInterval(60), undoSeconds: 60, accountID: "synthetic-account", threadID: nil))),
            ("unconfirmed", ComposeSubmission.unconfirmed)
        ] {
            let fixture = Fixture()
            defer { fixture.tearDown() }
            fixture.transport.submission = submission
            fixture.store.receive(fixture.seed, key: fixture.key, ownerID: "synthetic-owner")
            fixture.store.resolveAccountIfNeeded(fixture.key, ownerID: "synthetic-owner", accounts: fixture.accounts)
            await fixture.store.send(fixture.key, ownerID: "synthetic-owner", pendingSends: fixture.pending, undoSeconds: 60)
            XCTAssertEqual(fixture.transport.sendCount, 1)
            let appeared = expectation(description: name)
            let controller = UIHostingController(rootView:
                ScrollView { fixture.artifact.padding(20) }
                    .environment(\.colorScheme, .light)
                    .onAppear { appeared.fulfill() }
            )
            let window = try makeWindow()
            window.rootViewController = controller
            window.makeKeyAndVisible()
            defer { window.isHidden = true; window.rootViewController = nil }
            await fulfillment(of: [appeared], timeout: 5)
            controller.view.layoutIfNeeded()
            capture(window, name: "inline-email-\(name)")
            XCTAssertNotEqual(fixture.store.record(for: fixture.key, ownerID: "synthetic-owner")?.delivery, .sent(messageID: nil))
            XCTAssertNil(controller.presentedViewController)
        }
    }

    private func capture(_ window: UIWindow, name: String) {
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            XCTAssertTrue(window.drawHierarchy(in: window.bounds, afterScreenUpdates: true), "The actual window must render")
        }
        if let pixelData = image.cgImage?.dataProvider?.data as Data? {
            XCTAssertGreaterThan(Set(pixelData).count, 16, "A blank/transparent screenshot is not acceptance evidence")
        } else { XCTFail("Missing rendered image pixels") }
        let attachment = XCTAttachment(image: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func makeWindow() throws -> UIWindow {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
        window.windowLevel = .normal + 1
        return window
    }

    private func descendants(of view: UIView) -> [UIView] {
        [view] + view.subviews.flatMap { descendants(of: $0) }
    }

    @MainActor private final class Transport: AssistantDraftTransport {
        var sendCount = 0
        var submission: ComposeSubmission = .unconfirmed
        func saveDraft(id: String?, accountID: String, threadID: String?, messageID: String?, to: String, cc: String, bcc: String, subject: String, body: String, scheduledFor: Date?) async throws -> String { "synthetic-draft" }
        func sendCompose(mode: String, accountID: String, threadID: String?, messageID: String?, to: String, cc: String, bcc: String, subject: String, body: String, attachments: [ComposeAttachment], sendAt: Date?, undoSeconds: Int) async throws -> ComposeSubmission {
            sendCount += 1
            return submission
        }
        func deleteDraft(id: String) async throws {}
    }

    @MainActor private final class Fixture {
        let suite = "AssistantDraftRenderingTests-\(UUID().uuidString)"
        let defaults: UserDefaults
        let directory: URL
        let transport = Transport()
        let server = StubBackendServer()
        let theme: ThemeStore
        let pending: PendingSendCoordinator
        let store: AssistantDraftStore
        let key = AssistantDraftKey(sessionID: "synthetic-session", toolCallID: "synthetic-email")
        let seed = AssistantDraftSeed(fromEmail: "alex@example.com", to: "ari@example.com", cc: "", bcc: "", subject: "Tomorrow’s plan", body: "Hi Ari,\n\nI’ve pulled together the notes from today. Let’s review the launch plan tomorrow and choose the next step.\n\nAlex")
        let accounts = [AccountSummary(json: .object(["accountId": .string("synthetic-account"), "email": .string("alex@example.com"), "primary": .bool(true)]))!]

        init() {
            defaults = UserDefaults(suiteName: suite)!
            directory = FileManager.default.temporaryDirectory.appending(path: suite, directoryHint: .isDirectory)
            theme = ThemeStore(defaults: defaults)
            pending = PendingSendCoordinator(backend: server.backend, tools: ToolClient(backend: server.backend), defaults: defaults)
            store = AssistantDraftStore(transport: transport, attachmentStore: MailIntentAttachmentStore(directory: directory), defaults: defaults, saveDelay: .zero)
        }

        var artifact: some View {
            AssistantDraftArtifactContent(key: key, seed: seed, store: store, ownerID: "synthetic-owner", accounts: accounts, pendingSends: pending, theme: theme, sendingPreferences: { 10 })
        }

        func tearDown() {
            server.tearDown()
            defaults.removePersistentDomain(forName: suite)
            try? FileManager.default.removeItem(at: directory)
        }
    }
}
#endif
