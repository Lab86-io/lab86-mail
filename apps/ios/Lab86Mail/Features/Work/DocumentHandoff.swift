import Foundation

// Document mode in the Albatross thread (docs/albatross-document-handoff.md,
// D5): which editor a run's document opens in, the handoff a document
// belongs to, the words of the mode, and the context attachment the chat
// sends while the document is open. Pure, so the Mac mounts the same rules.
// The web pins them in lib/albatross/document-handoff.ts and
// lib/albatross/step-run-client.ts.

/// Which editor opens a run's document: the Albatross editor or the Word editor.
struct DocumentTarget: Identifiable, Hashable, Sendable {
    enum Provider: String, Hashable, Sendable {
        case albatross, office
    }

    let provider: Provider
    let id: String

    private static let relativeBase = URL(string: "https://app.invalid")!

    /// The document a target names. A link inside the app wins (`?office=`,
    /// `?document=`, or the old `/files/<id>` form); a link on another site
    /// (an absolute URL, or `//host/...`) names nothing, and the bare id
    /// decides. A bare id is an Albatross document. The web rule is
    /// `documentTargetOf`.
    static func of(url raw: String?, id: String?) -> DocumentTarget? {
        if let raw = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty,
           let resolved = URL(string: raw, relativeTo: relativeBase)?.absoluteURL,
           let components = URLComponents(url: resolved, resolvingAgainstBaseURL: false),
           components.scheme == relativeBase.scheme, components.host == relativeBase.host, components.port == nil {
            let items = components.queryItems ?? []
            if let office = items.first(where: { $0.name == "office" })?.value?.nilIfBlank {
                return DocumentTarget(provider: .office, id: office)
            }
            if let document = items.first(where: { $0.name == "document" })?.value?.nilIfBlank {
                return DocumentTarget(provider: .albatross, id: document)
            }
            if let legacy = legacyID(path: components.path) {
                return DocumentTarget(provider: .albatross, id: legacy)
            }
        }
        guard let bare = id?.nilIfBlank else { return nil }
        return DocumentTarget(provider: .albatross, id: bare)
    }

    /// The document a run's button opens. A target with an id and no link
    /// takes the link of the run's own document with that id, so a Word file
    /// opens in the Word editor (runs from before the server filled the link).
    /// The web rule is `resolveDocumentTarget`.
    static func resolve(url raw: String?, id: String?, artifacts: [StepRunView.Artifact]) -> DocumentTarget? {
        if raw?.nilIfBlank == nil, let id = id?.nilIfBlank,
           let link = artifacts.first(where: { $0.kind == .document && $0.referenceID == id && $0.url?.nilIfBlank != nil })?.url {
            return of(url: link, id: id)
        }
        return of(url: raw, id: id)
    }

    /// `/files/<id>`: one segment after `/files/`, nothing else.
    private static func legacyID(path: String) -> String? {
        let prefix = "/files/"
        guard path.hasPrefix(prefix) else { return nil }
        let rest = String(path.dropFirst(prefix.count))
        guard !rest.isEmpty, !rest.contains("/") else { return nil }
        return rest
    }

    /// The web editor of this document, in the native workspace.
    var workspaceDestination: NativeWorkspaceDestination {
        switch provider {
        case .albatross: .document(id)
        case .office: .officeDocument(id)
        }
    }

    var attachment: DocumentContextAttachment {
        DocumentContextAttachment(id: id, provider: provider)
    }
}

/// The words of document mode. The web pins them in `DOCUMENT_HANDOFF_COPY`.
enum DocumentHandoffCopy {
    static let yourPart = "Your part"
    static let done = "Done, continue"
    static let saving = "Saving…"
    static let backToThread = "Back to thread"
    static let close = "Close"
    static let chat = "Chat"
    static let placeholder = "Tell Albatross what to put in the document"
    static let failed = "The step could not be marked done. Try again."
}

/// The context attachment that tells the chat which document is open:
/// `{ kind: 'document', id, provider }` beside the Work attachment.
struct DocumentContextAttachment: Hashable, Sendable {
    let id: String
    let provider: DocumentTarget.Provider

    var json: JSONValue {
        .object([
            "kind": .string("document"),
            "id": .string(id),
            "provider": .string(provider.rawValue),
        ])
    }
}

enum DocumentHandoff {
    /// The open handoff that a document belongs to: the newest `ready_for_you`
    /// or `your_turn` run whose target or artifacts name this document. Nil
    /// when no handoff waits on it (the user opened an older artifact).
    static func run(for runs: [ThreadRunView], target: DocumentTarget) -> ThreadRunView? {
        for view in runs.reversed() {
            let run = view.run
            guard run.state == .handedOff, run.outcome == .readyForYou || run.outcome == .yourTurn else { continue }
            if let next = run.next?.target, next.kind == .document,
               DocumentTarget.resolve(url: next.url, id: next.id, artifacts: run.artifacts)?.id == target.id {
                return view
            }
            let made = run.artifacts.contains { artifact in
                artifact.kind == .document && DocumentTarget.of(url: artifact.url, id: artifact.referenceID)?.id == target.id
            }
            if made { return view }
        }
        return nil
    }

    /// The "Your part" text: the handoff's own words, or nil for no card.
    static func detail(of run: ThreadRunView?) -> String? {
        run?.run.next?.detail?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfBlank
    }

    /// The blanks of the handoff, drawn in the "your part" card and bar
    /// (docs/albatross-blank-design.md). Empty for no handoff.
    static func blanks(of run: ThreadRunView?) -> [String] {
        run?.run.next?.blanks ?? []
    }

    /// True when a chat reply ran a tool that writes a document, so the
    /// editor loads the saved document again.
    static func turnEditedDocument(_ message: AssistantChatMessage) -> Bool {
        message.parts.contains { part in
            guard case .toolRow(let row) = part else { return false }
            return editsDocument(toolName: row.toolName)
        }
    }

    static func editsDocument(toolName: String) -> Bool {
        toolName.hasPrefix("document_") || toolName.hasPrefix("word_document_")
    }
}
