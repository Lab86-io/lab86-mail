#if os(iOS)
import SwiftUI
import UIKit
import XCTest
@testable import Lab86Mail

/// Renders the real recipient field in its key states from fixed data, in a
/// real window, and keeps each image. When `EVIDENCE_DIR` is set (CI exports
/// `TEST_RUNNER_EVIDENCE_DIR`), the images are also written there as PNG files.
@MainActor
final class RecipientFieldRenderingTests: XCTestCase {
    private struct Scenario {
        let name: String
        let value: String
        let presentation: RecipientFieldPresentation
        var scheme: ColorScheme = .light
        var size: DynamicTypeSize = .large
    }

    func testRecipientFieldKeyStatesRender() async throws {
        let typing = RecipientFieldPresentation(
            draft: "jl",
            suggestions: Self.typingSuggestions,
            highlightedIndex: 0
        )
        let scenarios = [
            Scenario(
                name: "recipient-top-people",
                value: "",
                presentation: RecipientFieldPresentation(draft: "", suggestions: Self.topPeople)
            ),
            Scenario(name: "recipient-typing-jl", value: "", presentation: typing),
            Scenario(
                name: "recipient-chips-invalid",
                value: "Jakob Langtry <jakob@lab86.io>, sam@example.com, john",
                presentation: RecipientFieldPresentation(showsList: false)
            ),
            Scenario(
                name: "recipient-chip-selected",
                value: "Jakob Langtry <jakob@lab86.io>, sam@example.com",
                presentation: RecipientFieldPresentation(showsList: false, selectedTokenIndex: 1)
            ),
            Scenario(name: "recipient-typing-jl-dark", value: "Sam Lee <sam@example.com>", presentation: typing, scheme: .dark),
            Scenario(
                name: "recipient-typing-jl-accessibility",
                value: "Sam Lee <sam@example.com>, john",
                presentation: typing,
                size: .accessibility3
            ),
        ]
        for scenario in scenarios {
            let suite = "RecipientFieldRenderingTests-\(UUID().uuidString)"
            let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
            defer { defaults.removePersistentDomain(forName: suite) }
            let theme = ThemeStore(defaults: defaults)
            let appeared = expectation(description: "Rendered: \(scenario.name)")
            let controller = UIHostingController(rootView:
                Harness(value: scenario.value, presentation: scenario.presentation, theme: theme)
                    .environment(\.colorScheme, scenario.scheme)
                    .environment(\.dynamicTypeSize, scenario.size)
                    .onAppear { appeared.fulfill() }
            )
            let window = try makeWindow()
            window.overrideUserInterfaceStyle = scenario.scheme == .dark ? .dark : .light
            window.rootViewController = controller
            window.makeKeyAndVisible()
            defer { window.isHidden = true; window.rootViewController = nil }
            await fulfillment(of: [appeared], timeout: 5)
            controller.view.setNeedsLayout()
            controller.view.layoutIfNeeded()
            try await Task.sleep(for: .milliseconds(150))
            controller.view.layoutIfNeeded()
            capture(window, name: scenario.name)
        }
    }

