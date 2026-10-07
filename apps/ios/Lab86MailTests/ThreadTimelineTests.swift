import Foundation
import Testing
@testable import Lab86Mail

// The merged timeline of the Albatross thread (docs/albatross-thread.md, "The
// timeline"), a port of `mergeThreadTimeline`. The same cases as the web.
struct ThreadTimelineTests {
    private struct Message: Equatable {
        let id: String
        let at: Double?
        var started: [String] = []
    }

    private static func run(_ id: String, at: Double, parent: String? = nil) -> ThreadRunView {
        ThreadRunView(run: StepRunView(
            id: id,
            workID: "work_1",
            stepKey: "step-1",
            stepTitle: "Register for the course",
            state: .done,
            createdAt: Date(timeIntervalSince1970: at / 1_000),
            parentRunID: parent
        ))
    }

    private static func merge(_ messages: [Message], _ runs: [ThreadRunView]) -> [ThreadTimeline.Entry<Message>] {
        ThreadTimeline.merge(messages: messages, runs: runs, createdAt: \.at, startedRunIDs: \.started)
    }

    @Test func messagesWithoutATimeComeFirstInTheirOrder() {
        let old1 = Message(id: "a", at: nil)
        let old2 = Message(id: "b", at: nil)
        let fresh = Message(id: "c", at: 3_000)
        let run = Self.run("r1", at: 2_000)
        let items = Self.merge([fresh, old1, old2], [run])
        #expect(items == [
            .message(old1, at: nil),
            .message(old2, at: nil),
            .run(run, continues: false),
            .message(fresh, at: 3_000),
        ])
    }

    @Test func aRunSortsByItsTimeAmongTheMessages() {
        let first = Message(id: "a", at: 1_000)
        let last = Message(id: "c", at: 5_000)
        let run = Self.run("r1", at: 3_000)
        let items = Self.merge([first, last], [run])
        #expect(items == [.message(first, at: 1_000), .run(run, continues: false), .message(last, at: 5_000)])
    }

    @Test func aRunAMessageStartedRendersInsideThatMessage() {
        let message = Message(id: "a", at: 1_000, started: ["r1"])
        let started = Self.run("r1", at: 2_000)
        let other = Self.run("r2", at: 3_000)
        let items = Self.merge([message], [started, other])
        #expect(items == [.message(message, at: 1_000), .run(other, continues: false)])
    }

    @Test func aContinuationKnowsItsParentOnlyWhenTheParentIsListed() {
        let parent = Self.run("r1", at: 1_000)
        let child = Self.run("r2", at: 2_000, parent: "r1")
        let orphan = Self.run("r3", at: 3_000, parent: "r0")
        let items = Self.merge([Message](), [parent, child, orphan])
        #expect(items == [
            .run(parent, continues: false),
            .run(child, continues: true),
            .run(orphan, continues: false),
        ])
    }

    @Test func anEqualTimeKeepsMessagesBeforeRuns() {
        let message = Message(id: "a", at: 2_000)
        let run = Self.run("r1", at: 2_000)
        let items = Self.merge([message], [run])
        #expect(items == [.message(message, at: 2_000), .run(run, continues: false)])
    }

    @Test func aNonFiniteTimeReadsAsNoTime() {
        let message = Message(id: "a", at: .infinity)
        let items = Self.merge([message], [])
        #expect(items == [.message(message, at: nil)])
    }

    @Test func aRunWithoutATimeSortsFirstAmongTheRuns() {
        let dated = Self.run("r1", at: 2_000)
        let undated = ThreadRunView(run: StepRunView(id: "r0", workID: "w", stepKey: "s", stepTitle: "Step", state: .done))
        let items = Self.merge([Message](), [dated, undated])
        #expect(items == [.run(undated, continues: false), .run(dated, continues: false)])
    }
}
