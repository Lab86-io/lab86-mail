import AppIntents
import Foundation
import MobileAPI
import Testing
import UniformTypeIdentifiers
@testable import Lab86Mail

struct Lab86MailTests {
    private enum StubSignOutError: Error {
        case failed
    }

    private enum StubMailError: LocalizedError {
        case failed

        var errorDescription: String? { "Provider rejected the action." }
    }

    private enum StubBootstrapError: LocalizedError {
        case offline

        var errorDescription: String? { "The network is offline." }
    }

    @Test
    func onboardingDismissalPersistsPerSignedInOwner() {
        let suite = "Lab86MailTests.onboarding.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = OnboardingDismissalStore(defaults: defaults)

        #expect(!store.contains(ownerID: "user-one"))
        store.insert(ownerID: "user-one")
        #expect(store.contains(ownerID: "user-one"))
        #expect(!store.contains(ownerID: "user-two"))
        #expect(OnboardingDismissalStore(defaults: defaults).contains(ownerID: "user-one"))
    }

    @Test
    func onboardingRecognizesBothBootstrapAndLiveMailboxStatus() {
        #expect(MailboxOnboardingPolicy.hasConnectedMailbox(bootstrapAccountCount: 1))
        #expect(
            MailboxOnboardingPolicy.hasConnectedMailbox(
                statusResponse: .object([
                    "accounts": .array([
                        .object(["accountId": .string("account-one")]),
                    ]),
                ])
            )
        )
        #expect(
            !MailboxOnboardingPolicy.hasConnectedMailbox(
                statusResponse: .object(["accounts": .array([])])
            )
        )
    }

    @Test @MainActor
    func sessionStoreRequiresAnActiveSessionAndTokenBeforeOpeningTheApp() async {
        let store = SessionStore()
        var tokenRequests = 0

        await store.synchronize(
            snapshot: SessionSnapshot(
                isLoaded: true,
                userID: "user-one",
                sessionID: "session-one",
                isActive: false
            )
        ) {
            tokenRequests += 1
            return "must-not-be-requested"
        }

        #expect(store.state == .activating)
        #expect(tokenRequests == 0)

        await store.synchronize(
            snapshot: SessionSnapshot(
                isLoaded: true,
                userID: "user-one",
                sessionID: "session-one",
                isActive: true
            )
        ) {
            tokenRequests += 1
            return "active-session-token"
        }

        #expect(store.state == .ready(ownerID: "user-one"))
        #expect(tokenRequests == 1)
    }

    @Test @MainActor
    func sessionStoreKeepsTheAppClosedWhenTokenValidationFails() async {
        let store = SessionStore()

        await store.synchronize(
            snapshot: SessionSnapshot(
                isLoaded: true,
                userID: "user-one",
                sessionID: "session-one",
                isActive: true
            )
        ) {
            throw SessionAuthenticationError.tokenUnavailable
        }

        #expect(
            store.failureMessage
                == "Albatross could not create an authenticated session. Try again."
        )
        #expect(store.ownerID == nil)
    }

    @Test
    func backendRefusesToSendWithoutAnActiveSessionToken() async throws {
        let backend = BackendClient(
            baseURL: try #require(URL(string: "https://request-must-not-leave.invalid")),
            tokenProvider: { throw SessionAuthenticationError.tokenUnavailable }
        )

        await #expect(throws: SessionAuthenticationError.self) {
            _ = try await backend.post(path: "/api/test", body: .object([:]))
        }
    }

    @Test
    func persistentContainerCreatesItsStoreDirectoryBeforeOpeningSQLite() async throws {
        let fileManager = FileManager.default
        let testRoot = fileManager.temporaryDirectory
            .appending(path: "AlbatrossPersistenceTests-(UUID().uuidString)", directoryHint: .isDirectory)
        let storeURL = testRoot
            .appending(path: "nested", directoryHint: .isDirectory)
            .appending(path: "AlbatrossMobileV1.store")
        defer { try? fileManager.removeItem(at: testRoot) }

        #expect(!fileManager.fileExists(atPath: storeURL.deletingLastPathComponent().path))

        let container = MobilePersistence.makeContainer(storeURL: storeURL)
        let outbox = CommandOutbox(modelContainer: container)
        _ = try await outbox.enqueue(
            ownerID: "user-one",
            command: .taskSetCompleted(
                TaskCompletionCommandPayload(cardID: "card-one", completed: true)
            ),
            idempotencyKey: "persistence-directory"
        )

        #expect(fileManager.fileExists(atPath: storeURL.deletingLastPathComponent().path))
        #expect(fileManager.fileExists(atPath: storeURL.path))
        #expect(try await outbox.commands(ownerID: "user-one").count == 1)
    }

    private actor StubBootstrapSource: MobileBootstrapFetching {
        enum Behavior: Sendable {
            case snapshot(MobileBootstrapSnapshot)
            case offline
        }

        private let behavior: Behavior

        init(_ behavior: Behavior) {
            self.behavior = behavior
        }

        func fetchBootstrap() async throws -> MobileBootstrapSnapshot {
            switch behavior {
            case .snapshot(let snapshot): return snapshot
            case .offline: throw StubBootstrapError.offline
            }
        }
    }

    private actor FailingMailTools: ToolInvoking {
        func invoke(_ name: String, arguments: [String: JSONValue]) async throws -> JSONValue {
            throw StubMailError.failed
        }
    }

    private actor UnauthorizedMailTools: ToolInvoking {
        func invoke(_ name: String, arguments: [String: JSONValue]) async throws -> JSONValue {
            throw BackendError.unauthorized
        }
    }

    private actor ScriptedTools: ToolInvoking {
        private let responses: [String: JSONValue]
        private let failing: Set<String>

        init(responses: [String: JSONValue], failing: Set<String> = []) {
            self.responses = responses
            self.failing = failing
        }

        func invoke(_ name: String, arguments: [String: JSONValue]) async throws -> JSONValue {
            if failing.contains(name) { throw StubMailError.failed }
            return responses[name] ?? .object([:])
        }
    }

    private actor StubCommandSubmitter: MobileCommandSubmitting {
        enum Behavior: Sendable {
            case receipt(OutboxCommandReceipt)
            case failure(MobileV1ClientError)
        }

        private let behavior: Behavior
        private(set) var submissions = 0

        init(_ behavior: Behavior) {
            self.behavior = behavior
        }

        func submit(_ snapshot: PendingCommandSnapshot) async throws -> OutboxCommandReceipt {
            submissions += 1
            switch behavior {
            case .receipt(let receipt): return receipt
            case .failure(let error): throw error
            }
        }
    }

    private actor InvocationCounter {
        private(set) var value = 0

        func increment() {
            value += 1
        }
    }

    @Test
    func cancelsOnlyDevelopmentPasskeySignInCreation() async throws {
        let signInURL = try #require(URL(string: "https://example.clerk.accounts.dev/v1/client/sign_ins"))
        var passkeyRequest = URLRequest(url: signInURL)
        passkeyRequest.httpMethod = "POST"
        passkeyRequest.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        passkeyRequest.httpBody = Data("locale=en_US&strategy=passkey".utf8)

        var identifierRequest = passkeyRequest
        identifierRequest.httpBody = Data("identifier=person%40example.com&strategy=password".utf8)

        var otherEndpointRequest = passkeyRequest
        otherEndpointRequest.url = try #require(URL(string: "https://example.clerk.accounts.dev/v1/client/sign_ups"))

        #expect(ClerkDevelopmentPasskeySafetyMiddleware.shouldCancel(passkeyRequest))
        #expect(!ClerkDevelopmentPasskeySafetyMiddleware.shouldCancel(identifierRequest))
        #expect(!ClerkDevelopmentPasskeySafetyMiddleware.shouldCancel(otherEndpointRequest))
        #expect(ClerkConfiguration.options(for: "pk_test_example").middleware.request.count == 1)
        #expect(ClerkConfiguration.options(for: "pk_live_example").middleware.request.isEmpty)

        await #expect(throws: CancellationError.self) {
            var request = passkeyRequest
            try await ClerkDevelopmentPasskeySafetyMiddleware().prepare(&request)
        }
        try await ClerkDevelopmentPasskeySafetyMiddleware().prepare(&identifierRequest)
    }

    @Test
    func decodesDynamicToolEnvelope() throws {
        let data = Data(#"{"ok":true,"result":{"threads":[{"providerThreadId":"thread-1","accountId":"account-1","subject":"Dinner","unread":true}]}}"#.utf8)
        let value = try JSONDecoder().decode(JSONValue.self, from: data)

        #expect(value["ok"]?.boolValue == true)
        #expect(value["result"]?["threads"]?.arrayValue?.count == 1)
        #expect(value["result"]?["threads"]?.arrayValue?.first?["subject"]?.stringValue == "Dinner")
    }

    @Test @MainActor
    func chatApprovalResumesThePausedToolCallWithARealToolResult() {
        let input: JSONValue = .object([
            "title": .string("Send the reviewed reply"),
            "intent": .string("destructive"),
        ])
        let approval = AssistantInlineApproval(
            id: "approval-1",
            toolCallID: "call-1",
            toolName: "ask_approval",
            input: input,
            usesApprovalResponse: false,
            title: "Send the reviewed reply",
            description: nil,
            metadata: [],
            confirmLabel: "Send it",
            denyLabel: "Cancel",
            destructive: true,
            decision: true
        )

        let part = AssistantChatModel.approvalPartJSON(approval)
        #expect(part["type"]?.stringValue == "dynamic-tool")
        #expect(part["toolCallId"]?.stringValue == "call-1")
        #expect(part["state"]?.stringValue == "output-available")
        #expect(part["output"]?["decision"]?.stringValue == "approved")
        #expect(part["input"]?["title"]?.stringValue == "Send the reviewed reply")
    }

    @Test
    func mapsToolThreadWithoutAssumingProviderShape() throws {
        let data = Data(#"{"providerThreadId":"thread-1","accountId":"account-1","subject":"Project update","from":[{"name":"Ari","email":"ari@example.com"}],"lastDate":1752600000000,"unread":true}"#.utf8)
        let value = try JSONDecoder().decode(JSONValue.self, from: data)
        let thread = MailThreadSummary(json: value)

        #expect(thread?.id == "thread-1")
        #expect(thread?.sender == "Ari")
        #expect(thread?.unread == true)
        #expect(thread?.date != .distantPast)
    }

    @Test
    func mapsCrossAccountCorpusSearchResultToAnOpenableMailboxThread() throws {
        let data = Data(
            #"{"source":"mail","account":"account-2","providerThreadId":"thread-9","subject":"Buried receipt","from":"receipts@example.com","lastDate":1752600000000}"#.utf8
        )
        let value = try JSONDecoder().decode(JSONValue.self, from: data)
        let thread = MailThreadSummary(json: value)

        #expect(thread?.id == "thread-9")
        #expect(thread?.accountID == "account-2")
        #expect(thread?.subject == "Buried receipt")
    }

    @Test
    func mapsRichMailWithoutExposingTrackingNoiseAsThePrimaryBody() throws {
        let tracker = "https://tracking.example/click/" + String(repeating: "a9Z_", count: 40)
        let payload = JSONValue.object([
            "_id": .string("message-1"),
            "from": .string("Ari <ari@example.com>"),
            "to": .string("owner@example.com"),
            "snippet": .string("Project&nbsp;update"),
            "textBody": .string("Open the plan (\(tracker))"),
            "htmlBody": .string("<p>Open the <a href=\"\(tracker)\">plan</a>.</p>"),
            "date": .number(1_752_600_000_000),
        ])

        let message = MailMessage(json: payload, index: 0)

        #expect(message.htmlBody?.contains("Open the") == true)
        #expect(message.snippet == "Project update")
        #expect(message.body == "Open the plan (link)")
    }

    @Test
    func decodesQuotedPrintableAndEncodedMailHeaders() throws {
        let value = try JSONDecoder().decode(
            JSONValue.self,
            from: Data(#"{"providerThreadId":"thread-1","accountId":"account-1","subject":"=?UTF-8?Q?Today=E2=80=99s_update?=","fromAddress":"Ari &amp; Co","snippet":"We=E2=80=99re ready=2E"}"#.utf8)
        )
        let thread = try #require(MailThreadSummary(json: value))

        #expect(thread.subject == "Today’s update")
        #expect(thread.sender == "Ari & Co")
        #expect(thread.snippet == "We’re ready.")
    }

    @Test
    func sandboxesProviderHTMLBeforeWebKitRendersIt() {
        let document = EmailHTMLDocument.make(
            from: #"<html><head><meta http-equiv="refresh" content="0;https://bad.example"></head><body onload="steal()"><script>steal()</script><p>Hello</p></body></html>"#
        )

        #expect(document.contains("Content-Security-Policy"))
        #expect(document.contains("script-src 'none'"))
        #expect(!document.localizedCaseInsensitiveContains("<script"))
        #expect(!document.localizedCaseInsensitiveContains("onload="))
        #expect(!document.localizedCaseInsensitiveContains("http-equiv=\"refresh\""))
        #expect(document.contains("<p>Hello</p>"))
    }

    @Test
    func malformedAndDeepProviderHTMLRemainsBoundedAndSanitized() {
        let depth = 4_000
        let raw = String(repeating: "<div data-note='unterminated", count: depth)
            + "<a href='javascript:steal()' onclick='steal()'>Open</a><p>Readable tail"
            + String(repeating: "</div>", count: depth)
        let document = EmailHTMLDocument.make(from: raw)

        #expect(document.contains("Readable tail"))
        #expect(!document.localizedCaseInsensitiveContains("javascript:"))
        #expect(!document.localizedCaseInsensitiveContains("onclick="))
        #expect(document.count < raw.count * 4)
    }

    @Test
    func artifactLikeHTMLCannotSubmitFormsOrEmbedActiveContent() {
        let document = EmailHTMLDocument.make(
            from: """
            <article><h1>Daily report</h1><form action="https://bad.example">
            <input name="approval"><button formaction="javascript:steal()">Approve</button>
            </form><iframe srcdoc="<script>steal()</script>"></iframe><p>Safe summary</p></article>
            """
        )

        #expect(document.contains("Daily report"))
        #expect(document.contains("Safe summary"))
        #expect(!document.localizedCaseInsensitiveContains("<form"))
        #expect(!document.localizedCaseInsensitiveContains("<input"))
        #expect(!document.localizedCaseInsensitiveContains("<button"))
        #expect(!document.localizedCaseInsensitiveContains("<iframe"))
        #expect(!document.localizedCaseInsensitiveContains("srcdoc"))
    }

    @Test
    func remoteEditorialImagesRenderImmediatelyWhileTrackingBeaconsAreStripped() {
        let html = #"""
        <p>Hello</p>
        <img src="https://cdn.example/hero.jpg" width="600" height="320">
        <img src="https://track.example/o.gif?u=1" width="1" height="1">
        <img src="https://track.example/beacon.png" style="display:none">
        <img src="https://track.example/open?id=9">
        """#
        let document = EmailHTMLDocument.make(from: html)

        // Remote editorial images render immediately — no gate, no explicit choice.
        #expect(document.contains("img-src data: blob: cid: https: http:"))
        #expect(document.contains("no-referrer"))
        #expect(document.contains("hero.jpg"))
        // Obvious beacons are removed: a 1×1 pixel, a hidden image, a known open URL.
        #expect(!document.contains("o.gif"))
        #expect(!document.contains("beacon.png"))
        #expect(!document.contains("/open?id=9"))
        // The message body and alt/plain recovery survive.
        #expect(document.contains("<p>Hello</p>"))
    }

    @Test
    func wideTablesStayReadableWithBoundedHorizontalScrollInsteadOfCrushingColumns() {
        // A GitHub-style status table: several fixed desktop columns, one of them
        // the narrow "Status" header that regressed to one letter per line on a
        // real iPhone when the injected CSS forced every table to viewport width
        // and let cells break at any character.
        let html = #"""
        <table>
          <thead><tr><th>Workflow</th><th>Status</th><th>Duration</th></tr></thead>
          <tbody><tr><td>Deploy production build to Railway</td><td>Success</td><td>4m 12s</td></tr></tbody>
        </table>
        """#
        let document = EmailHTMLDocument.make(from: html)
        // Collapse whitespace so the contract is asserted on declarations, not on
        // the exact indentation of the injected stylesheet.
        let css = document.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)

        // Nothing in the wide table is stripped; the narrow header survives intact.
        #expect(document.contains("<th>Status</th>"))

        // Wide tables are bounded to the viewport and scroll horizontally rather
        // than shrinking columns — this is the readable overflow contract that
        // keeps "Status" on one line.
        #expect(css.contains("table { max-width: 100% !important; display: block; overflow-x: auto;"))

        // Cells keep whole words, so no column is crushed to one character per line.
        #expect(css.contains("th, td { overflow-wrap: normal;"))

        // Ordinary prose still recovers from long unbreakable words at the body level.
        #expect(css.contains("html, body {"))
        #expect(css.contains("overflow-wrap: anywhere;"))
    }

    @Test
    func emailBodyHeightIsBoundedAndScrollsInternallyOnlyAboveTheBudget() {
        // Short content clamps up to the readable minimum, never scrolls.
        let tiny = EmailBodyHeight.resolve(forMeasured: 40)
        #expect(tiny.height == EmailBodyHeight.minimumHeight)
        #expect(!tiny.scrollsInternally)

        // Ordinary content sizes to its measured height without internal scroll —
        // this is what lets late-loading remote images grow the body correctly.
        let ordinary = EmailBodyHeight.resolve(forMeasured: 640)
        #expect(ordinary.height == 640)
        #expect(!ordinary.scrollsInternally)

        // Mail-sized documents stay in the page's outer scroll. Only pathological
        // HTML beyond the 12,000-point WebKit budget becomes internally scrollable.
        let huge = EmailBodyHeight.resolve(forMeasured: 13_000)
        #expect(huge.height == EmailBodyHeight.maximumHeight)
        #expect(huge.height == 12_000)
        #expect(huge.scrollsInternally)
    }

    @Test
    func areaMonogramColorIsDeterministicAcrossLaunchesAndSafeForAnySeed() {
        // A fixed hash means the same id maps to the same palette slot every time,
        // unlike `String.hashValue`, which is seeded per process launch.
        let first = AreaMonogramPalette.index(for: "area-1", count: 8)
        #expect(AreaMonogramPalette.index(for: "area-1", count: 8) == first)
        #expect((0..<8).contains(first))
        // A different id can land on a different colour; the index stays in range.
        #expect((0..<8).contains(AreaMonogramPalette.index(for: "area-2", count: 8)))
        // No seed can trap (the old `abs(Int.min)` hazard) and the index is always
        // a valid palette offset, including the empty-string and empty-palette cases.
        #expect((0..<AreaMonogramPalette.colors.count)
            .contains(AreaMonogramPalette.index(for: "", count: AreaMonogramPalette.colors.count)))
        #expect(AreaMonogramPalette.index(for: "anything", count: 0) == 0)
    }

    @Test
    func senderInitialsHandleNamesQuotedNamesAndBareAddresses() {
        #expect(SenderInitials.make(from: "Ari Example") == "AE")
        #expect(SenderInitials.make(from: "\"Ari Example\"") == "AE")
        #expect(SenderInitials.make(from: "Ari") == "A")
        // A bare address takes its mailbox letter, skipping leading punctuation.
        #expect(SenderInitials.make(from: "ari@example.com") == "A")
        #expect(SenderInitials.make(from: "\"_ari\"@example.com") == "A")
        // Never empty, never a symbol.
        #expect(SenderInitials.make(from: "") == "•")
        #expect(SenderInitials.make(from: "— —") == "•")
    }

    @Test
    func inboxDatelinesBucketTodayYesterdayWeekdayAndMonth() throws {
        let calendar = Calendar.autoupdatingCurrent
        // Anchor mid-week so "yesterday" and "earlier this week" are distinct
        // buckets regardless of the machine's locale week start.
        var anchor = calendar.date(from: DateComponents(year: 2026, month: 7, day: 15, hour: 12))
        anchor = anchor.flatMap { calendar.date(bySettingHour: 12, minute: 0, second: 0, of: $0) }
        let now = try #require(anchor)

        #expect(MailView.datelineLabel(for: now, now: now) == "Today")
        let yesterday = try #require(calendar.date(byAdding: .day, value: -1, to: now))
        #expect(MailView.datelineLabel(for: yesterday, now: now) == "Yesterday")
        // Two days back stays inside the same week: a weekday name, not a date.
        let sameWeek = try #require(calendar.date(byAdding: .day, value: -2, to: now))
        if calendar.isDate(sameWeek, equalTo: now, toGranularity: .weekOfYear) {
            #expect(MailView.datelineLabel(for: sameWeek, now: now)
                == sameWeek.formatted(.dateTime.weekday(.wide)))
        }
        // Same year, earlier month: the month name alone.
        let earlierMonth = try #require(calendar.date(byAdding: .month, value: -2, to: now))
        #expect(MailView.datelineLabel(for: earlierMonth, now: now)
            == earlierMonth.formatted(.dateTime.month(.wide)))
        // A previous year keeps the year for orientation.
        let lastYear = try #require(calendar.date(byAdding: .year, value: -1, to: now))
        #expect(MailView.datelineLabel(for: lastYear, now: now)
            == lastYear.formatted(.dateTime.month(.wide).year()))
    }

    @Test
    func emailLinkPolicyAllowsOnlyExplicitExternalSchemes() throws {
        #expect(EmailLinkPolicy.canOpen(try #require(URL(string: "https://example.com"))))
        #expect(EmailLinkPolicy.canOpen(try #require(URL(string: "mailto:ari@example.com"))))
        #expect(EmailLinkPolicy.canOpen(try #require(URL(string: "tel:+15555550123"))))
        #expect(!EmailLinkPolicy.canOpen(try #require(URL(string: "javascript:alert(1)"))))
        #expect(!EmailLinkPolicy.canOpen(try #require(URL(string: "data:text/html,bad"))))
        #expect(!EmailLinkPolicy.canOpen(try #require(URL(string: "file:///private/message"))))
    }

    @Test
    func decodesTypedDailyReportWithArtifactStatusProgressAndSectionCounts() throws {
        let value = try JSONDecoder().decode(
            JSONValue.self,
            from: Data(#"""
            {"_id":"report-1","kind":"morning","generatedAt":1752600000000,"status":"partial",
             "progress":{"stage":"analyzing","done":3,"total":10},"title":"The Friday Brief",
             "narrative":"Two threads need you.","html":"<main>Brief</main>","artifactStatus":"composing",
             "artifactSource":"ai",
             "sections":{"replyOwed":[{"x":1},{"x":2}],"timeSensitive":[{"x":3}],"tasks":[],
               "calendar":[{"x":4}],"albatross":{"includedAreas":[]}},
             "stats":{"scannedThreads":42,"replyOwed":2,"unread":7,"openTasks":5},
             "errors":["one source failed"]}
            """#.utf8)
        )
        let report = try #require(DailyReportModel(json: value))

        #expect(report.id == "report-1")
        #expect(report.status == .partial)
        #expect(report.isGenerating)
        #expect(report.hasArtifact)
        #expect(report.hasAreaBrief)
        #expect(report.progress?.done == 3)
        #expect(report.sectionCounts.replyOwed == 2)
        #expect(report.sectionCounts.timeSensitive == 1)
        #expect(report.sectionCounts.calendar == 1)
        #expect(report.stats.scannedThreads == 42)
        #expect(report.errors == ["one source failed"])
        #expect(report.legacyText == "Two threads need you.")
    }

    @Test
    func dailyReportSurvivesCacheRoundTripAndOldSnapshotsStillDecode() throws {
        let value = try JSONDecoder().decode(
            JSONValue.self,
            from: Data(#"{"_id":"r","kind":"manual","generatedAt":1752600000000,"title":"Brief","narrative":"Body","html":"<main>x</main>","sections":{},"stats":{}}"#.utf8)
        )
        let report = try #require(DailyReportModel(json: value))
        let snapshot = ProductSnapshot(
            accounts: [], threads: [], events: [], tasks: [], areas: [], approvals: [],
            suggestions: [], dailyBrief: "Body", dailyReport: report, savedAt: Date(timeIntervalSince1970: 1)
        )

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .millisecondsSince1970
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        let restored = try decoder.decode(ProductSnapshot.self, from: encoder.encode(snapshot))
        #expect(restored.dailyReport?.id == "r")
        #expect(restored.dailyReport?.html == "<main>x</main>")

        // A pre-typed snapshot: no `dailyReport`, and events without the new
        // accountID/allDay/calendarID fields — must still decode, not fail the load.
        let legacy = Data(#"{"accounts":[],"threads":[],"events":[{"id":"e1","title":"Old","start":1752600000000,"end":1752603600000}],"tasks":[],"areas":[],"approvals":[],"suggestions":[],"dailyBrief":"Prior","savedAt":1000}"#.utf8)
        let restoredLegacy = try decoder.decode(ProductSnapshot.self, from: legacy)
        #expect(restoredLegacy.dailyReport == nil)
        #expect(restoredLegacy.dailyBrief == "Prior")
        #expect(restoredLegacy.events.first?.accountID == "")
        #expect(restoredLegacy.events.first?.allDay == false)
        #expect(restoredLegacy.events.first?.calendarID == nil)
    }

    @Test
    func calendarEventParsesEveryTimestampShapeAndRejectsInvalidDates() throws {
        func make(_ start: JSONValue, _ end: JSONValue) -> CalendarEventSummary? {
            CalendarEventSummary(json: .object([
                "eventId": .string("e"), "accountId": .string("a"), "calendarId": .string("c"),
                "title": .string("Standup"), "startIso": start, "endIso": end,
            ]))
        }

        // Fractional-seconds ISO — exactly what `new Date(...).toISOString()` emits
        // and what the old parser silently turned into a 1970 event.
        let fractional = try #require(make(.string("2026-07-18T14:30:00.000Z"), .string("2026-07-18T15:00:00.000Z")))
        #expect(fractional.start > Date(timeIntervalSince1970: 1_700_000_000))
        #expect(fractional.accountID == "a")
        #expect(fractional.calendarID == "c")
        // Plain ISO without fractional seconds, and numeric seconds / milliseconds.
        #expect(make(.string("2026-07-18T14:30:00Z"), .string("2026-07-18T15:00:00Z")) != nil)
        #expect(make(.number(1_752_600_000), .number(1_752_603_600)) != nil)
        #expect(make(.number(1_752_600_000_000), .number(1_752_603_600_000)) != nil)
        // Invalid or missing required dates reject the event — never 1970.
        #expect(make(.string("not-a-date"), .string("2026-07-18T15:00:00.000Z")) == nil)
        #expect(make(.null, .string("2026-07-18T15:00:00.000Z")) == nil)
        #expect(make(.number(0), .number(0)) == nil)
        // End before start is rejected.
        #expect(make(.string("2026-07-18T15:00:00.000Z"), .string("2026-07-18T14:00:00.000Z")) == nil)
    }

    @Test
    func decodesAreaHomeIntoTypedSectionsAndCounts() throws {
        let value = try JSONDecoder().decode(
            JSONValue.self,
            from: Data(#"""
            {"area":{"_id":"area-1","name":"Cardhunt job","kind":"job","description":"Day job"},
             "livingBrief":{"status":"ready","lede":"Two things need you.","summary":"Steady week.","generatedAt":1752600000000},
             "facts":{"verified":[{"_id":"f1","kind":"domain","value":"cardhunt.com","status":"verified"}],
                      "candidate":[{"_id":"f2","kind":"person","value":"Alice","status":"candidate"}]},
             "mail":[{"providerThreadId":"t1","accountId":"a1","subject":"Standup","fromAddress":"Alice <alice@cardhunt.com>","lastDate":1752600000000,"snippet":"notes","unread":true,"linkStatus":"verified"}],
             "events":[{"providerEventId":"e1","accountId":"a1","title":"Sync","startAt":1752600000000,"endAt":1752603600000,"allDay":false,"location":"HQ","linkStatus":"candidate"}],
             "tasks":[{"cardId":"c1","title":"Ship","completedAt":null,"dueAt":1752600000000,"linkStatus":"verified"}],
             "work":[{"_id":"w1","title":"Prepare launch review","rawText":"Get launch ready","status":"ready","workState":"active","agentState":"needs_input","updatedAt":1752600000000}],
             "plans":[{"intentId":"i1","title":"Launch review","status":"needs_answers","outcome":"Reviewed"}],
             "projects":[{"projectId":"p1","title":"EOY","outcome":"Ship it","status":"active","taskCount":6,"completedTaskCount":5}],
             "places":[{"name":"HQ","address":"1 St","mapsUrl":"https://maps.apple.com/?q=HQ"}],
             "counts":{"facts":{"verified":1,"candidate":1},"mail":1,"events":1,"tasks":1,"plans":1,"projects":1,"places":1}}
            """#.utf8)
        )
        let detail = AreaDetail(json: value)

        #expect(detail.identity.id == "area-1")
        #expect(detail.identity.name == "Cardhunt job")
        #expect(detail.livingBrief?.isReady == true)
        #expect(detail.livingBrief?.lede == "Two things need you.")
        #expect(detail.verifiedFacts.count == 1)
        #expect(detail.candidateFacts.first?.value == "Alice")
        #expect(detail.mail.first?.threadID == "t1")
        #expect(detail.mail.first?.sender.contains("Alice") == true)
        #expect(detail.events.first?.linkStatus == "candidate")
        // Area events carry no calendar id — detail opens summary-only, honestly.
        #expect(detail.events.first?.summary.calendarID == nil)
        #expect(detail.work?.first?.id == "w1")
        #expect(detail.work?.first?.stateLabel == "Needs you")
        #expect(detail.projects.first?.taskCount == 6)
        #expect(detail.counts.mail == 1)
        #expect(detail.hasAnyLinkedContent)

        let snapshot = ProductSnapshot(
            accounts: [], threads: [], events: [], tasks: [], areas: [], approvals: [], suggestions: [],
            dailyBrief: nil, dailyReport: nil, areaDetails: [detail.identity.id: detail], savedAt: .now
        )
        let restored = try JSONDecoder().decode(ProductSnapshot.self, from: JSONEncoder().encode(snapshot))
        #expect(restored.areaDetails?["area-1"]?.livingBrief?.lede == "Two things need you.")
    }

    @Test @MainActor
    func todayUsesEventIntervalOverlapInsteadOfEndpointDates() {
        let store = ProductStore(tools: ScriptedTools(responses: [:]), backend: BackendClient(baseURL: nil))
        let calendar = Calendar.autoupdatingCurrent
        let today = calendar.startOfDay(for: .now)
        let tomorrow = calendar.date(byAdding: .day, value: 1, to: today)!
        store.events = [
            CalendarEventSummary(
                id: "spans", accountID: "a", calendarID: "c", title: "Conference",
                start: today.addingTimeInterval(-86_400), end: tomorrow.addingTimeInterval(86_400),
                allDay: true, location: nil
            ),
            CalendarEventSummary(
                id: "ended", accountID: "a", calendarID: "c", title: "Yesterday",
                start: today.addingTimeInterval(-3_600), end: today,
                allDay: false, location: nil
            ),
        ]

        #expect(store.todaysEvents.map(\.id) == ["spans"])
    }

    @Test @MainActor
    func typedRoutesRespectTheVisibleHierarchyAndPreserveAreaContext() {
        #expect(PrimaryTab.sourceList == [.today, .tasks, .calendar, .work])
        #expect(!PrimaryTab.sourceList.contains(.mail))
        #expect(PrimaryTab.today.title == "Brief")
        #expect(PrimaryTab.work.title == "Areas")

        let navigation = NavigationModel()
        navigation.openEvent(
            CalendarEventSummary(
                id: "e1", accountID: "a1", calendarID: "c1", title: "Sync",
                start: Date(timeIntervalSince1970: 1_752_600_000),
                end: Date(timeIntervalSince1970: 1_752_603_600),
                allDay: false, location: nil
            )
        )
        #expect(navigation.selectedTab == .calendar)
        #expect(navigation.eventRoute?.eventID == "e1")
        #expect(navigation.eventRoute?.calendarID == "c1")

        navigation.openArea(id: "area-1", name: "Cardhunt job")
        #expect(navigation.selectedTab == .work)
        #expect(navigation.areaRoute?.areaID == "area-1")

        navigation.openThread(accountID: "a1", threadID: "t1", preservingCurrentRoot: true)
        #expect(navigation.selectedTab == .work)
        #expect(navigation.areaRoute?.areaID == "area-1")
        #expect(navigation.threadRoute == ThreadRoute(accountID: "a1", threadID: "t1"))

        navigation.openWork(id: "w1", title: "Prepare launch review")
        #expect(navigation.workRoute?.workID == "w1")
        #expect(navigation.areaRoute?.areaID == "area-1")

        navigation.openPrimaryView("areas")
        #expect(navigation.selectedTab == .work)
        #expect(navigation.areaRoute == nil)
        #expect(!navigation.hasNestedDestination)

        navigation.open(URL(string: "lab86://open/work?workId=w2&areaId=area-2")!)
        #expect(navigation.selectedTab == .work)
        #expect(navigation.areaRoute?.areaID == "area-2")
        #expect(navigation.workRoute?.workID == "w2")
    }

    @Test
    func decodesDurableWorkPlanBriefWithoutSessionState() throws {
        let value = try JSONDecoder().decode(
            JSONValue.self,
            from: Data(#"""
            {"work":{"_id":"w1","title":"Prepare launch review","rawText":"Get launch ready","status":"ready","workState":"active","agentState":"idle","updatedAt":1752600000000},
             "plan":{"_id":"p1","status":"ready","outcome":"A review ready to send","summary":"Evidence assembled.","artifactHtml":"<main><h1>Review</h1></main>","artifactTitle":"Launch brief","assumptions":["Dates are current"],"sourceRefs":[{"kind":"mailThread","id":"t1","label":"Launch thread"}],"digitalActions":[{"key":"draft","kind":"mail_draft","title":"Draft response"}],"physicalActions":[],"appliedSteps":[{"stepKey":"draft","kind":"mail_draft"}]},
             "project":{"_id":"project-1","title":"Launch","status":"active"},
             "questions":[],"application":{"_id":"application-1","status":"applied","operationIds":["operation-1"]}}
            """#.utf8)
        )
        let detail = try #require(WorkDetail(json: value))

        #expect(detail.work.id == "w1")
        #expect(detail.plan?.outcome == "A review ready to send")
        #expect(detail.plan?.artifactHTML?.contains("<h1>Review</h1>") == true)
        #expect(detail.plan?.sources.first?.referenceID == "t1")
        #expect(detail.plan?.appliedStepKeys.contains("draft") == true)
        #expect(detail.project?.title == "Launch")
        #expect(detail.application?.operationIDs == ["operation-1"])
    }

    @Test @MainActor
    func deepLinksOpenTypedEventAndAreaDestinations() {
        let calendarLink = NavigationModel()
        calendarLink.open(route: "lab86://calendar/event?account=a1&id=e1&calendar=c1")
        #expect(calendarLink.selectedTab == .calendar)
        #expect(calendarLink.eventRoute?.eventID == "e1")
        #expect(calendarLink.eventRoute?.calendarID == "c1")

        let areaLink = NavigationModel()
        areaLink.open(route: "lab86://area?id=area-1")
        #expect(areaLink.selectedTab == .work)
        #expect(areaLink.areaRoute?.areaID == "area-1")
    }

    @Test
    func dailyBriefArtifactStripsScriptsInjectsNonceBridgeAndPreservesActionData() {
        let raw = #"""
        <!doctype html><html><head><title>Brief</title></head>
        <body><section onclick="steal()">
        <button data-action="open_thread" data-payload='{"account":"a1","threadId":"t1"}'>Open</button>
        </section><script>window.parent.postMessage('x','*')</script></body></html>
        """#
        let document = BriefArtifactDocument.make(from: raw, nonce: "NONCE123")

        // No model-authored script or handler runs.
        #expect(!document.localizedCaseInsensitiveContains("window.parent.postMessage"))
        #expect(!document.localizedCaseInsensitiveContains("onclick="))
        // Exactly one trusted script — our nonce bridge — is allowed by the CSP.
        #expect(document.contains("Content-Security-Policy"))
        #expect(document.contains("script-src 'nonce-NONCE123'"))
        #expect(document.contains("no-referrer"))
        #expect(document.contains("nonce=\"NONCE123\""))
        #expect(document.contains("webkit.messageHandlers"))
        // Read-only action data survives for native routing.
        #expect(document.contains("data-action=\"open_thread\""))
    }

    @Test
    func briefActionPayloadExtractsTypedRoutingFields() {
        let payload = BriefActionPayload(
            rawMessageBody: [
                "account": "a1", "threadId": "t1", "eventId": "e1",
                "areaId": "area-1", "calendarId": "c1", "view": "calendar",
            ] as [String: Any]
        )
        #expect(payload.account == "a1")
        #expect(payload.threadID == "t1")
        #expect(payload.eventID == "e1")
        #expect(payload.areaID == "area-1")
        #expect(payload.calendarID == "c1")
        #expect(payload.view == "calendar")
    }

    @Test @MainActor
    func calendarRefreshKeepsHealthyEventsAndRecordsDecodeIssuesLocally() async {
        let events = JSONValue.object([
            "events": .array([
                .object([
                    "eventId": .string("e1"), "accountId": .string("a1"), "calendarId": .string("c1"),
                    "title": .string("Real"),
                    "startIso": .string("2026-07-18T14:00:00.000Z"),
                    "endIso": .string("2026-07-18T15:00:00.000Z"), "allDay": .bool(false),
                ]),
                .object([
                    "eventId": .string("bad"), "title": .string("Broken"),
                    "startIso": .string("nope"), "endIso": .string("also-nope"),
                ]),
            ]),
        ])
        let store = ProductStore(
            tools: ScriptedTools(responses: ["calendar_list_events": events]),
            backend: BackendClient(baseURL: nil)
        )

        await store.refreshCalendar()

        #expect(store.events.count == 1)
        #expect(store.events.first?.id == "e1")
        #expect(store.calendarDidLoad)
        // A rejected row records a calendar-local decode note — never global.
        #expect(store.calendarError != nil)
        #expect(store.errorMessage == nil)
    }

    @Test @MainActor
    func areaDetailLoadsByStableIdCachesAndSurfacesUnavailable() async throws {
        let home = JSONValue.object([
            "home": .object([
                "area": .object(["_id": .string("area-1"), "name": .string("Job"), "kind": .string("job")]),
                "facts": .object(["verified": .array([]), "candidate": .array([])]),
                "mail": .array([]), "events": .array([]), "tasks": .array([]),
                "plans": .array([]), "projects": .array([]), "places": .array([]),
                "counts": .object([
                    "facts": .object(["verified": .number(0), "candidate": .number(0)]),
                    "mail": .number(0), "events": .number(0), "tasks": .number(0),
                    "plans": .number(0), "projects": .number(0), "places": .number(0),
                ]),
            ]),
        ])
        let store = ProductStore(
            tools: ScriptedTools(responses: ["area_home": home]),
            backend: BackendClient(baseURL: nil)
        )

        let detail = try await store.loadAreaDetail("area-1")
        #expect(detail.identity.id == "area-1")
        #expect(store.cachedAreaDetail("area-1")?.identity.name == "Job")

        // A missing home (archived/removed area) is unavailable, never empty data.
        let emptyStore = ProductStore(
            tools: ScriptedTools(responses: [:]),
            backend: BackendClient(baseURL: nil)
        )
        await #expect(throws: Error.self) {
            _ = try await emptyStore.loadAreaDetail("gone")
        }
    }

    @Test @MainActor
    func workDetailLoadsByStableIdAndCachesTheRenderedBrief() async throws {
        let response = JSONValue.object([
            "detail": .object([
                "work": .object([
                    "_id": .string("work-1"), "title": .string("Launch review"),
                    "rawText": .string("Prepare launch review"), "status": .string("ready"),
                    "workState": .string("active"), "agentState": .string("idle"),
                ]),
                "plan": .object([
                    "_id": .string("plan-1"), "status": .string("ready"),
                    "outcome": .string("A launch review ready to send"),
                    "artifactHtml": .string("<main>Brief</main>"),
                    "assumptions": .array([]), "sourceRefs": .array([]),
                    "digitalActions": .array([]), "physicalActions": .array([]),
                ]),
                "questions": .array([]),
            ]),
        ])
        let store = ProductStore(
            tools: ScriptedTools(responses: ["work_home": response]),
            backend: BackendClient(baseURL: nil)
        )

        let detail = try await store.loadWorkDetail("work-1")
        #expect(detail.plan?.artifactHTML == "<main>Brief</main>")
        #expect(store.cachedWorkDetail("work-1")?.work.title == "Launch review")
    }

    @Test @MainActor
    func workRefreshFailureKeepsCachedAreasReadableWithoutGlobalFailure() async throws {
        let cached = try #require(
            AreaSummary(
                json: .object([
                    "_id": .string("area-1"), "name": .string("Cardhunt job"), "kind": .string("job"),
                ])
            )
        )
        let store = ProductStore(
            tools: ScriptedTools(responses: [:], failing: ["area_list"]),
            backend: BackendClient(baseURL: nil)
        )
        // Last-good areas restored from cache before the first server refresh.
        store.areas = [cached]

        await store.refreshWork()

        // The list stays readable; the failure is recorded only on the Work surface.
        #expect(store.areas == [cached])
        #expect(store.workError == "Provider rejected the action.")
        #expect(!store.isLoadingWork)
        // One Work failure must not blank Mail or raise the app-wide alert.
        #expect(store.errorMessage == nil)
        #expect(store.mailErrorMessage == nil)
    }

    @Test @MainActor
    func workRefreshSuccessLoadsAreasClearsErrorAndMarksLoaded() async {
        let areas = JSONValue.object([
            "areas": .array([
                .object(["_id": .string("area-1"), "name": .string("Cardhunt job"), "kind": .string("job")]),
                .object(["_id": .string("area-2"), "name": .string("Home"), "kind": .string("area")]),
            ]),
        ])
        let store = ProductStore(
            tools: ScriptedTools(responses: ["area_list": areas]),
            backend: BackendClient(baseURL: nil)
        )
        store.workError = "stale failure"

        await store.refreshWork()

        #expect(store.areas.map(\.id) == ["area-1", "area-2"])
        #expect(store.workDidLoad)
        #expect(store.workError == nil)
        #expect(!store.isLoadingWork)
        #expect(store.errorMessage == nil)
    }

    @Test @MainActor
    func signOutClearsWorkLoadingErrorAndLoadedState() async {
        let store = ProductStore(
            tools: ScriptedTools(responses: [:]),
            backend: BackendClient(baseURL: nil)
        )
        store.workError = "Provider rejected the action."
        store.isLoadingWork = true
        store.workDidLoad = true

        await store.clearForSignOut()

        #expect(store.workError == nil)
        #expect(!store.isLoadingWork)
        #expect(!store.workDidLoad)
        #expect(store.areas.isEmpty)
    }

    @Test @MainActor
    func failedOptimisticArchiveRestoresInboxAndSearchWithoutGlobalFailure() async throws {
        let value = try JSONDecoder().decode(
            JSONValue.self,
            from: Data(#"{"providerThreadId":"thread-1","accountId":"account-1","subject":"Keep me","fromAddress":"ari@example.com","snippet":"Important","lastDate":1752600000000}"#.utf8)
        )
        let thread = try #require(MailThreadSummary(json: value))
        let store = ProductStore(
            tools: FailingMailTools(),
            backend: BackendClient(baseURL: nil)
        )
        store.threads = [thread]
        store.searchedThreads = [thread]

        await store.archive(thread)

        #expect(store.threads == [thread])
        #expect(store.searchedThreads == [thread])
        #expect(store.mailErrorMessage == "Provider rejected the action.")
        #expect(store.errorMessage == nil)
    }

    @Test @MainActor
    func rejectedSessionUsesOnlyTheAppWideErrorPresenter() async {
        let store = ProductStore(
            tools: UnauthorizedMailTools(),
            backend: BackendClient(baseURL: nil)
        )

        await store.refreshMail()

        #expect(store.errorMessage == "Sign in again to continue.")
        #expect(store.mailErrorMessage == nil)
    }

    @Test
    func decodesLiveConvexMailIntoTheSameNativeModels() throws {
        let payload = try JSONDecoder().decode(
            LiveMailThreadsPayload.self,
            from: Data(#"{"items":[{"account":"account-1","_id":"thread-1","subject":"Live &amp; current","fromAddress":"Ari","lastDate":1752600000000,"snippet":"Updated","unread":true,"starred":false,"smartCategory":{"primary":"needs_reply"}}]}"#.utf8)
        )
        let summary = try #require(payload.items.first?.summary)

        #expect(summary.accountID == "account-1")
        #expect(summary.subject == "Live & current")
        #expect(summary.unread)
        #expect(summary.category == "needs_reply")
        #expect(summary.date != .distantPast)
    }

    @Test
    func mapsMailAttachmentsFromHydratedThreads() throws {
        let value = try JSONDecoder().decode(
            JSONValue.self,
            from: Data(#"{"threadId":"thread-1","subject":"Files","messages":[{"_id":"message-1","from":"ari@example.com","to":"owner@example.com","date":1752600000000,"snippet":"See attached","textBody":"See attached","htmlBody":"<p>See attached</p>","attachments":[{"attachmentId":"attachment-1","filename":"brief.pdf","mimeType":"application/pdf","size":2048}]}]}"#.utf8)
        )
        let detail = MailThreadDetail(json: value)
        let attachment = try #require(detail.messages.first?.attachments.first)

        #expect(attachment.id == "attachment-1")
        #expect(attachment.filename == "brief.pdf")
        #expect(attachment.size == 2048)
    }

    @Test
    func spotlightMailIsPrivateRoutableAndExcludesMessageContent() throws {
        let accountValue = try JSONDecoder().decode(
            JSONValue.self,
            from: Data(#"{"accountId":"account-1","email":"owner@example.com","provider":"google"}"#.utf8)
        )
        let threadValue = try JSONDecoder().decode(
            JSONValue.self,
            from: Data(#"{"providerThreadId":"thread-1","accountId":"account-1","subject":"Project review","from":"ari@example.com","snippet":"MESSAGE BODY MUST NOT BE INDEXED","lastDate":1752600000000}"#.utf8)
        )
        let account = try #require(AccountSummary(json: accountValue))
        let thread = try #require(MailThreadSummary(json: threadValue))
        let record = try #require(
            MailSpotlightRecord(owner: "clerk-user-secret", account: account, thread: thread)
        )

        #expect(record.domainIdentifier.hasPrefix("io.lab86.mail.user."))
        #expect(!record.domainIdentifier.contains("clerk-user-secret"))
        #expect(record.contentDescription == "ari@example.com · owner@example.com")
        #expect(!record.contentDescription.contains("MESSAGE BODY"))
        #expect(
            MailSpotlightRecord.threadRoute(fromUniqueIdentifier: record.uniqueIdentifier)
                == ThreadRoute(accountID: "account-1", threadID: "thread-1")
        )
    }

    @Test @MainActor
    func signOutRecoversAnErrantLocalSessionEvenWhenNetworkCleanupFails() async throws {
        var events: [String] = []
        let coordinator = SignOutCoordinator(
            revokePush: {
                events.append("revoke-push")
                throw StubSignOutError.failed
            },
            unregisterPushLocally: { events.append("unregister-push") },
            clearProductState: { events.append("clear-product") },
            signOutAuthentication: {
                events.append("sign-out-auth")
                throw StubSignOutError.failed
            },
            recoverLocalAuthentication: { events.append("recover-auth") }
        )

        let result = try await coordinator.run()

        #expect(result.pushRevocationFailed)
        #expect(result.recoveredLocalAuthentication)
        #expect(events == [
            "revoke-push",
            "unregister-push",
            "clear-product",
            "sign-out-auth",
            "recover-auth",
        ])
    }

    @Test
    func mapsDurableCheckinCandidatesWithoutAssumingWebViewState() throws {
        let data = Data(
            #"{"_id":"checkin-1","localDate":"2026-07-15","status":"open","candidateItems":[{"kind":"work","id":"work-1","title":"Ship native mail"}]}"#.utf8
        )
        let value = try JSONDecoder().decode(JSONValue.self, from: data)
        let checkin = CheckinSummary(json: value)

        #expect(checkin?.id == "checkin-1")
        #expect(checkin?.candidates.first?.id == "work:work-1")
        #expect(checkin?.candidates.first?.title == "Ship native mail")
    }

    @Test @MainActor
    func routesNotificationToThread() {
        let navigation = NavigationModel()
        navigation.open(route: "lab86://mail/thread?account=acct&id=thr")

        #expect(navigation.selectedTab == .mail)
        #expect(navigation.threadRoute == ThreadRoute(accountID: "acct", threadID: "thr"))
    }

    @Test @MainActor
    func routesCheckInNotificationToActivity() {
        let navigation = NavigationModel()
        navigation.open(route: "/checkin?id=checkin-1")

        guard case .activity = navigation.sheet else {
            Issue.record("Expected the check-in notification to open Activity")
            return
        }
    }

    @Test @MainActor
    func mailtoLinksPrefillTheNativeComposer() throws {
        let navigation = NavigationModel()
        let url = try #require(URL(string: "mailto:ari@example.com?subject=Project%20Review&cc=copy@example.com&body=Notes"))

        navigation.open(url)

        #expect(navigation.pendingCompose?.recipient == "ari@example.com")
        #expect(navigation.pendingCompose?.cc == "copy@example.com")
        #expect(navigation.pendingCompose?.subject == "Project Review")
        #expect(navigation.pendingCompose?.body == "Notes")
        guard case .compose = navigation.sheet else {
            Issue.record("Expected mailto to open the native composer")
            return
        }
    }

    @Test @MainActor
    func consumesSiriMailSearchAndComposeRequests() {
        let suite = "Lab86MailTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set("quarterly review", forKey: "pendingAlbatrossMailSearch")
        defaults.set("ari@example.com", forKey: "pendingAlbatrossComposeRecipient")
        defaults.set("copy@example.com", forKey: "pendingAlbatrossComposeCC")
        defaults.set("blind@example.com", forKey: "pendingAlbatrossComposeBCC")
        defaults.set("Review", forKey: "pendingAlbatrossComposeSubject")
        defaults.set("Here are the notes.", forKey: "pendingAlbatrossComposeBody")
        defaults.set("attachment-key", forKey: "pendingAlbatrossComposeAttachmentsKey")
        defaults.set("draft-1", forKey: "pendingAlbatrossComposeDraftID")
        let navigation = NavigationModel()

        navigation.consumeAppIntentRequests(defaults: defaults)

        #expect(navigation.selectedTab == .mail)
        #expect(navigation.pendingMailSearch == "quarterly review")
        #expect(navigation.pendingCompose?.recipient == "ari@example.com")
        #expect(navigation.pendingCompose?.cc == "copy@example.com")
        #expect(navigation.pendingCompose?.bcc == "blind@example.com")
        #expect(navigation.pendingCompose?.mode == "new")
        #expect(navigation.pendingCompose?.attachmentsKey == "attachment-key")
        #expect(navigation.pendingCompose?.draftID == "draft-1")
        guard case .compose = navigation.sheet else {
            Issue.record("Expected Siri compose to open the composer")
            return
        }
        #expect(defaults.string(forKey: "pendingAlbatrossMailSearch") == nil)
    }

    @Test
    func productCacheIsEncryptedAtRestAndIsolatedByOwner() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        let cache = ProductCache(directory: directory)
        let snapshot = ProductSnapshot(
            accounts: [],
            threads: [],
            events: [],
            tasks: [],
            areas: [],
            approvals: [],
            suggestions: [],
            dailyBrief: "Private brief",
            savedAt: Date(timeIntervalSince1970: 100)
        )

        try await cache.save(snapshot, owner: "user-one")
        #expect(try await cache.load(owner: "user-one")?.dailyBrief == "Private brief")
        #expect(try await cache.load(owner: "user-two") == nil)
        try await cache.remove(owner: "user-one")
        #expect(try await cache.load(owner: "user-one") == nil)
    }

    @Test
    func mailEntityReferencesRoundTripProviderIdentifiers() throws {
        let original = MailEntityReference(
            kind: .message,
            accountID: "account/with+symbols@example.com",
            threadID: "thread:123/456",
            messageID: "message+789"
        )

        let decoded = MailEntityReference(identifier: original.identifier)

        #expect(decoded == original)
    }

    @Test
    func siriDraftAttachmentsAreProtectedAndRestored() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        let store = MailIntentAttachmentStore(directory: directory)
        let original = IntentFile(
            data: Data("attachment body".utf8),
            filename: "notes.txt",
            type: .plainText
        )

        try await store.save([original], draftID: "draft-1")
        let restored = try await store.load(draftID: "draft-1")

        #expect(restored.count == 1)
        #expect(restored.first?.filename == "notes.txt")
        #expect(restored.first?.data == Data("attachment body".utf8))
        try await store.remove(draftID: "draft-1")
        #expect(try await store.load(draftID: "draft-1").isEmpty)
    }

    @Test
    func composeAttachmentsRoundTripForUndoSendRestoration() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        let store = MailIntentAttachmentStore(directory: directory)
        let attachments = [
            ComposeAttachment(
                filename: "plan.md",
                contentType: "text/markdown",
                data: Data("# Plan".utf8)
            ),
            ComposeAttachment(
                filename: "evidence.bin",
                contentType: "application/octet-stream",
                data: Data([0, 1, 2, 255])
            ),
        ]

        try await store.saveComposeAttachments(attachments, draftID: "pending-send-1")
        let restored = try await store.loadComposeAttachments(draftID: "pending-send-1")

        #expect(restored.map(\.filename) == ["plan.md", "evidence.bin"])
        #expect(restored.map(\.contentType) == ["text/markdown", "application/octet-stream"])
        #expect(restored.map(\.data) == attachments.map(\.data))
    }

    @Test @MainActor
    func pendingSendStateSurvivesNavigationAndProcessRecreation() {
        let suite = "PendingSendTests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let backend = BackendClient(baseURL: nil)
        let tools = ToolClient(backend: backend)
        let snapshot = ComposeDraftSnapshot(
            recipient: "reader@example.com",
            cc: "copy@example.com",
            bcc: "",
            subject: "Durable draft",
            body: "Exact body",
            mode: "new",
            accountID: "account-1",
            threadID: nil,
            messageID: nil,
            replyAll: false,
            attachmentsKey: "attachment-key",
            draftID: "draft-1"
        )
        let receipt = PendingSendReceipt(
            id: "user-1:nylas-schedule:receipt",
            fireAt: Date.now.addingTimeInterval(30),
            undoSeconds: 30,
            accountID: "account-1",
            threadID: nil
        )

        let first = PendingSendCoordinator(backend: backend, tools: tools, defaults: defaults)
        first.register(receipt: receipt, ownerID: "user-1", snapshot: snapshot)
        let restored = PendingSendCoordinator(backend: backend, tools: tools, defaults: defaults)

        #expect(restored.records.count == 1)
        #expect(restored.records.first?.snapshot.composePrefill.recipient == "reader@example.com")
        #expect(restored.records.first?.snapshot.attachmentsKey == "attachment-key")
        #expect(restored.records.first?.fireAt == receipt.fireAt)
    }

    @Test
    func commandOutboxIsIdempotentDurableAndOwnerIsolated() async throws {
        let container = MobilePersistence.makeContainer(inMemory: true)
        let outbox = CommandOutbox(modelContainer: container)
        let command = DurableMobileCommand.taskSetCompleted(
            TaskCompletionCommandPayload(cardID: "card-1", completed: true)
        )

        let first = try await outbox.enqueue(
            ownerID: "user-one",
            command: command,
            idempotencyKey: "command-1",
            baseRevision: 3
        )
        let duplicate = try await outbox.enqueue(
            ownerID: "user-one",
            command: command,
            idempotencyKey: "command-1",
            baseRevision: 3
        )
        _ = try await outbox.enqueue(
            ownerID: "user-two",
            command: command,
            idempotencyKey: "command-1"
        )

        #expect(first == duplicate)
        #expect(try await outbox.pending(ownerID: "user-one").count == 1)
        #expect(try await outbox.pending(ownerID: "user-two").count == 1)

        do {
            _ = try await outbox.enqueue(
                ownerID: "user-one",
                command: .taskSetCompleted(
                    TaskCompletionCommandPayload(cardID: "card-2", completed: false)
                ),
                idempotencyKey: "command-1"
            )
            Issue.record("Expected idempotency-key reuse to be rejected")
        } catch let error as CommandOutboxError {
            #expect(error == .idempotencyKeyReused)
        }

        try await outbox.purge(ownerID: "user-one")
        #expect(try await outbox.pending(ownerID: "user-one").isEmpty)
        #expect(try await outbox.pending(ownerID: "user-two").count == 1)
    }

    @Test
    func commandReceiptsAndSyncCursorsNeverReportUnconfirmedWorkAsApplied() async throws {
        let container = MobilePersistence.makeContainer(inMemory: true)
        let outbox = CommandOutbox(modelContainer: container)
        _ = try await outbox.enqueue(
            ownerID: "user-one",
            command: .mailArchive(MailThreadCommandTarget(accountID: "account-1", threadID: "thread-1")),
            idempotencyKey: "archive-1"
        )

        try await outbox.markSubmitting(ownerID: "user-one", idempotencyKey: "archive-1")
        try await outbox.apply(
            ownerID: "user-one",
            idempotencyKey: "archive-1",
            receipt: OutboxCommandReceipt(
                commandID: "server-command-1",
                status: .needsApproval,
                entityRevision: 7,
                operationID: nil,
                approvalID: "approval-1",
                undoExpiresAt: nil,
                errorCode: nil,
                errorMessage: nil,
                retryable: false
            )
        )
        #expect(try await outbox.pending(ownerID: "user-one").isEmpty)

        try await outbox.saveCursor(ownerID: "user-one", domain: "mail", cursor: "7", serverRevision: 7)
        try await outbox.saveCursor(ownerID: "user-one", domain: "mail", cursor: "4", serverRevision: 4)
        let cursor = try await outbox.cursor(ownerID: "user-one", domain: "mail")
        #expect(cursor?.cursor == "7")
        #expect(cursor?.serverRevision == 7)
    }

    @Test
    func outboxProcessorPersistsOnlyConfirmedServerReceiptAsApplied() async throws {
        let container = MobilePersistence.makeContainer(inMemory: true)
        let outbox = CommandOutbox(modelContainer: container)
        _ = try await outbox.enqueue(
            ownerID: "user-one",
            command: .taskSetCompleted(
                TaskCompletionCommandPayload(cardID: "card-1", completed: true)
            ),
            idempotencyKey: "complete-1"
        )
        let submitter = StubCommandSubmitter(
            .receipt(
                OutboxCommandReceipt(
                    commandID: "server-command-1",
                    status: .applied,
                    entityRevision: 8,
                    operationID: "operation-1",
                    approvalID: nil,
                    undoExpiresAt: nil,
                    errorCode: nil,
                    errorMessage: nil,
                    retryable: false
                )
            )
        )

        let result = await CommandOutboxProcessor(outbox: outbox, submitter: submitter)
            .drain(ownerID: "user-one")
        let saved = try #require(try await outbox.commands(ownerID: "user-one").first)

        #expect(result == OutboxDrainResult(attempted: 1, applied: 1))
        #expect(saved.status == .applied)
        #expect(saved.serverCommandID == "server-command-1")
        #expect(saved.attemptCount == 1)
        #expect(try await outbox.pending(ownerID: "user-one").isEmpty)
        #expect(await submitter.submissions == 1)
    }

    @Test
    func queuedServerReceiptRemainsPendingWithoutPretendingToBeApplied() async throws {
        let container = MobilePersistence.makeContainer(inMemory: true)
        let outbox = CommandOutbox(modelContainer: container)
        _ = try await outbox.enqueue(
            ownerID: "user-one",
            command: .mailArchive(
                MailThreadCommandTarget(accountID: "account-1", threadID: "thread-1")
            ),
            idempotencyKey: "archive-queued"
        )
        let submitter = StubCommandSubmitter(
            .receipt(
                OutboxCommandReceipt(
                    commandID: "server-command-queued",
                    status: .queued,
                    entityRevision: nil,
                    operationID: nil,
                    approvalID: nil,
                    undoExpiresAt: nil,
                    errorCode: nil,
                    errorMessage: nil,
                    retryable: false
                )
            )
        )

        let result = await CommandOutboxProcessor(outbox: outbox, submitter: submitter)
            .drain(ownerID: "user-one")
        let saved = try #require(try await outbox.commands(ownerID: "user-one").first)

        #expect(result == OutboxDrainResult(attempted: 1, deferred: 1))
        #expect(saved.status == .queued)
        #expect(saved.nextAttemptAt != nil)
        #expect(try await outbox.pending(ownerID: "user-one", now: .distantFuture).count == 1)
    }

    @Test
    func retryableTransportFailureIsDeferredAndRemainsInspectable() async throws {
        let container = MobilePersistence.makeContainer(inMemory: true)
        let outbox = CommandOutbox(modelContainer: container)
        _ = try await outbox.enqueue(
            ownerID: "user-one",
            command: .workCapture(
                WorkCaptureCommandPayload(
                    rawText: "Prepare the release",
                    transcript: nil,
                    source: .text,
                    areaID: nil
                )
            ),
            idempotencyKey: "capture-retry"
        )
        let submitter = StubCommandSubmitter(
            .failure(
                .server(
                    status: 503,
                    code: "PROVIDER_UNAVAILABLE",
                    message: "Try again shortly.",
                    retryable: true
                )
            )
        )

        let result = await CommandOutboxProcessor(outbox: outbox, submitter: submitter)
            .drain(ownerID: "user-one")
        let saved = try #require(try await outbox.commands(ownerID: "user-one").first)

        #expect(result == OutboxDrainResult(attempted: 1, deferred: 1))
        #expect(saved.status == .failed)
        #expect(saved.lastErrorCode == "PROVIDER_UNAVAILABLE")
        #expect(saved.lastErrorRetryable)
        #expect(saved.nextAttemptAt != nil)
        #expect(try await outbox.pending(ownerID: "user-one", now: .distantFuture).count == 1)
    }

    @Test
    func permanentCommandFailureWaitsForExplicitUserRetry() async throws {
        let container = MobilePersistence.makeContainer(inMemory: true)
        let outbox = CommandOutbox(modelContainer: container)
        _ = try await outbox.enqueue(
            ownerID: "user-one",
            command: .approvalReject(
                ApprovalRejectCommandPayload(approvalID: "approval-1", reason: nil)
            ),
            idempotencyKey: "reject-failed"
        )
        let submitter = StubCommandSubmitter(
            .failure(
                .server(
                    status: 400,
                    code: "APPROVAL_RESOLVED",
                    message: "This approval was already resolved.",
                    retryable: false
                )
            )
        )

        let result = await CommandOutboxProcessor(outbox: outbox, submitter: submitter)
            .drain(ownerID: "user-one")
        let saved = try #require(try await outbox.commands(ownerID: "user-one").first)

        #expect(result == OutboxDrainResult(attempted: 1, permanentlyFailed: 1))
        #expect(saved.status == .failed)
        #expect(!saved.lastErrorRetryable)
        #expect(saved.nextAttemptAt == nil)
        #expect(try await outbox.pending(ownerID: "user-one", now: .distantFuture).isEmpty)

        try await outbox.retry(ownerID: "user-one", idempotencyKey: "reject-failed")
        #expect(try await outbox.pending(ownerID: "user-one").count == 1)
    }

    @Test
    func typedRouteRequestsAreDurableOrderedAndOwnerIsolated() async throws {
        let container = MobilePersistence.makeContainer(inMemory: true)
        let store = CommandOutbox(modelContainer: container)
        let thread = AppRoute.mailThread(accountID: "account-1", threadID: "thread-1")

        try await store.enqueueRoute(ownerID: "user-one", route: thread, source: "push")
        try await store.enqueueRoute(ownerID: "user-two", route: .today, source: "siri")

        #expect(try await store.consumeRoute(ownerID: "user-one") == thread)
        #expect(try await store.consumeRoute(ownerID: "user-one") == nil)
        #expect(try await store.consumeRoute(ownerID: "user-two") == .today)
    }

    @Test
    func accountRepositoryCachesTypedBootstrapWithoutSkippingUnsnapshottedDomains() async throws {
        let container = MobilePersistence.makeContainer(inMemory: true)
        let cache = AccountCache(modelContainer: container)
        let cursorStore = CommandOutbox(modelContainer: container)
        let snapshot = Self.bootstrapSnapshot(ownerID: "user-one", accountID: "account-1", cursor: "12")
        let repository = AccountRepository(
            cache: cache,
            cursorStore: cursorStore,
            remote: StubBootstrapSource(.snapshot(snapshot))
        )

        let refreshed = try await repository.refresh(ownerID: "user-one")

        #expect(refreshed == snapshot)
        #expect(try await repository.cachedAccounts(ownerID: "user-one") == snapshot.accounts)
        #expect(try await repository.cachedAccounts(ownerID: "user-two").isEmpty)
        let accountCursor = try await cursorStore.cursor(
            ownerID: "user-one",
            domain: MobileDomain.accounts.rawValue
        )
        #expect(accountCursor?.cursor == "12")
        #expect(accountCursor?.serverRevision == 12)
        for domain in MobileDomain.allCases where domain != .accounts {
            #expect(
                try await cursorStore.cursor(ownerID: "user-one", domain: domain.rawValue) == nil
            )
        }
    }

    @Test
    func accountRepositoryRejectsCrossUserBootstrapBeforeWritingCache() async throws {
        let container = MobilePersistence.makeContainer(inMemory: true)
        let cache = AccountCache(modelContainer: container)
        let repository = AccountRepository(
            cache: cache,
            cursorStore: CommandOutbox(modelContainer: container),
            remote: StubBootstrapSource(
                .snapshot(Self.bootstrapSnapshot(ownerID: "user-two", accountID: "account-2"))
            )
        )

        await #expect(throws: AccountRepositoryError.self) {
            try await repository.refresh(ownerID: "user-one")
        }
        #expect(try await repository.cachedAccounts(ownerID: "user-one").isEmpty)
        #expect(try await repository.cachedAccounts(ownerID: "user-two").isEmpty)
    }

    @Test
    func generatedSyncEnvelopeMapsToTypedDomainChangesAndRejectsDomainDrift() throws {
        let envelope = try JSONDecoder().decode(
            Components.Schemas.SyncEnvelope.self,
            from: Data(
                #"{"items":[{"domain":"tasks","entityKind":"task","entityID":"card-1","revision":2,"operation":"upsert","payload":{"cardID":"card-1","completed":true}}],"deletedIDs":[],"cursor":"2","serverRevision":2,"hasMore":false}"#.utf8
            )
        )

        let page = try MobileV1Client.syncPage(from: envelope, requestedDomain: .tasks)
        #expect(page.domain == .tasks)
        #expect(page.cursor == "2")
        #expect(page.serverRevision == 2)
        #expect(page.changes == [
            .task(
                TaskSyncPatch(
                    entityID: "card-1",
                    revision: 2,
                    cardID: "card-1",
                    title: nil,
                    completed: true
                )
            ),
        ])

        #expect(throws: MobileV1ClientError.invalidSyncPayload) {
            try MobileV1Client.syncPage(from: envelope, requestedDomain: .calendar)
        }
    }

    @Test @MainActor
    func accountStoreKeepsUsefulCachedStateWhenRefreshIsOffline() async throws {
        let container = MobilePersistence.makeContainer(inMemory: true)
        let cache = AccountCache(modelContainer: container)
        let cached = Self.bootstrapSnapshot(ownerID: "user-one", accountID: "cached-account")
        try await cache.replace(ownerID: "user-one", accounts: cached.accounts)
        let store = AccountStore(
            repository: AccountRepository(
                cache: cache,
                cursorStore: CommandOutbox(modelContainer: container),
                remote: StubBootstrapSource(.offline)
            )
        )

        let succeeded = await store.load(ownerID: "user-one")

        #expect(!succeeded)
        #expect(store.state == .ready)
        #expect(store.accounts == cached.accounts)
        #expect(store.isUsingCachedData)
        #expect(store.errorMessage == "The network is offline.")
    }

    @Test
    func syncCoordinatorCoalescesConcurrentWorkForOneUserAndDomain() async {
        let coordinator = SyncCoordinator()
        let counter = InvocationCounter()

        async let first = coordinator.run(ownerID: "user-one", domain: "accounts") {
            await counter.increment()
            try? await Task.sleep(for: .milliseconds(100))
            return true
        }
        async let second = coordinator.run(ownerID: "user-one", domain: "accounts") {
            await counter.increment()
            try? await Task.sleep(for: .milliseconds(100))
            return true
        }

        let results = await (first, second)

        #expect(results.0)
        #expect(results.1)
        #expect(await counter.value == 1)
        #expect(await coordinator.activeTaskCount(ownerID: "user-one") == 0)
    }

    private static func bootstrapSnapshot(
        ownerID: String,
        accountID: String,
        cursor: String = "0"
    ) -> MobileBootstrapSnapshot {
        MobileBootstrapSnapshot(
            user: MobileBootstrapUser(
                id: ownerID,
                email: "owner@example.com",
                name: "Owner",
                imageURL: nil
            ),
            accounts: [
                MobileAccount(
                    id: accountID,
                    email: "owner@example.com",
                    provider: .google,
                    status: .connected,
                    displayName: "Work",
                    scopes: ["mail.read"],
                    capabilities: ProviderCapabilities(
                        mail: true,
                        calendar: true,
                        contacts: true,
                        folders: true,
                        labels: true,
                        drafts: true,
                        scheduledSend: true,
                        push: true,
                        search: true,
                        unsupportedReason: nil
                    ),
                    sync: MobileAccountSyncState(
                        status: .ready,
                        corpusReady: true,
                        itemsSynced: 42,
                        lastSyncedAt: Date(timeIntervalSince1970: 100),
                        error: nil
                    )
                ),
            ],
            featureFlags: ["mobileContractV1": true],
            notificationSettings: MobileNotificationSettings(
                nativePushEnabled: true,
                newMailPushEnabled: true,
                eventSuggestionPushEnabled: true,
                eveningCheckinEnabled: true
            ),
            cursors: Dictionary(uniqueKeysWithValues: MobileDomain.allCases.map { ($0, cursor) }),
            serverTime: Date(timeIntervalSince1970: 200)
        )
    }
}