    /// The Mac compose layout, from shared code: the floating list under the
    /// To line, over the Cc row and the subject, at a Mac sheet width
    /// (720 pt). The phone window is narrower, so the scene is scaled into it.
    /// Extra-small Dynamic Type is near the Mac's 13 pt text; the Mac test
    /// (`RecipientFieldMacRenderingTests`) renders the real Mac sizes.
    func testTheMacFloatingListRendersAtMacWidth() async throws {
        let scenarios: [(name: String, to: String, presentation: RecipientFieldPresentation, scheme: ColorScheme)] = [
            (
                "recipient-mac-dropdown-typing",
                "Sam Lee <sam@example.com>",
                RecipientFieldPresentation(draft: "jl", suggestions: Self.typingSuggestions, highlightedIndex: 0, placement: .dropdown),
                .light
            ),
            (
                "recipient-mac-dropdown-top-people-dark",
                "",
                RecipientFieldPresentation(draft: "", suggestions: Self.topPeople, highlightedIndex: 1, placement: .dropdown),
                .dark
            ),
            (
                "recipient-mac-dropdown-eight-rows",
                "",
                RecipientFieldPresentation(draft: "a", suggestions: Self.eightPeople, highlightedIndex: 2, placement: .dropdown),
                .light
            ),
            (
                "recipient-mac-chips-wrap",
                Self.manyRecipients,
                RecipientFieldPresentation(showsList: false, selectedTokenIndex: 3, placement: .dropdown),
                .light
            ),
        ]
        let sceneSize = CGSize(width: 720, height: 540)
        for scenario in scenarios {
            let suite = "RecipientFieldRenderingTests-\(UUID().uuidString)"
            let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
            defer { defaults.removePersistentDomain(forName: suite) }
            let theme = ThemeStore(defaults: defaults)
            let window = try makeWindow()
            let scale = window.bounds.width / sceneSize.width
            let appeared = expectation(description: "Rendered: \(scenario.name)")
            let controller = UIHostingController(rootView:
                MacComposeHarness(to: scenario.to, presentation: scenario.presentation, theme: theme)
                    .frame(width: sceneSize.width, height: sceneSize.height, alignment: .top)
                    .environment(\.colorScheme, scenario.scheme)
                    .environment(\.dynamicTypeSize, .xSmall)
                    .scaleEffect(scale, anchor: .topLeading)
                    // A fixed frame of the window size: the 720 pt scene starts
                    // at the leading edge and the scale draws it inside the window.
                    .frame(width: window.bounds.width, height: window.bounds.height, alignment: .topLeading)
                    .background(theme.paperColor)
                    .ignoresSafeArea()
                    .onAppear { appeared.fulfill() }
            )
            window.overrideUserInterfaceStyle = scenario.scheme == .dark ? .dark : .light
            window.rootViewController = controller
            window.makeKeyAndVisible()
            defer { window.isHidden = true; window.rootViewController = nil }
            await fulfillment(of: [appeared], timeout: 5)
            controller.view.setNeedsLayout()
            controller.view.layoutIfNeeded()
            try await Task.sleep(for: .milliseconds(150))
            controller.view.layoutIfNeeded()
            capture(window, name: scenario.name, height: sceneSize.height * scale)
        }
    }

    func testTheFieldTurnsTypedTextIntoChipsInTheRealTextField() async throws {
        let suite = "RecipientFieldRenderingTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let model = ValueBox(value: "ari@example.com")
        let controller = UIHostingController(rootView:
            BoundHarness(box: model, theme: ThemeStore(defaults: defaults))
        )
        let window = try makeWindow()
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer { window.isHidden = true; window.rootViewController = nil }
        controller.view.layoutIfNeeded()

        let field = try XCTUnwrap(
            descendants(of: controller.view)
                .compactMap { $0 as? UITextField }
                .first { $0.text == RecipientFieldText.display("") }
        )
        // A comma after a complete address makes a chip; the bound value keeps
        // the comma-separated format the composer sends.
        field.text = RecipientFieldText.display("sam@example.com,")
        field.sendActions(for: .editingChanged)
        try await waitUntil {
            controller.view.layoutIfNeeded()
            return model.value == "ari@example.com, sam@example.com" && field.text == RecipientFieldText.display("")
        }
        XCTAssertEqual(model.value, "ari@example.com, sam@example.com")
        XCTAssertEqual(field.text, RecipientFieldText.display(""))

        // Backspace with nothing typed selects the last chip, then removes it.
        field.text = ""
        field.sendActions(for: .editingChanged)
        try await waitUntil { controller.view.layoutIfNeeded(); return field.text == RecipientFieldText.display("") }
        XCTAssertEqual(model.value, "ari@example.com, sam@example.com")
        field.text = ""
        field.sendActions(for: .editingChanged)
        try await waitUntil { controller.view.layoutIfNeeded(); return model.value == "ari@example.com" }
        XCTAssertEqual(model.value, "ari@example.com")
    }

