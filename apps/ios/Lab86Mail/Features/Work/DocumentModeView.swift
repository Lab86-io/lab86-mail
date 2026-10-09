#if os(iOS)
import SwiftUI

// Document mode of the Albatross thread on iOS
// (docs/albatross-document-handoff.md, D5, and
// docs/research/document-handoff-ios-design-2026-10-08.md). The web editor
// opens in the native workspace. On the phone it fills the screen, with a
// bar at the bottom for the user's part and "Chat", which opens the same
// thread as a sheet. On the iPad the thread sits in a column on the right,
// with the "your part" card on top. The card and the bar draw the handoff's
// blanks (docs/albatross-blank-design.md). The Mac has its own layout.
struct DocumentModeView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    let route: WorkRoute
    let model: WorkThreadModel
    let target: DocumentTarget

    @State private var showsChat = false

    static let threadColumnWidth: CGFloat = 400

    var body: some View {
        if horizontalSizeClass == .regular {
            split
        } else {
            phone
        }
    }

    /// The web editor. A change of the token loads the saved document again.
    private var editor: some View {
        NativeWorkspaceView(destination: target.workspaceDestination, reloadToken: model.documentReloadToken)
    }

    private var phone: some View {
        editor
            .safeAreaInset(edge: .bottom, spacing: 0) {
                DocumentModeBar(
                    yourPart: model.documentYourPart,
                    blanks: model.documentBlanks,
                    busy: model.isMarkingDone,
                    notice: model.stepNotice,
                    onDone: { Task { await model.finishDocument() } },
                    onChat: { showsChat = true }
                )
            }
            .sheet(isPresented: $showsChat) {
                thread
                    .presentationDetents([.medium, .large])
            }
    }

    private var split: some View {
        HStack(spacing: 0) {
            editor
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            Divider()
            VStack(spacing: 0) {
                if model.documentYourPart != nil || !model.documentBlanks.isEmpty {
                    DocumentYourPartCard(
                        detail: model.documentYourPart,
                        blanks: model.documentBlanks,
                        busy: model.isMarkingDone,
                        notice: model.stepNotice,
                        onDone: { Task { await model.finishDocument() } },
                        onBack: { model.closeDocument() }
                    )
                    Divider()
                }
                thread
            }
            .frame(width: Self.threadColumnWidth)
        }
        .background(environment.theme.paperColor)
    }

    /// The same thread: one model, one conversation, the document attached.
    private var thread: some View {
        NavigationStack {
            WorkThreadView(route: route, showsAttentionBanner: false, presentsDocument: false)
        }
    }
}

/// The bar under the document on the phone: the blank sentence or the
/// handoff's words, then "Done, continue" and "Chat". With no open handoff,
/// "Chat" only.
struct DocumentModeBar: View {
    @Environment(AppEnvironment.self) private var environment
    let yourPart: String?
    var blanks: [String] = []
    var busy = false
    var notice: String? = nil
    let onDone: () -> Void
    let onChat: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if hasYourPart {
                DocumentYourPartText(detail: yourPart, blanks: blanks, size: 17, detailLineLimit: 2)
            }
            if let notice {
                Text(notice)
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
            buttons
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.bar)
        .overlay(alignment: .top) {
            Rectangle().fill(environment.theme.hairlineColor).frame(height: 1)
        }
    }

    private var hasYourPart: Bool { yourPart != nil || !blanks.isEmpty }

    private var buttons: some View {
        HStack(spacing: 10) {
            if hasYourPart {
                Button(busy ? DocumentHandoffCopy.saving : DocumentHandoffCopy.done) { onDone() }
                    .buttonStyle(.borderedProminent)
                    .disabled(busy)
                    .frame(minHeight: 44)
            }
            Button(DocumentHandoffCopy.chat) { onChat() }
                .buttonStyle(.bordered)
                .frame(minHeight: 44)
            Spacer(minLength: 0)
        }
    }
}

/// The card on top of the thread column on the iPad: the blank sentence or
/// the handoff's words, "Done, continue", and the quiet "Back to thread".
struct DocumentYourPartCard: View {
    let detail: String?
    var blanks: [String] = []
    var busy = false
    var notice: String? = nil
    let onDone: () -> Void
    let onBack: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            DocumentYourPartText(detail: detail, blanks: blanks)
            if let notice {
                Text(notice)
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
            HStack(spacing: 12) {
                Button(busy ? DocumentHandoffCopy.saving : DocumentHandoffCopy.done) { onDone() }
                    .buttonStyle(.borderedProminent)
                    .disabled(busy)
                    .frame(minHeight: 44)
                Button(DocumentHandoffCopy.backToThread) { onBack() }
                    .buttonStyle(.borderless)
                    .font(.subheadline)
                    .disabled(busy)
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 16)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The user's part: the blank sentence, then the handoff's words as a quiet
/// line. With no blanks, the handoff's words show in the display font. No
/// label above it: the sentence says what waits for the user.
struct DocumentYourPartText: View {
    let detail: String?
    var blanks: [String] = []
    var size: CGFloat = 19
    /// The bar on the phone keeps the quiet line short.
    var detailLineLimit: Int? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            BlankSentence(blanks: blanks, fallback: detail, size: size)
            if !blanks.isEmpty, let detail = detail?.nilIfBlank {
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(detailLineLimit)
                    .fixedSize(horizontal: false, vertical: detailLineLimit == nil)
            }
        }
        .accessibilityElement(children: .combine)
    }
}
#endif
