import Foundation
import SwiftUI

// Pure helpers behind the composer: the tool strip layout and the web path
// of a draft.

/// The tool strip under the message. At accessibility text sizes the strip
/// stacks its two groups, so "Attach" and "Send now" never wrap one letter
/// to a line and the strip's glass never becomes a circle (D1).
enum ComposeToolStripLayout: Equatable {
    case inline
    case stacked

    static func resolve(dynamicTypeSize: DynamicTypeSize) -> ComposeToolStripLayout {
        dynamicTypeSize.isAccessibilitySize ? .stacked : .inline
    }
}

/// The web app opens a saved draft at `/?view=mail&account=<id>&draft=<id>`
/// (lib/albatross/goal-runs.ts, runOpenPath). Without a saved draft there is
/// nothing to open, so the link is not offered.
enum ComposeWebLink {
    static func draftURL(base: URL?, accountID: String, draftID: String?) -> URL? {
        guard let base,
              let draftID = draftID?.nilIfBlank,
              var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return nil }
        components.path = "/"
        components.fragment = nil
        var items = [URLQueryItem(name: "view", value: "mail")]
        if let account = accountID.nilIfBlank {
            items.append(URLQueryItem(name: "account", value: account))
        }
        items.append(URLQueryItem(name: "draft", value: draftID))
        components.queryItems = items
        return components.url
    }
}

/// The words of the delivery control. The full line names the date with the
/// year and the time; the short line drops the year for a narrow strip.
enum ComposeDeliveryLabel {
    static func full(
        sendsLater: Bool,
        date: Date,
        locale: Locale = .autoupdatingCurrent,
        calendar: Calendar = .autoupdatingCurrent
    ) -> String {
        guard sendsLater else { return "Send now" }
        let style = Date.FormatStyle(date: .abbreviated, time: .shortened, locale: locale, calendar: calendar, timeZone: calendar.timeZone)
        return "Sends \(date.formatted(style))"
    }

    static func short(
        sendsLater: Bool,
        date: Date,
        locale: Locale = .autoupdatingCurrent,
        calendar: Calendar = .autoupdatingCurrent
    ) -> String {
        guard sendsLater else { return "Send now" }
        let style = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
            .month(.abbreviated).day().hour().minute()
        return "Sends \(date.formatted(style))"
    }
}

/// Draft saves run one at a time. Each save waits for the save before it,
/// so an older save never writes after a newer one, and the id that the
/// first save of a new draft gets reaches the next save.
@MainActor
final class SerialSaveChain {
    private var last: Task<Bool, Never>?

    /// Puts the save at the end of the chain and returns its task.
    @discardableResult
    func enqueue(_ work: @escaping @MainActor () async -> Bool) -> Task<Bool, Never> {
        let previous = last
        let task = Task { @MainActor in
            _ = await previous?.value
            return await work()
        }
        last = task
        return task
    }

    func run(_ work: @escaping @MainActor () async -> Bool) async -> Bool {
        await enqueue(work).value
    }

    /// Waits until the last save in the chain ends.
    func settle() async {
        _ = await last?.value
    }
}
