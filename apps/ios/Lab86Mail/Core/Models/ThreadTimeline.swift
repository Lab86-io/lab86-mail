import Foundation

// The merged timeline of the Albatross thread (docs/albatross-thread.md, "The
// timeline"): the chat messages and the runs of one Work, in time order. A
// pure port of `mergeThreadTimeline` in lib/albatross/thread-contract.ts, so
// the web and the native clients order the same items the same way.
//
// Rules:
// - A message's time is `metadata.createdAt` (epoch milliseconds). A message
//   without one sorts before every run and keeps its order.
// - A run sorts by `createdAt`.
// - A run that a message started (an `albatross_handle_step` tool part with
//   that run id) renders inside that message, so it is left out here.
// - A run whose parent is in the list is a continuation.
enum ThreadTimeline {
    enum Entry<Message> {
        case message(Message, at: Double?)
        case run(ThreadRunView, continues: Bool)
    }

    static func merge<Message>(
        messages: [Message],
        runs: [ThreadRunView],
        createdAt: (Message) -> Double?,
        startedRunIDs: (Message) -> [String]
    ) -> [Entry<Message>] {
        var inline: Set<String> = []
        for message in messages {
            for id in startedRunIDs(message) { inline.insert(id) }
        }
        var items: [(entry: Entry<Message>, at: Double?, order: Int)] = []
        for (index, message) in messages.enumerated() {
            let raw = createdAt(message)
            let at: Double? = raw.flatMap { $0.isFinite ? $0 : nil }
            items.append((entry: .message(message, at: at), at: at, order: index))
        }
        let ids = Set(runs.map(\.id))
        for (index, view) in runs.enumerated() where !inline.contains(view.id) {
            let continues = view.run.parentRunID.map { ids.contains($0) } ?? false
            let at = Self.milliseconds(view.run.createdAt)
            items.append((entry: .run(view, continues: continues), at: at, order: messages.count + index))
        }
        items.sort { lhs, rhs in
            switch (lhs.at, rhs.at) {
            case (nil, nil):
                return lhs.order < rhs.order
            case (nil, _):
                return true
            case (_, nil):
                return false
            case (let left?, let right?):
                if left != right { return left < right }
                return lhs.order < rhs.order
            }
        }
        return items.map(\.entry)
    }

    /// A run's time in epoch milliseconds. A run always has one on the wire; a
    /// cached run without it sorts first among the runs.
    static func milliseconds(_ date: Date?) -> Double {
        guard let date else { return 0 }
        return (date.timeIntervalSince1970 * 1_000).rounded()
    }
}

extension ThreadTimeline.Entry: Equatable where Message: Equatable {}
extension ThreadTimeline.Entry: Sendable where Message: Sendable {}