    // MARK: - Harness

    private struct Harness: View {
        @FocusState private var focus: Int?
        @State private var value: String
        let presentation: RecipientFieldPresentation
        let theme: ThemeStore

        init(value: String, presentation: RecipientFieldPresentation, theme: ThemeStore) {
            _value = State(initialValue: value)
            self.presentation = presentation
            self.theme = theme
        }

        var body: some View {
            VStack(alignment: .leading, spacing: 0) {
                Text("New Message")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                Divider().overlay(theme.hairlineColor)
                RecipientField(
                    title: "To",
                    value: $value,
                    focus: $focus,
                    focusValue: 0,
                    isFocused: true,
                    theme: theme,
                    searcher: nil,
                    presentation: presentation
                ) {
                    Text("Cc, Bcc")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .padding(.vertical, RecipientChipMetrics.verticalInset)
                }
                Divider().overlay(theme.hairlineColor)
                Text("Subject")
                    .font(theme.displayType.displayFont(size: 24))
                    .foregroundStyle(.tertiary)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 14)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .background(theme.paperColor)
        }
    }

    /// The top of the Mac compose sheet: To (with the floating list), Cc,
    /// the subject, and the first body line, so the list shows over them.
    private struct MacComposeHarness: View {
        @FocusState private var focus: Int?
        @State private var to: String
        @State private var cc = "Ari Moreno <ari@example.com>"
        let presentation: RecipientFieldPresentation
        let theme: ThemeStore

        init(to: String, presentation: RecipientFieldPresentation, theme: ThemeStore) {
            _to = State(initialValue: to)
            self.presentation = presentation
            self.theme = theme
        }

        var body: some View {
            VStack(alignment: .leading, spacing: 0) {
                Text("New Message")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                Divider().overlay(theme.hairlineColor)
                RecipientField(
                    title: "To",
                    value: $to,
                    focus: $focus,
                    focusValue: 0,
                    isFocused: true,
                    theme: theme,
                    searcher: nil,
                    presentation: presentation
                ) {
                    Text("Cc, Bcc")
                        .font(RecipientFieldMetrics.font)
                        .foregroundStyle(.secondary)
                        .padding(.vertical, RecipientChipMetrics.verticalInset)
                }
                Divider().overlay(theme.hairlineColor).padding(.leading, 20)
                RecipientField(
                    title: "Cc",
                    value: $cc,
                    focus: $focus,
                    focusValue: 1,
                    isFocused: false,
                    theme: theme,
                    searcher: nil,
                    presentation: RecipientFieldPresentation(showsList: false, placement: .dropdown)
                )
                Divider().overlay(theme.hairlineColor).padding(.leading, 20)
                Text("Quarterly numbers")
                    .font(theme.displayType.displayFont(size: 24))
                    .padding(.horizontal, 20)
                    .padding(.vertical, 14)
                Divider().overlay(theme.hairlineColor).padding(.leading, 20)
                Text("Hi all, the draft for the board is attached. Please read it before Thursday.")
                    .font(.body)
                    .padding(.horizontal, 20)
                    .padding(.top, 10)
                Spacer(minLength: 0)
            }
            .background(theme.paperColor)
        }
    }

    @MainActor private final class ValueBox {
        var value: String
        init(value: String) { self.value = value }
    }

    private struct BoundHarness: View {
        @FocusState private var focus: Int?
        let box: ValueBox
        let theme: ThemeStore

        init(box: ValueBox, theme: ThemeStore) {
            self.box = box
            self.theme = theme
        }

        var body: some View {
            RecipientField(
                title: "To",
                value: Binding(get: { box.value }, set: { box.value = $0 }),
                focus: $focus,
                focusValue: 0,
                isFocused: false,
                theme: theme,
                searcher: nil
            )
            .frame(maxHeight: .infinity, alignment: .top)
        }
    }

