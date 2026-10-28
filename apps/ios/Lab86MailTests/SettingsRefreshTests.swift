import Foundation
import Testing
@testable import Lab86Mail

// The pure rules the Settings, Files, and Area pages gained in the iOS
// refresh round (docs/research/ios-refresh-design-2026-10-24.md).

struct ShortcutReferenceTests {
    @Test("The numbered shortcuts come from the menu's source, in sidebar order")
    func numberedRowsFollowTheMenu() {
        let rows = ShortcutReference.rows(showsFiles: true)
        let numbered = rows.filter { $0.keys.count == 2 && $0.keys.last?.isNumber == true }
        #expect(numbered.map(\.keys) == ["⌘1", "⌘2", "⌘3", "⌘4", "⌘5"])
        #expect(numbered.map(\.action) == ["Today", "Mail", "Albatrosses", "Calendar", "Files"])
    }

    @Test("Files leaves the list with its switch")
    func filesFollowsItsSwitch() {
        let rows = ShortcutReference.rows(showsFiles: false)
        #expect(!rows.contains { $0.keys == "⌘5" })
        #expect(!rows.contains { $0.action == "Files" })
        #expect(rows.contains { $0.keys == "⌘4" && $0.action == "Calendar" })
    }

    @Test("Every row has its own keys")
    func rowsAreUnique() {
        let rows = ShortcutReference.rows(showsFiles: true)
        #expect(Set(rows.map(\.id)).count == rows.count)
        #expect(rows.first?.keys == "⌘N")
    }
}

struct SmartCategoryChoiceTests {
    @Test("The categories are the server's list, in its order")
    func matchesTheServer() {
        // SMART_CATEGORY_IDS in lib/mail/smart-categories.ts.
        #expect(SmartCategoryChoice.allCases.map(\.rawValue) == [
            "main", "needs_reply", "codes", "orders", "finance_admin", "noise", "review",
        ])
        #expect(!SmartCategoryChoice.allCases.map(\.rawValue).contains("action"))
    }

    @Test("Names are sentence case")
    func labelsAreSentenceCase() {
        for choice in SmartCategoryChoice.allCases {
            #expect(choice.label != choice.label.uppercased())
            #expect(choice.label.first?.isUppercase == true)
        }
        #expect(SmartCategoryChoice.needsReply.label == "Needs reply")
        #expect(SmartCategoryChoice.financeAdmin.label == "Finance and admin")
    }
}

struct AreaBriefPollingTests {
    @Test("The page polls only while the brief generates")
    func pollsWhileGenerating() {
        #expect(AreaBriefPolling.shouldPoll(status: "generating"))
        #expect(!AreaBriefPolling.shouldPoll(status: "ready"))
        #expect(!AreaBriefPolling.shouldPoll(status: "error"))
        #expect(!AreaBriefPolling.shouldPoll(status: nil))
        #expect(AreaBriefPolling.interval == .seconds(4))
    }
}

struct FilesCloudLoadKeyTests {
    @Test("The key changes when the connections arrive, so the first read runs again")
    func keyIncludesConnections() {
        let before = FilesCloudLoadKey.make(locationID: "all", folderID: nil, query: "", connectionIDs: [])
        let after = FilesCloudLoadKey.make(locationID: "all", folderID: nil, query: "", connectionIDs: ["drive-1"])
        #expect(before != after)
        #expect(before == "all|root||")
        #expect(after == "all|root||drive-1")
    }

    @Test("A folder, a search, and a second drive each make a new key")
    func keyFollowsEveryInput() {
        let root = FilesCloudLoadKey.make(locationID: "drive-1", folderID: nil, query: "", connectionIDs: ["drive-1"])
        let folder = FilesCloudLoadKey.make(locationID: "drive-1", folderID: "f1", query: "", connectionIDs: ["drive-1"])
        let search = FilesCloudLoadKey.make(locationID: "drive-1", folderID: "f1", query: "plan", connectionIDs: ["drive-1"])
        let twoDrives = FilesCloudLoadKey.make(locationID: "drive-1", folderID: "f1", query: "plan", connectionIDs: ["drive-1", "drive-2"])
        #expect(Set([root, folder, search, twoDrives]).count == 4)
    }
}

struct SheetItemBindingTests {
    @Test("While the sheet closes the fields read the presented copy, never nil")
    func fallsBackToThePresentedItem() {
        #expect(SheetItemBinding.current(live: "live", presented: "presented") == "live")
        #expect(SheetItemBinding.current(live: nil, presented: "presented") == "presented")
        #expect(SheetItemBinding.current(live: Optional<Int>.none, presented: 3) == 3)
    }
}

