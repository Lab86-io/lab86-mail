import SwiftUI

// Intent capture, mirroring the desktop takeover: a display-face prompt on
// the paper field, a large borderless dump area with the accent caret, and a
// single named action. The original words are saved before Albatross
// structures them; the capture pipeline is unchanged.
struct AssistantView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var isCapturing = false
    @State private var didCapture = false
    @State private var errorMessage: String?
    @State private var modelStatus = "Checking on-device intelligence…"
    @FocusState private var editorFocused: Bool

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    Text("What are you trying to get out of your head?")
                        .font(environment.theme.displayType.displayFont(size: 28))
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 18)

                    if didCapture {
                        savedBeat
                    } else {
                        TextField(
                            "Type or dictate freely — rough is fine.",
                            text: $text,
                            axis: .vertical
                        )
                        .font(.title3)
                        .lineLimit(6...)
                        .tint(environment.theme.accentColor)
                        .focused($editorFocused)
                        .accessibilityLabel("Tell Albatross what is on your mind")
                    }

                    if let errorMessage {
                        Text(errorMessage)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }
                .padding(.horizontal, 24)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(environment.theme.paperColor)
            .scrollDismissesKeyboard(.interactively)
            .safeAreaInset(edge: .bottom, spacing: 0) { captureBar }
            .navigationTitle("New intent")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
            }
            .onAppear {
                if text.isEmpty, let pending = environment.navigation.pendingCapture {
                    text = pending
                    environment.navigation.pendingCapture = nil
                }
                editorFocused = true
            }
            .task { modelStatus = await environment.modelRouter.availabilityLabel() }
        }
        .presentationDetents([.large])
        .presentationCornerRadius(28)
    }

    private var savedBeat: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Got it. Making Work.")
                .font(.body.weight(.medium))
            Text("Albatross kept your original words and added the resulting Work to your areas.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            environment.theme.accentSoftColor,
            in: RoundedRectangle(cornerRadius: 16, style: .continuous)
        )
        .accessibilityElement(children: .combine)
    }

    private var captureBar: some View {
        HStack(spacing: 10) {
            Text(modelStatus)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
            Spacer(minLength: 8)
            if didCapture {
                Button("Done") { dismiss() }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                    .buttonStyle(.plain)
                    .padding(.horizontal, 18)
                    .padding(.vertical, 9)
                    .background(Capsule().fill(environment.theme.accentColor))
            } else {
                Button {
                    Task { await capture() }
                } label: {
                    if isCapturing {
                        ProgressView()
                            .padding(.horizontal, 18)
                            .padding(.vertical, 7)
                    } else {
                        Text("Get it out")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 18)
                            .padding(.vertical, 9)
                    }
                }
                .buttonStyle(.plain)
                .background(
                    Capsule().fill(
                        canCapture ? environment.theme.accentColor : Color.secondary.opacity(0.4)
                    )
                )
                .disabled(!canCapture)
                .accessibilityLabel("Capture")
            }
        }
        .padding(.leading, 16)
        .padding(.trailing, 6)
        .padding(.vertical, 6)
        .glassEffect(.regular.interactive(), in: .capsule)
        .padding(.horizontal, 14)
        .padding(.top, 6)
        .padding(.bottom, 8)
    }

    private var canCapture: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isCapturing
    }

    private func capture() async {
        isCapturing = true
        defer { isCapturing = false }
        do {
            try await environment.store.capture(text)
            errorMessage = nil
            text = ""
            withAnimation(.snappy(duration: 0.25)) { didCapture = true }
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
