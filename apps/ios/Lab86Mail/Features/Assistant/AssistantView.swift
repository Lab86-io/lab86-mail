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
    @State private var captureSuggestions: [CaptureSuggestion] = []
    @State private var showsCaptureReview = false
    @State private var showsDiscardConfirmation = false
    @State private var voice = CaptureVoiceCoordinator()
    @State private var location = CaptureLocationCoordinator()
    @State private var voiceStartText = ""
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
                    if let error = voice.errorMessage ?? location.errorMessage {
                        Text(error)
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
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") {
                        if isDirty {
                            showsDiscardConfirmation = true
                        } else {
                            dismiss()
                        }
                    }
                }
            }
            .onAppear {
                if text.isEmpty, let pending = environment.navigation.pendingCapture {
                    text = pending
                    environment.navigation.pendingCapture = nil
                }
                editorFocused = true
            }
            .task { modelStatus = await environment.modelRouter.availabilityLabel() }
            .onChange(of: voice.transcript) { _, transcript in
                guard voice.isRecording || !transcript.isEmpty else { return }
                text = [voiceStartText, transcript]
                    .filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
                    .joined(separator: voiceStartText.isEmpty ? "" : "\n\n")
            }
            .onDisappear { voice.stop() }
            .confirmationDialog(
                "Discard this capture?",
                isPresented: $showsDiscardConfirmation,
                titleVisibility: .visible
            ) {
                Button("Discard Capture", role: .destructive) { dismiss() }
                Button("Keep Editing", role: .cancel) {}
            } message: {
                Text("Your words have not been saved yet.")
            }
            .sheet(isPresented: $showsCaptureReview) {
                CaptureReviewSheet(items: captureSuggestions, originalText: text) { reviewed in
                    await commit(reviewed)
                }
            }
        }
        .presentationDetents([.large])
        .presentationCornerRadius(28)
        .interactiveDismissDisabled(isDirty)
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
        VStack(spacing: 7) {
            if !didCapture {
                HStack(spacing: 10) {
                    Button {
                        if !voice.isRecording { voiceStartText = text }
                        Task { await voice.toggle() }
                    } label: {
                        Label(
                            voice.isRecording ? "Stop recording" : "Record",
                            systemImage: voice.isRecording ? "stop.circle.fill" : "mic.circle"
                        )
                    }
                    .tint(voice.isRecording ? .red : environment.theme.accentColor)
                    .accessibilityHint("Permission is requested only after you choose Record.")

                    Button {
                        if location.location == nil {
                            location.requestOnce()
                        } else {
                            location.clear()
                        }
                    } label: {
                        Label(
                            location.location == nil
                                ? (location.isRequesting ? "Locating…" : "Add location")
                                : "Location added",
                            systemImage: location.location == nil ? "location.circle" : "location.fill"
                        )
                    }
                    .disabled(location.isRequesting)
                    .accessibilityHint("Attaches approximate coordinates to planning only after consent.")
                    Spacer()
                }
                .font(.caption.weight(.medium))
            }
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

    private var isDirty: Bool {
        !didCapture && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func capture() async {
        voice.stop()
        isCapturing = true
        defer { isCapturing = false }
        do {
            let suggestions = try await environment.store.analyzeCapture(text)
            if suggestions.count > 1 {
                captureSuggestions = suggestions
                showsCaptureReview = true
            } else {
                let reviewed = suggestions.isEmpty
                    ? [CaptureSuggestion(title: "Work", rawText: text)]
                    : suggestions
                await commit(reviewed)
            }
        } catch {
            let analysisFailure = error.localizedDescription
            await commit([CaptureSuggestion(title: "Work", rawText: text)])
            if didCapture {
                errorMessage = "Saved as one Work because split review was unavailable: \(analysisFailure)"
            }
        }
    }

    private func commit(_ reviewed: [CaptureSuggestion]) async {
        isCapturing = true
        defer { isCapturing = false }
        do {
            let warning = try await environment.store.capture(
                text,
                reviewedItems: reviewed,
                transcript: voiceTranscript,
                location: location.location.map {
                    (latitude: $0.coordinate.latitude, longitude: $0.coordinate.longitude)
                }
            )
            showsCaptureReview = false
            errorMessage = warning
            text = ""
            withAnimation(.snappy(duration: 0.25)) { didCapture = true }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private var voiceTranscript: String? {
        let value = voice.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }
}

private struct CaptureReviewSheet: View {
    @Environment(\.dismiss) private var dismiss
    let originalText: String
    let onCommit: ([CaptureSuggestion]) async -> Void
    @State private var items: [CaptureSuggestion]
    @State private var isSaving = false

    init(
        items: [CaptureSuggestion],
        originalText: String,
        onCommit: @escaping ([CaptureSuggestion]) async -> Void
    ) {
        self.originalText = originalText
        self.onCommit = onCommit
        _items = State(initialValue: items)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Albatross found \(items.count) independent outcomes. Review every item before Work is created.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                ForEach($items) { $item in
                    Section {
                        TextField("Outcome", text: $item.title)
                        TextEditor(text: $item.rawText)
                            .frame(minHeight: 80)
                    }
                }
            }
            .navigationTitle("Split this capture?")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Edit Capture") { dismiss() }
                }
                ToolbarItemGroup(placement: .confirmationAction) {
                    Button("Keep Together") {
                        Task {
                            isSaving = true
                            await onCommit([
                                CaptureSuggestion(
                                    title: items.first?.title ?? "Work",
                                    rawText: originalText
                                )
                            ])
                            isSaving = false
                        }
                    }
                    Button("Create \(items.count) Work") {
                        Task {
                            isSaving = true
                            await onCommit(items)
                            isSaving = false
                        }
                    }
                    .disabled(
                        isSaving
                            || items.contains {
                                $0.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                    || $0.rawText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            }
                    )
                }
            }
        }
        .presentationDetents([.large])
        .interactiveDismissDisabled(isSaving)
    }
}
