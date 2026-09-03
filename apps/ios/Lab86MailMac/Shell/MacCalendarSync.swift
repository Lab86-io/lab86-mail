import SwiftUI

// Calendar sync feedback on the Mac. The 2 pt line under the toolbar is the
// shared `CalendarSyncLine`. This file owns the caption at the trailing end
// of the calendar header: "Calendar is current." for 3 s after a sync,
// "Synced 40 s ago." for 2 s when ⌘R found the calendar fresh, and "Sync
// did not finish. Try again." until the next kick after a failure.

enum MacCalendarSyncCaption: Equatable, Sendable {
    case none
    case current
    case fresh(secondsAgo: Int)
    case failed

    static let currentCopy = "Calendar is current."
    static let failedCopy = "Sync did not finish. Try again."

    var text: String? {
        switch self {
        case .none: nil
        case .current: Self.currentCopy
        case .fresh(let seconds): "Synced \(seconds) s ago."
        case .failed: Self.failedCopy
        }
    }

    // How long the caption stays. Nil means until the next kick.
    var hold: Duration? {
        switch self {
        case .none, .failed: nil
        case .current: .seconds(3)
        case .fresh: .seconds(2)
        }
    }

    // What ⌘R shows once the store settles. A completion token that moved
    // means a sync ran. A failed phase means it did not finish. Otherwise
    // the server found the calendar fresh and started nothing.
    static func afterManualKick(
        phase: CalendarSyncPhase,
        tokenBefore: Int,
        tokenAfter: Int,
        lastSyncedAt: Date?,
        now: Date = .now
    ) -> MacCalendarSyncCaption {
        if phase == .failed { return .failed }
        if tokenAfter != tokenBefore { return .current }
        guard let lastSyncedAt else { return .none }
        return .fresh(secondsAgo: max(0, Int(now.timeIntervalSince(lastSyncedAt).rounded())))
    }

    // What a phase change from a passive kick shows.
    static func afterPhaseChange(_ phase: CalendarSyncPhase) -> MacCalendarSyncCaption? {
        switch phase {
        case .done: .current
        case .failed: .failed
        case .idle, .running: nil
        }
    }

    // The tooltip: "Last sync 09:41".
    static func help(lastSyncedAt: Date?, calendar: Calendar = .current) -> String? {
        guard let lastSyncedAt else { return nil }
        var style = Date.FormatStyle(calendar: calendar, timeZone: calendar.timeZone).hour().minute()
        style.locale = calendar.locale ?? .current
        return "Last sync \(lastSyncedAt.formatted(style))"
    }
}

// Owns the caption and its clock. The calendar surface feeds it phase
// changes and ⌘R kicks.
@MainActor
@Observable
final class MacCalendarSyncCaptionModel {
    private(set) var caption: MacCalendarSyncCaption = .none
    private var clearTask: Task<Void, Never>?

    func show(_ caption: MacCalendarSyncCaption) {
        clearTask?.cancel()
        clearTask = nil
        self.caption = caption
        guard let hold = caption.hold else { return }
        clearTask = Task { [weak self] in
            try? await Task.sleep(for: hold)
            guard !Task.isCancelled else { return }
            self?.caption = .none
        }
    }

    func phaseChanged(_ phase: CalendarSyncPhase) {
        // A running sync clears a stale failure line. The line draws in its
        // place.
        if phase == .running, caption == .failed {
            show(.none)
            return
        }
        if let next = MacCalendarSyncCaption.afterPhaseChange(phase) {
            show(next)
        }
    }

    // ⌘R. The store awaits the full follow loop, so the answer is known
    // when the call returns.
    func manualKick(store: ProductStore) async {
        let before = store.calendarSync.completionToken
        show(.none)
        await store.resyncCalendar(reason: .manualHTTP)
        let result = MacCalendarSyncCaption.afterManualKick(
            phase: store.calendarSync.phase,
            tokenBefore: before,
            tokenAfter: store.calendarSync.completionToken,
            lastSyncedAt: store.calendarSync.lastSyncedAt
        )
        show(result)
    }
}

struct MacCalendarSyncCaptionView: View {
    @Environment(AppEnvironment.self) private var environment
    let model: MacCalendarSyncCaptionModel
    let onRetry: () -> Void

    var body: some View {
        if let text = model.caption.text {
            Button(action: onRetry) {
                Text(text)
                    .font(.caption)
                    .foregroundStyle(model.caption == .failed ? environment.theme.accent2Color : Color.secondary)
                    .lineLimit(1)
            }
            .buttonStyle(.plain)
            .help(MacCalendarSyncCaption.help(lastSyncedAt: environment.store.calendarSync.lastSyncedAt) ?? text)
            .transition(.opacity)
            .accessibilityLabel(text)
            .accessibilityHint("Syncs the calendar now")
        }
    }
}