struct ProductReleaseTests {
    private static let releaseJSON: JSONValue = .object([
        "schemaVersion": .number(1),
        "id": .string("0.16.43:2026-10-20-area-pills,2026-10-15-update-flow"),
        "version": .string("0.16.43"),
        "updates": .array([
            .object([
                "id": .string("2026-10-15-update-flow"),
                "publishedAt": .string("2026-10-15"),
                "title": .string("Updates come to you"),
                "summary": .object([
                    "text": .string("Review a new version from a small notice."),
                    "demo": .object(["caption": .string("Try it"), "html": .string("<p>demo</p>")]),
                ]),
                "changes": .array([
                    .object([
                        "id": .string("notice"), "kind": .string("new"),
                        "title": .string("A floating notice"), "description": .string("It waits for you."),
                    ]),
                    .object([
                        "id": .string("bad-kind"), "kind": .string("shiny"),
                        "title": .string("Dropped"), "description": .string("Unknown kind."),
                    ]),
                ]),
            ]),
            .object([
                "id": .string("2026-10-20-area-pills"),
                "publishedAt": .string("2026-10-20"),
                "version": .string("0.16.43"),
                "title": .string("Narrow the list to one Area"),
                "changes": .array([
                    .object([
                        "id": .string("pills"), "kind": .string("improved"),
                        "title": .string("Area pills"), "description": .string("One tap narrows the list."),
                    ]),
                ]),
                "preview": .object([
                    "caption": .string("The pills"), "image": .string("/updates/area-pills.png"),
                    "alt": .string("Area pills above the list"), "width": .number(1200), "height": .number(800),
                ]),
            ]),
        ]),
    ])

    @Test("The release parses, newest notes first, and drops a change of an unknown kind")
    func parsesTheRelease() throws {
        let release = try #require(ProductRelease(json: Self.releaseJSON))
        #expect(release.version == "0.16.43")
        #expect(release.updates.map(\.id) == ["2026-10-20-area-pills", "2026-10-15-update-flow"])
        let flow = release.updates[1]
        #expect(flow.summary == "Review a new version from a small notice.")
        #expect(flow.hasWebDemo)
        #expect(flow.changes.map(\.id) == ["notice"])
        #expect(flow.changes.first?.kind == .new)
        let pills = release.updates[0]
        #expect(pills.screenshot?.imagePath == "/updates/area-pills.png")
        #expect(pills.screenshot?.aspectRatio == 1.5)
        #expect(!pills.hasWebDemo)
    }

    @Test("Another schema version does not parse")
    func rejectsOtherSchemas() {
        let other: JSONValue = .object(["schemaVersion": .number(2), "id": .string("x"), "version": .string("1")])
        #expect(ProductRelease(json: other) == nil)
    }

    @Test("The first release an app sees is silent; a different one is unseen")
    func noticeRules() {
        let first = ProductReleaseNotice.next(seen: nil, fetched: "a")
        #expect(first.seen == "a")
        #expect(!first.unseen)
        let same = ProductReleaseNotice.next(seen: "a", fetched: "a")
        #expect(!same.unseen)
        let changed = ProductReleaseNotice.next(seen: "a", fetched: "b")
        #expect(changed.seen == "a")
        #expect(changed.unseen)
    }

    @Test("Dates read as calendar dates, whatever the zone")
    func dateLabel() {
        #expect(ProductReleaseNotice.dateLabel("2026-10-15") == "October 15, 2026")
        #expect(ProductReleaseNotice.dateLabel("2026-01-01") == "January 1, 2026")
        #expect(ProductReleaseNotice.dateLabel("not a date") == "not a date")
    }

    @Test("Kind words are sentence case")
    func kindWords() {
        #expect(ProductUpdateChange.Kind.new.label == "New")
        #expect(ProductUpdateChange.Kind.improved.label == "Improved")
        #expect(ProductUpdateChange.Kind.fixed.label == "Fixed")
    }
}

@MainActor
struct ProductReleaseStoreTests {
    private func defaults(_ name: String) -> UserDefaults {
        let suite = UserDefaults(suiteName: name)!
        suite.removePersistentDomain(forName: name)
        return suite
    }

    private func release(_ id: String, updates: [String]) -> ProductRelease {
        ProductRelease(
            id: id,
            version: "0.16.43",
            updates: updates.map { update in
                ProductUpdate(
                    id: update,
                    publishedAt: "2026-10-20",
                    title: "Note \(update)",
                    changes: [ProductUpdateChange(id: "c-\(update)", kind: .fixed, title: "Fix", description: "")]
                )
            }
        )
    }

    @Test("A first run records the release in silence; the next release waits to be seen")
    func firstRunThenUpdate() {
        let suite = defaults("product-release-first")
        let store = ProductReleaseStore(defaults: suite)
        store.record(release("a", updates: ["u1"]))
        #expect(!store.hasUnseenRelease)
        #expect(store.newUpdateIDs.isEmpty)

        store.record(release("b", updates: ["u1", "u2"]))
        #expect(store.hasUnseenRelease)
        #expect(store.newUpdateIDs == ["u2"])

        store.markSeen()
        #expect(!store.hasUnseenRelease)
        #expect(store.newUpdateIDs.isEmpty)

        // The memory survives a relaunch.
        let again = ProductReleaseStore(defaults: suite)
        again.record(release("b", updates: ["u1", "u2"]))
        #expect(!again.hasUnseenRelease)
    }
}
