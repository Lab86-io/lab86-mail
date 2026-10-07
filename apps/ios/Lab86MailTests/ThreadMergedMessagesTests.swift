import Foundation
import Testing
@testable import Lab86Mail

// A Work thread save returns the messages another device wrote
// (`mergedMessages`). The client adds them, so its next save keeps them
// (docs/albatross-thread.md, "The timeline").
@MainActor
struct ThreadMergedMessagesTests {
    private static func message(_ id: String, at: Double?) -> AssistantChatMessage {
        var message = AssistantChatMessage(id: id, role: .user, text: id)
        message.createdAt = at.map { Date(timeIntervalSince1970: $0 / 1_000) }
        return message
    }

    @Test func mergedMessagesGoInPlaceByTime() {
        let current = [Self.message("m1", at: 100), Self.message("d1", at: 310)]
        let merged = [Self.message("phone1", at: 300)]
        let result = AssistantChatModel.addingMergedMessages(merged, to: current)
        #expect(result.map(\.id) == ["m1", "phone1", "d1"])
    }

    @Test func knownIDsAreNotAddedTwice() {
        let current = [Self.message("m1", at: 100)]
        let result = AssistantChatModel.addingMergedMessages([Self.message("m1", at: 100)], to: current)
        #expect(result.map(\.id) == ["m1"])
    }

    @Test func aMessageWithoutATimeKeepsItsPlace() {
        let current = [Self.message("legacy", at: nil), Self.message("a1", at: 400)]
        let merged = [Self.message("b1", at: 500)]
        let result = AssistantChatModel.addingMergedMessages(merged, to: current)
        #expect(result.map(\.id) == ["legacy", "a1", "b1"])
    }
}
