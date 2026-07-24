import Foundation
import Testing
@testable import Lab86Mail

// Stage 3 iOS 0.8 parity: the daily-art payload contract, service footer
// derivation, and masthead geometry bounds.
struct BriefChromeTests {
    // MARK: - DailyBriefArt decoding

    @Test
    func briefArtDecodesImageFallbacksCreditAndSource() throws {
        let art = try #require(DailyBriefArt(json: .object([
            "imageUrl": .string("https://museum.example/hero.jpg"),
            "fallbacks": .array([
                .string("https://museum.example/alt-1.jpg"),
                .string("not a url at all — but URL(string:) is permissive; blank tests below"),
                .string(""),
                .string("https://mail.example/art/fallback-1.jpg"),
            ]),
            "credit": .string("Wheat Field with Cypresses, Vincent van Gogh, 1889"),
            "source": .string("The Met"),
        ])))
        #expect(art.imageURL.absoluteString == "https://museum.example/hero.jpg")
        // Blank strings are dropped; the ordered walk starts at the hero.
        #expect(art.orderedURLs.first == art.imageURL)
        #expect(art.fallbackURLs.contains(URL(string: "https://mail.example/art/fallback-1.jpg")!))
        #expect(!art.fallbackURLs.contains(where: { $0.absoluteString.isEmpty }))
        #expect(art.credit == "Wheat Field with Cypresses, Vincent van Gogh, 1889")
        #expect(art.source == "The Met")
    }

    @Test
    func briefArtIsNilWhenAbsentOrBlank() {
        #expect(DailyBriefArt(json: nil) == nil)
        #expect(DailyBriefArt(json: .object([:])) == nil)
        #expect(DailyBriefArt(json: .object(["imageUrl": .string("   ")])) == nil)
    }

    @Test
    func dailyReportDecodesArtAndServicesAndSurvivesTheirAbsence() throws {
        let withExtras = try #require(DailyReportModel(json: .object([
            "_id": .string("report-1"),
            "generatedAt": .number(1_753_300_000_000),
            "title": .string("Thursday Brief"),
            "art": .object([
                "imageUrl": .string("https://museum.example/hero.jpg"),
                "fallbacks": .array([.string("https://museum.example/alt.jpg")]),
                "credit": .string("Credit"),
                "source": .string("Source"),
            ]),
            "services": .array([.string("gmail"), .string("github"), .string("")]),
        ])))
        #expect(withExtras.art?.imageURL.absoluteString == "https://museum.example/hero.jpg")
        #expect(withExtras.serviceIDs == ["gmail", "github"])

        // Older payloads / cached snapshots without the new fields still decode.
        let withoutExtras = try #require(DailyReportModel(json: .object([
            "_id": .string("report-0"),
            "generatedAt": .number(1_753_300_000_000),
            "title": .string("Old Edition"),
        ])))
        #expect(withoutExtras.art == nil)
        #expect(withoutExtras.serviceIDs.isEmpty)

        // And a cache round-trip of the extended model keeps the art.
        let data = try JSONEncoder().encode(withExtras)
        let decoded = try JSONDecoder().decode(DailyReportModel.self, from: data)
        #expect(decoded.art == withExtras.art)
        #expect(decoded.serviceIDs == withExtras.serviceIDs)
    }

    // MARK: - Service footer derivation

    private func counts(calendar: Int = 0, tasks: Int = 0) -> DailyReportModel.SectionCounts {
        DailyReportModel.SectionCounts(
            replyOwed: 0, followUpOwed: 0, newPeople: 0, timeSensitive: 0,
            tracked: 0, fyi: 0, tasks: tasks, calendar: calendar
        )
    }

    @Test
    func footerServicesMirrorDesktopDerivation() {
        // Payload services first, calendar/tasks appended only when their
        // sections have content, deduplicated, defaulting to Mail.
        let full = DailyBriefServices.derive(
            serviceIDs: ["gmail", "github", "gmail"],
            sectionCounts: counts(calendar: 3, tasks: 2)
        )
        #expect(full.map(\.id) == ["gmail", "github", "calendar", "tasks"])
        #expect(full.map(\.label) == ["Gmail", "GitHub", "Calendar", "Tasks"])

        let quiet = DailyBriefServices.derive(serviceIDs: [], sectionCounts: counts())
        #expect(quiet.map(\.id) == ["mail"])

        let noCalendar = DailyBriefServices.derive(serviceIDs: ["gmail"], sectionCounts: counts(tasks: 1))
        #expect(noCalendar.map(\.id) == ["gmail", "tasks"])
    }

    @Test
    func footerSentenceJoinsNaturally() {
        func marks(_ ids: [String]) -> [DailyBriefServiceMark] {
            DailyBriefServices.derive(serviceIDs: ids, sectionCounts: counts())
        }
        #expect(DailyBriefServices.sentence(marks(["gmail"])) == "Gmail")
        #expect(DailyBriefServices.sentence(marks(["gmail", "icloud"])) == "Gmail and iCloud")
        #expect(DailyBriefServices.sentence(marks(["gmail", "icloud", "github"])) == "Gmail, iCloud, and GitHub")
    }

    // MARK: - Masthead geometry

    @Test
    func mastheadHeightStaysInsideTheAllowedBand() {
        #expect(DailyBriefMasthead.height(forWidth: 0) == 280)
        #expect(DailyBriefMasthead.height(forWidth: 320) == 220)
        #expect(DailyBriefMasthead.height(forWidth: 402) == max(220, min(360, 402 * 0.62)))
        #expect(DailyBriefMasthead.height(forWidth: 1_024) == 360)
    }

    // MARK: - Document status precedence

    @Test
    func documentStatusPrefersComposingThenSavedDetailsThenNothing() {
        #expect(BriefDocumentStatus.make(isComposing: true, hydrationFailed: false) == .composing)
        #expect(BriefDocumentStatus.make(isComposing: true, hydrationFailed: true) == .composing)
        #expect(BriefDocumentStatus.make(isComposing: false, hydrationFailed: true) == .savedDetails)
        #expect(BriefDocumentStatus.make(isComposing: false, hydrationFailed: false) == nil)
    }

    // MARK: - Nav-title crossfade and regenerate state

    @Test
    func mastheadCrossfadeFiresExactlyPastTheThreshold() {
        let width: CGFloat = 402
        let threshold = DailyBriefMasthead.height(forWidth: width) - 56
        #expect(!TodayView.mastheadScrolledPast(offset: 0, containerWidth: width))
        #expect(!TodayView.mastheadScrolledPast(offset: threshold, containerWidth: width))
        #expect(TodayView.mastheadScrolledPast(offset: threshold + 1, containerWidth: width))
    }

    @Test
    func nativeDocumentPredicateGatesMastheadAndBodyTogether() throws {
        let v2 = try #require(DailyReportModel(json: .object([
            "_id": .string("r1"),
            "generatedAt": .number(1_753_300_000_000),
            "artifactSource": .string("document-v2"),
            "document": .object([
                "version": .number(2),
                "title": .string("Thursday Brief"),
                "summary": .string("Quiet."),
                "generatedAt": .number(1_753_300_000_000),
                "regions": .array([]),
            ]),
        ])))
        #expect(TodayView.rendersNativeDocument(v2))

        let legacy = try #require(DailyReportModel(json: .object([
            "_id": .string("r2"),
            "generatedAt": .number(1_753_300_000_000),
            "html": .string("<main>edition</main>"),
        ])))
        #expect(!TodayView.rendersNativeDocument(legacy))
    }

    @Test
    func regenerateIsBusyWhileLocallyInFlightOrServerStillGenerating() throws {
        #expect(TodayView.regenerateInFlight(isRegenerating: true, report: nil))
        #expect(!TodayView.regenerateInFlight(isRegenerating: false, report: nil))
        let partial = try #require(DailyReportModel(json: .object([
            "_id": .string("r3"),
            "generatedAt": .number(1_753_300_000_000),
            "status": .string("partial"),
        ])))
        #expect(TodayView.regenerateInFlight(isRegenerating: false, report: partial))
        let ready = try #require(DailyReportModel(json: .object([
            "_id": .string("r4"),
            "generatedAt": .number(1_753_300_000_000),
            "status": .string("ready"),
        ])))
        #expect(!TodayView.regenerateInFlight(isRegenerating: false, report: ready))
    }

    // MARK: - Shared image fallback walk

    @Test
    func imageSourceWalkAdvancesInOrderAndTerminates() {
        let sources = [URL(string: "https://a.example/1.jpg")!, URL(string: "https://a.example/2.jpg")!]
        var walk = ImageSourceWalk()
        #expect(walk.current(in: sources) == sources[0])
        walk.advance(in: sources)
        #expect(walk.current(in: sources) == sources[1])
        walk.advance(in: sources)
        #expect(walk.current(in: sources) == nil)
        // Advancing past the end stays terminal instead of trapping/looping.
        walk.advance(in: sources)
        #expect(walk.current(in: sources) == nil)
        #expect(ImageSourceWalk().current(in: []) == nil)
    }

    @Test
    func imageSourceWalkRestartsWhenTheSourceListChanges() {
        let dead = [URL(string: "https://a.example/dead.jpg")!]
        let fresh = [URL(string: "https://a.example/new-hero.jpg")!, URL(string: "https://a.example/alt.jpg")!]
        var walk = ImageSourceWalk()
        walk.advance(in: dead)
        #expect(walk.current(in: dead) == nil)
        // Same sources → terminal state is preserved (no retry loop) …
        walk.resetIfSourcesChanged(from: dead, to: dead)
        #expect(walk.current(in: dead) == nil)
        // … but replaced sources restart the walk at the new first URL.
        walk.resetIfSourcesChanged(from: dead, to: fresh)
        #expect(walk.current(in: fresh) == fresh[0])
    }
}
