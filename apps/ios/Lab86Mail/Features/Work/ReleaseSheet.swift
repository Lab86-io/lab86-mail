import SwiftUI

/// Putting an Albatross down: the web's `ReleaseSheet`
/// (components/albatross/Forgiveness.tsx). Release is an ending in the same
/// family as completion, not a failure. The sheet asks for an optional
/// reason and keeps the history.
///
/// The request goes to the recover route with the `release` recovery
/// (app/api/albatross/work/[workId]/recover), the one route that releases
/// Work over HTTP. The reason travels in the body for the day the route reads
/// it; today the route records a fixed reason.
enum ReleaseRequest {
    static func path(workID: String) -> String {
        "/api/albatross/work/\(workID)/recover"
    }

    static func body(reason: String, timezone: String) -> JSONValue {
        var fields: [String: JSONValue] = [
            "recovery": .string("release"),
            "reasonKind": .string("other"),
            "timezone": .string(timezone),
        ]
        if let trimmed = reason.trimmingCharacters(in: .whitespacesAndNewlines).nilIfBlank {
            fields["reason"] = .string(trimmed)
        }
        return .object(fields)
    }
}

enum ReleaseCopy {
    static func title(_ workTitle: String) -> String { "Put “\(workTitle)” down?" }
    static let body = "Deciding something no longer deserves your attention is a real ending, not a failure. Albatross keeps the history."
    static let reasonPrompt = "Why, if you want to say"
    static let put = "Put it down"
    static let putting = "Putting it down…"
    static let keep = "Keep it"
    static let releasedTitle = "That is one less thing."
    static let releasedBody = "You can pick it up again whenever you want. Nothing was deleted."
    static let done = "Done"
    static let failed = "Could not put that down."
}

struct ReleaseSheet: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss
    let workID: String
    let title: String
    /// Runs after the server confirms, before the receipt shows.
    var onReleased: () async -> Void = {}

    @State private var reason = ""
    @State private var isSending = false
    @State private var released = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Group {
                if released {
                    receipt
                } else {
                    form
                }
            }
            // The question in the form is the title; the bar does not say it
            // twice.
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if !released {
                        Button(ReleaseCopy.keep) { dismiss() }
                            .disabled(isSending)
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .interactiveDismissDisabled(isSending)
    }

    private var form: some View {
        Form {
            Section {
                Text(ReleaseCopy.title(title))
                    .font(environment.theme.displayType.displayFont(size: 20))
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                Text(ReleaseCopy.body)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Section {
                TextField(ReleaseCopy.reasonPrompt, text: $reason, axis: .vertical)
                    .lineLimit(1...4)
                    .accessibilityLabel("Why you are putting this down, optional")
            }
            Section {
                Button {
                    Task { await put() }
                } label: {
                    if isSending {
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.small)
                            Text(ReleaseCopy.putting)
                        }
                    } else {
                        Text(ReleaseCopy.put)
                    }
                }
                .disabled(isSending)
                if let errorMessage {
                    Text(errorMessage)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private var receipt: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(ReleaseCopy.releasedTitle)
                .font(environment.theme.displayType.displayFont(size: 24))
                .fixedSize(horizontal: false, vertical: true)
            Text(ReleaseCopy.releasedBody)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button(ReleaseCopy.done) { dismiss() }
                .buttonStyle(.bordered)
                .padding(.top, 8)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(24)
        .background(environment.theme.paperColor)
        .accessibilityElement(children: .contain)
    }

    private func put() async {
        isSending = true
        errorMessage = nil
        defer { isSending = false }
        do {
            let exchange = try await environment.backend.exchange(
                method: "POST",
                path: ReleaseRequest.path(workID: workID),
                body: ReleaseRequest.body(reason: reason, timezone: TimeZone.current.identifier)
            )
            guard exchange.isSuccess else {
                errorMessage = exchange.errorMessage
                return
            }
            await onReleased()
            released = true
        } catch {
            guard !error.isCancellation else { return }
            errorMessage = error.localizedDescription.nilIfBlank ?? ReleaseCopy.failed
        }
    }
}
