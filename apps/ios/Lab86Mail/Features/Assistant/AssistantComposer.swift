import SwiftUI

// The glass composer of every Albatross conversation: the attach control,
// the field, the route chip, and send or stop. The Chat tab and the Albatross
// thread share it. The host owns the draft, the pending files, the file
// importer, and what a submit does.
struct AssistantComposer: View {
    @Environment(AppEnvironment.self) private var environment
    @Bindable var model: AssistantChatModel
    @Binding var draft: String
    @Binding var pendingFiles: [ComposeAttachment]
    var focus: FocusState<Bool>.Binding
    var placeholder = "Ask or hold"
    /// The thread is its own context: it hides the "Work: …" chip.
    var hidesContextChip = false
    /// "To the run · Step 2, Renew online" while the route is Run
    /// (docs/albatross-threads.md, lead decision 5).
    var routeLine: String? = nil
    /// "Stop and redirect" armed the composer: the strip says so, with Cancel.
    var armed: ComposerArmedNotice? = nil
    /// A reply runs on the server: an Ask waits until it ends.
    var sendDisabled = false
    let onSubmit: () -> Void
    let onAttach: () -> Void

    // The secret notice (docs/albatross-secure-store.md, V9): the values in
    // the draft that look like a Social Security number, a card number, or
    // an API key. Return and the send control send without them; "Save in
    // Passwords and IDs" opens the add sheet with the first one.
    @State private var secretHits: [SecretShapeMatch] = []
    @State private var secretEditing: SecureItemEditorView.Target?
    @State private var draftBeforeSave: String?
    @State private var savedLine: String?
    @State private var savedLineTask: Task<Void, Never>?

