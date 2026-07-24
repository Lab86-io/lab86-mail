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
}