    // MARK: - Helpers

    /// Renders the window. `height` crops the image to the top of the window.
    private func capture(_ window: UIWindow, name: String, height: CGFloat? = nil) {
        var area = window.bounds
        if let height { area.size.height = min(area.height, height.rounded(.up)) }
        let image = UIGraphicsImageRenderer(bounds: area).image { _ in
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
        writeEvidence(image, name: name)
    }

    private func writeEvidence(_ image: UIImage, name: String) {
        guard let path = ProcessInfo.processInfo.environment["EVIDENCE_DIR"], !path.isEmpty else { return }
        let directory = URL(fileURLWithPath: path, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let data = try XCTUnwrap(image.pngData())
            try data.write(to: directory.appending(path: "\(name).png"))
        } catch {
            XCTFail("Could not write evidence \(name): \(error)")
        }
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

    private func waitUntil(timeout: Duration = .seconds(3), _ condition: () -> Bool) async throws {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while !condition() {
            guard clock.now < deadline else {
                XCTFail("The condition did not become true in time.")
                return
            }
            try await Task.sleep(for: .milliseconds(20))
        }
    }

    // MARK: - Fixtures

    private static let topPeople = [
        RecipientSuggestion(email: "jakob@lab86.io", name: "Jakob Langtry", savedContact: true, sources: [.addressBook, .mail]),
        RecipientSuggestion(email: "sam.lee@statpearls.com", name: "Sam Lee", sources: [.mail]),
        RecipientSuggestion(email: "ari@example.com", name: "Ari Moreno", sources: [.mail]),
        RecipientSuggestion(email: "billing@lab86.io", sources: [.inbox]),
    ]

    private static let typingSuggestions = [
        RecipientSuggestion(
            email: "jakob@lab86.io",
            name: "Jakob Langtry",
            alternateEmails: ["jakob@gmail.com"],
            savedContact: true,
            sources: [.addressBook, .mail],
            highlights: [
                RecipientHighlight(field: .name, start: 0, length: 1),
                RecipientHighlight(field: .name, start: 6, length: 1),
            ]
        ),
        RecipientSuggestion(
            email: "julia.lopez@example.com",
            name: "Julia Lopez",
            sources: [.mail],
            highlights: [
                RecipientHighlight(field: .name, start: 0, length: 1),
                RecipientHighlight(field: .name, start: 6, length: 1),
            ]
        ),
        RecipientSuggestion(
            email: "jl@lab86.io",
            sources: [.typed],
            highlights: [RecipientHighlight(field: .email, start: 0, length: 2)]
        ),
    ]

    /// Eight rows, the most the field asks for: the list reaches its height limit.
    private static let eightPeople = [
        ("Ari Moreno", "ari@example.com"),
        ("Alex Chen", "alex.chen@statpearls.com"),
        ("Amara Okafor", "amara@lab86.io"),
        ("Anna Lindqvist", "anna.lindqvist@example.org"),
        ("Arjun Mehta", "arjun@example.com"),
        ("Avery Brooks", "avery.brooks@example.net"),
        ("Aiko Tanaka", "aiko@example.jp"),
        ("Adam Novak", "adam.novak@example.com"),
    ].map { name, email in
        RecipientSuggestion(
            email: email,
            name: name,
            sources: [.mail],
            highlights: [RecipientHighlight(field: .name, start: 0, length: 1)]
        )
    }

    /// Enough people to wrap the chips onto a second line at the Mac width,
    /// with one address that is not complete.
    private static let manyRecipients = [
        "Jakob Langtry <jakob@lab86.io>",
        "Sam Lee <sam.lee@statpearls.com>",
        "Ari Moreno <ari@example.com>",
        "billing@lab86.io",
        "Julia Lopez <julia.lopez@example.com>",
        "Amara Okafor <amara@lab86.io>",
        "Alexandra Whitfield-Montgomery <alexandra.whitfield-montgomery@example.org>",
        "john",
    ].joined(separator: ", ")
}
#endif
