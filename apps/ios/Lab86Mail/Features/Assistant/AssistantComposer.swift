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
    let onSubmit: () -> Void
    let onAttach: () -> Void

    var body: some View {
        VStack(spacing: 4) {
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
                .onSubmit(onSubmit)
                .onChange(of: draft) { _, next in model.updateDraft(next) }
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
                    Button(action: onSubmit) {
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
                    .disabled(!canSend)
                    .accessibilityLabel(model.isUploading ? "Uploading" : "Send")
                }
            }
        }
        .padding(4)
        .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 26))
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .padding(.bottom, 8)
    }

    var canSend: Bool {
        (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !pendingFiles.isEmpty)
            && !model.isUploading
    }

    private var routeTint: Color {
        model.route == .ask ? environment.theme.accentColor : environment.theme.accent2Color
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
