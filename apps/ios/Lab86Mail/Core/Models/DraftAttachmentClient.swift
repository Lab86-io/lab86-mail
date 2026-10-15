import Foundation

// The wire of a draft's attachments (docs/albatross-goal-runs.md, G3; the
// files builder's shapes of 2026-10-15): the `attachments` rows of a draft
// through the tools, the `draftAttachments` field of a send, and the
// refusals a send can answer. One small function for each call, so the
// exact shape lives in one place.

/// Why `POST /api/compose` refused the draft attachments.
enum DraftAttachmentRefusalCode: String, Hashable, Sendable {
    /// A sealed file needs a send permission. Native sends the user to the web.
    case needsAllow = "needs_allow"
    /// The saved file is gone.
    case gone
    /// Saved files are off for this account.
    case off
    /// A file reference the server does not accept.
    case invalid
    /// Over 25 MB, or a sealed file in a scheduled send.
    case tooLarge = "too_large"
    case unknown

    /// The one line under the composer.
    var message: String {
        switch self {
        case .needsAllow: GoalRunCopy.sendNeedsAllow
        case .gone: "One attached file is gone. Remove it and send again."
        case .off: "Saved files are off for this mailbox. Remove the file and send again."
        case .invalid, .unknown: "One attached file could not be sent. Remove it and send again."
        case .tooLarge: "The attachments are over 25 MB. Remove a file and send again."
        }
    }

    /// The composer offers "Open on the web" for a send permission.
    var offersWeb: Bool { self == .needsAllow }
}

/// A refusal from the JSON of a failed compose request that names the draft
/// attachments, or nil for another error.
struct DraftAttachmentRefusal: LocalizedError, Equatable, Sendable {
    let code: DraftAttachmentRefusalCode

    init(code: DraftAttachmentRefusalCode) {
        self.code = code
    }

    init?(status: Int, body: JSONValue?) {
        let raw = body?["code"]?.stringValue
        let error = body?["error"]?.stringValue ?? ""
        switch status {
        case 409:
            guard let raw else { return nil }
            code = DraftAttachmentRefusalCode(rawValue: raw) ?? .unknown
        case 413:
            code = .tooLarge
        case 400:
            if let raw, let known = DraftAttachmentRefusalCode(rawValue: raw) {
                code = known
            } else if error.localizedCaseInsensitiveContains("draft attachment") {
                code = .invalid
            } else if error.localizedCaseInsensitiveContains("sealed") {
                code = .tooLarge
            } else {
                return nil
            }
        default:
            return nil
        }
    }

    var errorDescription: String? { code.message }
}

/// The wire functions. Each one is the only place that writes its shape.
enum DraftAttachmentClient {
    /// `attachments` on `save_draft` and on `update_draft`'s patch: the full
    /// list replaces the rows; `[]` removes them all; nil keeps them.
    static func toolsField(_ attachments: [DraftAttachment]?) -> JSONValue? {
        guard let attachments else { return nil }
        return .array(attachments.prefix(DraftAttachment.limit).map(\.json))
    }

    /// The rows of a `list_drafts` row.
    static func rows(of draft: JSONValue) -> [DraftAttachment] {
        DraftAttachment.list(from: draft["attachments"])
    }

    /// The `draftAttachments` text field of `POST /api/compose`: a JSON array
    /// of `{ fileId, provider, format, name }`. Nil with no rows.
    static func sendField(_ attachments: [DraftAttachment]) -> String? {
        guard !attachments.isEmpty else { return nil }
        let array = JSONValue.array(attachments.prefix(DraftAttachment.limit).map(\.sendJSON))
        guard let data = try? JSONEncoder().encode(array) else { return nil }
        return String(decoding: data, as: UTF8.self)
    }

    /// The bytes of a saved file, for the viewer.
    static func bytesPath(fileID: String) -> String {
        SavedFileLink.bytesPath(fileID: fileID)
    }
}
