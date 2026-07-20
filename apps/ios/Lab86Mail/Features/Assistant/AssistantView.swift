import SwiftUI

struct AssistantView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var isCapturing = false
    @State private var resultMessage: String?
    @State private var errorMessage: String?
    @State private var modelStatus = "Checking on-device intelligence…"

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextEditor(text: $text)
                        .frame(minHeight: 180)
                        .accessibilityLabel("Tell Albatross what is on your mind")
                } header: {
                    Text("What are you trying to move forward?")
                } footer: {
                    Text("Speak with keyboard dictation or type freely. Your original words are saved before Albatross structures them.")
                }

                Section("Intelligence") {
                    Label(modelStatus, systemImage: "apple.intelligence")
                        .font(.subheadline)
                }

                if let resultMessage {
                    Section { Label(resultMessage, systemImage: "checkmark.circle.fill").foregroundStyle(.green) }
                }
                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Albatross")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Capture") { Task { await capture() } }
                        .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isCapturing)
                }
            }
            .onAppear {
                if text.isEmpty, let pending = environment.navigation.pendingCapture {
                    text = pending
                    environment.navigation.pendingCapture = nil
                }
            }
            .task { modelStatus = await environment.modelRouter.availabilityLabel() }
        }
    }

    private func capture() async {
        isCapturing = true
        defer { isCapturing = false }
        do {
            try await environment.store.capture(text)
            resultMessage = "Captured. Albatross kept the source and added the resulting Work."
            errorMessage = nil
            text = ""
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

