import SwiftUI

// What a tap on a package row, a source capsule, or a run artifact does in
// the thread (docs/albatross-goal-runs.md, G2 to G4). iOS and the Mac share
// these rules; each screen passes `openContent`, which opens document mode
// the way that screen does (the phone closes a sheet first).

@MainActor
enum ThreadItemOpening {
    typealias OpenContent = (DocumentModeItem.Content, String?) async -> Void

    /// A package row. A document, a sheet, a deck, or a file opens in
    /// document mode. A draft opens in the composer with its files as rows
    /// (G7). The rest opens where its kind opens.
    static func open(
        _ item: HandoffItem,
        in view: ThreadRunView,
        environment: AppEnvironment,
        openURL: OpenURLAction,
        openContent: OpenContent
    ) async {
        switch PackageItemBehaviour.from(item, artifacts: view.run.artifacts) {
        case .openDocument(let target):
            await openContent(.document(target), item.title)
        case .openFile(let fileID, _):
            await openContent(.file(fileID: fileID), item.title)
        case .openDraft(let id, let accountID):
            _ = await StepRunActions.open(.openDraft(id: id, accountID: accountID), environment: environment, openURL: openURL)
        case .openApproval(let id):
            _ = await StepRunActions.open(.openApproval(id: id), environment: environment, openURL: openURL)
        case .openEvent(let accountID, let id):
            environment.navigation.openEvent(
                accountID: accountID,
                eventID: id,
                calendarID: nil,
                preview: nil,
                preservingCurrentRoot: true
            )
        case .openURL(let raw):
            _ = await StepRunActions.open(.openURL(raw), environment: environment, openURL: openURL)
        case .none:
            break
        }
    }

    /// A source capsule. A mail opens its thread, an event its detail, a
    /// document or a file document mode, and a page its link.
    static func open(
        _ source: RunSource,
        environment: AppEnvironment,
        openURL: OpenURLAction,
        openContent: OpenContent
    ) async {
        switch source.kind {
        case .mail:
            if let accountID = source.accountID, let threadID = source.referenceID {
                environment.navigation.openThread(accountID: accountID, threadID: threadID, preservingCurrentRoot: true)
                return
            }
        case .calendar:
            if let accountID = source.accountID, let eventID = source.referenceID {
                environment.navigation.openEvent(
                    accountID: accountID,
                    eventID: eventID,
                    calendarID: nil,
                    preview: nil,
                    preservingCurrentRoot: true
                )
                return
            }
        case .document:
            if let target = DocumentTarget.of(url: source.url, id: source.referenceID) {
                await openContent(.document(target), source.title)
                return
            }
        case .file:
            if let fileID = source.url.flatMap(SavedFileLink.fileID(in:)) ?? source.referenceID {
                await openContent(.file(fileID: fileID), source.title)
                return
            }
        case .web, .jira, .unknown:
            break
        }
        guard let url = source.url else { return }
        _ = await StepRunActions.open(.openURL(url), environment: environment, openURL: openURL)
    }

    /// A run artifact, or a row of the Details "Files" list. A document or a
    /// deck opens in document mode, as does a saved file. The rest opens as
    /// today.
    static func open(
        _ artifact: StepRunView.Artifact,
        environment: AppEnvironment,
        openURL: OpenURLAction,
        openContent: OpenContent
    ) async {
        switch artifact.kind {
        case .document, .deck:
            if let target = DocumentTarget.of(url: artifact.url, id: artifact.referenceID) {
                await openContent(.document(target), artifact.title)
                return
            }
        case .file:
            if let fileID = artifact.url.flatMap(SavedFileLink.fileID(in:)) ?? artifact.referenceID {
                await openContent(.file(fileID: fileID), artifact.title)
                return
            }
        case .draft, .event, .card, .approval, .page, .unknown:
            break
        }
        _ = await StepRunActions.open(artifact, environment: environment, openURL: openURL)
    }
}
