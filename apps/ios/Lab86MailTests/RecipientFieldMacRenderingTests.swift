#if os(macOS)
import AppKit
import SwiftUI
import XCTest
@testable import Lab86Mail

/// Renders the Mac compose recipient rows (the floating list and chips that
/// wrap) in an offscreen window at the Mac text sizes, and keeps each image.
/// When `EVIDENCE_DIR` is set, the images are also written there as PNG files.
///
/// Native acceptance CI only compiles the Mac tests (its host cannot run a
/// macOS 27 app); the iOS `RecipientFieldRenderingTests` render the same
/// shared layout at the Mac width. Run this on a Mac with
/// `-only-testing:Lab86MailMacTests/RecipientFieldMacRenderingTests`.
@MainActor
final class RecipientFieldMacRenderingTests: XCTestCase {
    private struct Scenario {
        let name: String
        let to: String
        let presentation: RecipientFieldPresentation
        var scheme: ColorScheme = .light
    }

    func testTheMacRecipientRowsRender() async throws {
        let scenarios = [
            Scenario(
                name: "recipient-macos-dropdown-typing",
                to: "Sam Lee <sam@example.com>",
                presentation: RecipientFieldPresentation(draft: "jl", suggestions: Self.suggestions, highlightedIndex: 0)
            ),
            Scenario(
                name: "recipient-macos-dropdown-dark",
                to: "",
                presentation: RecipientFieldPresentation(draft: "", suggestions: Self.suggestions, highlightedIndex: 1),
                scheme: .dark
            ),
            Scenario(
                name: "recipient-macos-chips-wrap",
                to: Self.manyRecipients,
                presentation: RecipientFieldPresentation(showsList: false, selectedTokenIndex: 2)
            ),
        ]
        for scenario in scenarios {
            let suite = "RecipientFieldMacRenderingTests-\(UUID().uuidString)"
            let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
            defer { defaults.removePersistentDomain(forName: suite) }
            let theme = ThemeStore(defaults: defaults)
            let host = NSHostingView(rootView:
                Harness(to: scenario.to, presentation: scenario.presentation, theme: theme)
                    .environment(\.colorScheme, scenario.scheme)
            )
            host.safeAreaRegions = []
            let frame = NSRect(x: 0, y: 0, width: 720, height: 480)
            host.frame = frame
            let window = NSWindow(contentRect: frame, styleMask: [.titled], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.appearance = NSAppearance(named: scenario.scheme == .dark ? .darkAqua : .aqua)
            window.contentView = host
            defer { window.contentView = nil }
            for _ in 0..<3 {
                host.layoutSubtreeIfNeeded()
                try await Task.sleep(for: .milliseconds(60))
            }
            let rep = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
            host.cacheDisplay(in: host.bounds, to: rep)
            let data = try XCTUnwrap(rep.representation(using: .png, properties: [:]))
            XCTAssertGreaterThan(Set(data).count, 16, "A blank image is not evidence")
            let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.png")
            attachment.name = scenario.name
            attachment.lifetime = .keepAlways
            add(attachment)
            writeEvidence(data, name: scenario.name)
        }
    }

    private struct Harness: View {
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
                    presentation: RecipientFieldPresentation(showsList: false)
                )
                Divider().overlay(theme.hairlineColor).padding(.leading, 20)
                Text("Quarterly numbers")
                    .font(theme.displayType.displayFont(size: 24))
                    .padding(.horizontal, 20)
                    .padding(.vertical, 14)
                Divider().overlay(theme.hairlineColor).padding(.leading, 20)
                Text("Hi all, the draft for the board is attached.")
                    .padding(.horizontal, 20)
                    .padding(.top, 10)
                Spacer(minLength: 0)
            }
            .padding(.top, 12)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .background(theme.paperColor)
        }
    }

    private func writeEvidence(_ data: Data, name: String) {
        guard let path = ProcessInfo.processInfo.environment["EVIDENCE_DIR"], !path.isEmpty else { return }
        let directory = URL(fileURLWithPath: path, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try data.write(to: directory.appending(path: "\(name).png"))
        } catch {
            XCTFail("Could not write evidence \(name): \(error)")
        }
    }

    private static let suggestions = [
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
        RecipientSuggestion(email: "julia.lopez@example.com", name: "Julia Lopez", sources: [.mail]),
        RecipientSuggestion(
            email: "jl@lab86.io",
            sources: [.typed],
            highlights: [RecipientHighlight(field: .email, start: 0, length: 2)]
        ),
    ]

    private static let manyRecipients = [
        "Jakob Langtry <jakob@lab86.io>",
        "Sam Lee <sam.lee@statpearls.com>",
        "Ari Moreno <ari@example.com>",
        "billing@lab86.io",
        "Julia Lopez <julia.lopez@example.com>",
        "Amara Okafor <amara@lab86.io>",
        "john",
    ].joined(separator: ", ")
}
#endif
