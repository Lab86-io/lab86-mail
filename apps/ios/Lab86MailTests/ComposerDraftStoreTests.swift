import Foundation
import Testing
@testable import Lab86Mail

// The composer draft of each thread (docs/albatross-threads.md, T4): kept
// by Work id in memory only, and cleared at sign-out.
@MainActor
struct ComposerDraftStoreTests {
    @Test("A draft is kept by Work id and never goes to UserDefaults")
    func keeps() {
        let store = ComposerDraftStore()
        store.set("My passport number is X1234567", files: [], for: "w-car")
        #expect(store.draft(for: "w-car") == "My passport number is X1234567")
        #expect(store.draft(for: "w-water") == "")
        #expect(store.count == 1)
        #expect(UserDefaults.standard.dictionary(forKey: "albatross.threadDrafts") == nil)
        #expect(ComposerDraftStore().draft(for: "w-car") == "")
    }

    @Test("An empty draft removes the entry; sign-out removes every draft")
    func clears() {
        let store = ComposerDraftStore()
        let file = ComposeAttachment(filename: "bill.pdf", contentType: "application/pdf", data: Data([1, 2, 3]))
        store.set("Pay it", files: [file], for: "w-water")
        #expect(store.files(for: "w-water").map(\.filename) == ["bill.pdf"])
        store.set("   ", files: [], for: "w-water")
        #expect(store.draft(for: "w-water") == "")
        #expect(store.count == 0)
        store.set("Again", files: [file], for: "w-water")
        store.clear(for: "w-water")
        #expect(store.draft(for: "w-water") == "")
        #expect(store.files(for: "w-water").isEmpty)
        store.set("One", files: [file], for: "w-a")
        store.set("Two", files: [], for: "w-b")
        store.removeAll()
        #expect(store.count == 0)
        #expect(store.files(for: "w-a").isEmpty)
    }
}