    var body: some View {
        VStack(spacing: 4) {
            if let armed {
                ComposerArmedStrip(notice: armed)
            } else if let routeLine, model.route == .run {
                Text(routeLine)
                    .font(.caption)
                    .foregroundStyle(environment.theme.accent2Color)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12)
                    .padding(.top, 8)
                    .accessibilityLabel(routeLine)
            }
            if let savedLine {
                Text(savedLine)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12)
                    .padding(.top, 8)
                    .accessibilityAddTraits(.updatesFrequently)
            } else if let hit = secretHits.first {
                ComposerSecretNotice(
                    kind: hit.kind,
                    onSave: hit.kind.saveKind == nil ? nil : { saveSecret(hit) },
                    onSendWithout: sendWithoutSecrets
                )
            }
            if model.scope.kind != .global, !hidesContextChip {
                HStack {
                    Text("\(model.scope.kind == .work ? "Work" : "Area"): \(model.scope.label ?? "Current context")")
                        .font(.caption)
                        .lineLimit(1)
                        .foregroundStyle(environment.theme.accentColor)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(environment.theme.accentColor.opacity(0.12), in: Capsule())
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 8)
                .padding(.top, 4)
                .accessibilityLabel("Attached \(model.scope.kind == .work ? "Work" : "Area") context: \(model.scope.label ?? "Current context")")
            }
            if !pendingFiles.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(pendingFiles) { file in
                            Button {
                                pendingFiles.removeAll { $0.id == file.id }
                            } label: {
                                Label(file.filename, systemImage: "xmark.circle.fill")
                                    .font(.caption)
                                    .lineLimit(1)
                            }
                            .buttonStyle(.bordered)
                        }
                    }
                    .padding(.horizontal, 8)
                }
            }
            HStack(alignment: .bottom, spacing: 8) {
                Button(action: onAttach) {
                    Image(systemName: "paperclip")
                        .frame(width: 34, height: 34)
                        .contentShape(.rect)
                }
                // Plain everywhere: AppKit's default bordered button painted a
                // grey field behind every glyph in the composer.
                .buttonStyle(.plain)
                .disabled(model.isStreaming || model.isUploading || pendingFiles.count >= 5)
                .accessibilityLabel("Attach files")

                TextField(placeholder, text: $draft, axis: .vertical)
                // Plain style and an explicit flexible width: AppKit's default
                // field hugs its content, which collapsed the whole glass
                // composer to a pill on the Mac.
                .textFieldStyle(.plain)
                .frame(maxWidth: .infinity)
                .lineLimit(1...6)
                .focused(focus)
                .padding(.leading, 16)
                .padding(.trailing, 4)
                .padding(.vertical, 10)
                .onSubmit(submit)
                .onChange(of: draft) { _, next in
                    // The notice first; the route classifier never reads a
                    // secret-shaped value. The draft stays as typed.
                    rescan(next)
                    model.updateDraft(routeText(next))
                }
                .onKeyPress(.tab) {
                    // Tab flips the route even before any text, so a person
                    // can choose Hold first and then write.
                    model.flipRoute()
                    return .handled
                }

                RouteChip(
                    route: model.route,
                    isPinned: model.routePinned,
                    isEnabled: true,
                    onFlip: model.flipRoute
                )

                if model.isStreaming {
                    Button(action: model.stop) {
                        Image(systemName: "stop.fill")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(Color(uiColor: .systemBackground))
                            .frame(width: 34, height: 34)
                            .background(Circle().fill(Color.primary))
                            .contentShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Stop responding")
                } else {
                    Button(action: submit) {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(.white)
                            .frame(width: 34, height: 34)
                            .background(
                                Circle().fill(
                                    canSend ? routeTint : Color.secondary.opacity(0.4)
                                )
                            )
                            .contentShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .disabled(!canSend || sendDisabled)
                    .accessibilityLabel(model.isUploading ? "Uploading" : "Send")
                }
            }
        }
        .padding(4)
        .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 26))
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .padding(.bottom, 8)
        // The notice runs only when Passwords and IDs is on for the user.
        .task { await environment.secureDetails.load(environment.backend, ownerID: environment.sessionStore.ownerID) }
        .sheet(item: $secretEditing) { target in
            SecureItemEditorView(target: target) { item in finishSecretSave(item) }
            #if os(macOS)
            .macFormSheet()
            #endif
        }
    }

    var canSend: Bool {
        (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !pendingFiles.isEmpty)
            && !model.isUploading
    }

    // MARK: - The secret notice

    /// Return and the send control: the draft as it is, or without its
    /// secret-shaped values while the notice shows (decision 14).
    private func submit() {
        guard !sendDisabled else { return }
        if secretHits.isEmpty {
            onSubmit()
        } else {
            sendWithoutSecrets()
        }
    }

    private func rescan(_ text: String) {
        secretHits = environment.secureDetails.isEnabled ? SecureDraftScan.detect(text) : []
    }

    /// The draft as the route classifier may see it: each secret-shaped
    /// value as its marker, the same as the server's redaction.
    private func routeText(_ text: String) -> String {
        guard environment.secureDetails.isEnabled, !secretHits.isEmpty else { return text }
        return SecureDraftScan.redact(text).text
    }

    /// "Send without it": each value becomes its marker, and the draft goes.
    private func sendWithoutSecrets() {
        let redacted = SecureDraftScan.redact(draft)
        draft = redacted.text
        secretHits = []
        onSubmit()
    }

    /// "Save in Passwords and IDs": the value leaves the draft and goes to
    /// the add sheet. A cancel puts the draft back as it was.
    private func saveSecret(_ hit: SecretShapeMatch) {
        guard let kind = hit.kind.saveKind, hit.range.upperBound <= draft.endIndex else { return }
        let value = String(draft[hit.range])
        draftBeforeSave = draft
        draft = SecureDraftScan.removing([hit], from: draft)
        secretHits = []
        switch kind {
        case .idNumber:
            secretEditing = .newID(type: .ssn, number: value)
        case .apiKey:
            secretEditing = .newKey(site: nil, label: nil, key: value)
        case .signIn, .dateOfBirth:
            secretEditing = nil
        }
    }

    private func finishSecretSave(_ item: SecureItemView?) {
        if item == nil {
            if let before = draftBeforeSave { draft = before }
        } else {
            savedLine = ComposerNoticeCopy.savedLine
            savedLineTask?.cancel()
            savedLineTask = Task {
                try? await Task.sleep(for: .seconds(2))
                guard !Task.isCancelled else { return }
                savedLine = nil
            }
        }
        draftBeforeSave = nil
    }

    private var routeTint: Color {
        model.route == .ask ? environment.theme.accentColor : environment.theme.accent2Color
    }
}

/// What the composer says while "Stop and redirect" waits for its note
/// (docs/albatross-threads.md, T8).
struct ComposerArmedNotice {
    let text: String
    let onCancel: () -> Void
}

/// One line above the field with "Cancel" at the trailing edge.
struct ComposerArmedStrip: View {
    @Environment(AppEnvironment.self) private var environment
    let notice: ComposerArmedNotice

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(notice.text)
                .font(.footnote)
                .foregroundStyle(environment.theme.accent2Color)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            Button("Cancel", action: notice.onCancel)
                .buttonStyle(.borderless)
                .font(.footnote.weight(.medium))
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .accessibilityElement(children: .contain)
    }
}

/// The attachments a host reads from the file importer: at most five files,
/// 25 MB together.
enum AssistantComposerFiles {
    static let limit = 5
    static let byteLimit = 25 * 1_024 * 1_024

    static func importing(_ urls: [URL], into pending: inout [ComposeAttachment]) {
        let available = max(0, limit - pending.count)
        for url in urls.prefix(available) {
            let secured = url.startAccessingSecurityScopedResource()
            defer { if secured { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url, options: [.mappedIfSafe]) else { continue }
            let total = pending.reduce(0) { $0 + $1.data.count } + data.count
            guard total <= byteLimit else { continue }
            let values = try? url.resourceValues(forKeys: [.contentTypeKey, .nameKey])
            pending.append(
                ComposeAttachment(
                    filename: values?.name ?? url.lastPathComponent,
                    contentType: values?.contentType?.preferredMIMEType ?? "application/octet-stream",
                    data: data
                )
            )
        }
    }
}
