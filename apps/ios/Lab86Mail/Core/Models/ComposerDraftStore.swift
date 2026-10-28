import Foundation
import Observation

// The composer draft of each Albatross thread (docs/albatross-threads.md,
// T4): the text and the pending files a person left in a thread when they
// pressed Back. Memory only: a draft can hold a password or an ID number the
// person is about to send, so it never goes to disk, and sign-out clears it.

@MainActor
@Observable
final class ComposerDraftStore {
    private var texts: [String: String] = [:]
    private var files: [String: [ComposeAttachment]] = [:]

    func draft(for workID: String) -> String {
        texts[workID] ?? ""
    }

    func files(for workID: String) -> [ComposeAttachment] {
        files[workID] ?? []
    }

    /// Keeps the draft. An empty draft with no files removes the entry.
    func set(_ text: String, files pending: [ComposeAttachment], for workID: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            texts[workID] = nil
        } else {
            texts[workID] = text
        }
        if pending.isEmpty {
            files[workID] = nil
        } else {
            files[workID] = pending
        }
    }

    /// The draft went out, or the person cleared it.
    func clear(for workID: String) {
        texts[workID] = nil
        files[workID] = nil
    }

    /// A send ended after the person left the thread. What went out leaves
    /// the stored draft; edits made during the upload stay: changed text,
    /// and files added after the send.
    func remove(sent text: String, files sent: [ComposeAttachment], for workID: String) {
        let sentIDs = Set(sent.map(\.id))
        let keptFiles = files(for: workID).filter { !sentIDs.contains($0.id) }
        let storedText = draft(for: workID)
        set(storedText == text ? "" : storedText, files: keptFiles, for: workID)
    }

    /// Sign-out: every draft goes.
    func removeAll() {
        texts = [:]
        files = [:]
    }

    var count: Int { texts.count }
}
