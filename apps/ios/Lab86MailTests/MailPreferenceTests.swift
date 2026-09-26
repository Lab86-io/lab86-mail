import Foundation
import Testing
@testable import Lab86Mail

// Round 2 mail alerts and the "How you write" card (FEATURES items 12 and
// 16): the push settings route, the partial updates, and the learn copy.
@MainActor
struct MailPreferenceTests {
    // MARK: - Mail alerts

    @Test
    func mailAlertSettingsDecodeAndPatchOnlyWhatChanged() throws {
        let settings = try #require(MailAlertSettings(json: .object(["ok": .bool(true), "settings": .object([
            "mode": .string("priority"),
            "quietHours": .object(["enabled": .bool(true), "start": .number(21), "end": .number(6)]),
            "vipSenders": .array([.string("boss@example.com"), .string("@family.org")]),
            "timezone": .string("Europe/Berlin"),
        ])])))
        #expect(settings.mode == .priority)
        #expect(settings.quietHoursEnabled)
        #expect(settings.quietStart == 21 && settings.quietEnd == 6)
        #expect(settings.vipSenders == ["boss@example.com", "@family.org"])
        #expect(settings.timezone == "Europe/Berlin")
        #expect(settings.quietHoursValid)
        #expect(MailAlertSettings(json: .object(["ok": .bool(false), "error": .string("x")])) == nil)

        var same = settings
        same.quietEnd = 21
        #expect(!same.quietHoursValid)

        #expect(MailAlertSettingsPatch(mode: .all).body == .object(["mode": .string("all")]))
        #expect(MailAlertSettingsPatch(quietHoursEnabled: false).body
            == .object(["quietHours": .object(["enabled": .bool(false)])]))
        #expect(MailAlertSettingsPatch(quietStart: 22, quietEnd: 7).body
            == .object(["quietHours": .object(["start": .number(22), "end": .number(7)])]))
        #expect(MailAlertSettingsPatch(addVipSenders: ["a@b.com"]).body == .object(["addVipSenders": .strings(["a@b.com"])]))
        #expect(MailAlertSettingsPatch(removeVipSenders: ["a@b.com"]).body == .object(["removeVipSenders": .strings(["a@b.com"])]))
        #expect(MailAlertSettingsPatch().body == .object([:]))
    }

    @Test
    func aVIPEntryIsAnAddressOrADomain() {
        #expect(MailAlertSettings.normalizedVIP(" Ann@Example.com ") == "ann@example.com")
        #expect(MailAlertSettings.normalizedVIP("@example.com") == "@example.com")
        #expect(MailAlertSettings.normalizedVIP("example.com") == nil)
        #expect(MailAlertSettings.normalizedVIP("ann@") == nil)
        #expect(MailAlertSettings.normalizedVIP("a b@c.com") == nil)
        #expect(MailAlertSettings.normalizedVIP("ann@example.") == nil)
    }

    @Test
    func mailAlertsReadAndWriteThePushSettingsRoute() async throws {
        let server = StubBackendServer()
        defer { server.tearDown() }
        server.routes[MailAlertSettings.path] = .object(["ok": .bool(true), "settings": .object([
            "mode": .string("all"), "quietHours": .object(["enabled": .bool(false), "start": .number(22), "end": .number(7)]),
            "vipSenders": .array([]), "timezone": .string("UTC"),
        ])])
        let loaded = try #require(MailAlertSettings(json: try await server.backend.get(path: MailAlertSettings.path)))
        #expect(loaded.mode == .all)
        _ = try await server.backend.put(path: MailAlertSettings.path, body: MailAlertSettingsPatch(mode: .priority).body)
        #expect(server.recorded.last == StubBackendServer.Request(
            method: "PUT",
            path: MailAlertSettings.path,
            body: .object(["mode": .string("priority")])
        ))
    }

    // MARK: - How you write

    @Test
    func theVoiceCardDecodesAndSaysWhereItCameFrom() throws {
        let learnedAt = Date(timeIntervalSince1970: 1_788_400_000)
        let profile = try #require(VoiceProfile(json: .object([
            "greeting": .string("Hi {name},"), "signOff": .string("Best,\nAnn"), "length": .string("short"),
            "typicalWords": .number(64), "tone": .string("Warm"), "notes": .string(""), "source": .string("learned"),
            "sampleCount": .number(42), "learnedAt": .number(learnedAt.timeIntervalSince1970 * 1_000), "editedAt": .null,
        ])))
        #expect(profile.length == .short)
        #expect(!profile.edited)
        #expect(VoiceProfile.sourceLine(profile) == "Learned from 42 sent emails on \(VoiceProfile.dayLabel(learnedAt))")
        #expect(VoiceProfile.sourceLine(nil) == "Not learned yet")
        #expect(VoiceProfile.sourceLine(VoiceProfile()) == "Set by you")
        #expect(profile.updateArguments == [
            "greeting": .string("Hi {name},"), "signOff": .string("Best,\nAnn"), "length": .string("short"),
            "tone": .string("Warm"), "notes": .string(""),
        ])
        var long = VoiceProfile(tone: String(repeating: "t", count: 300))
        long.notes = String(repeating: "n", count: 600)
        #expect(long.updateArguments["tone"]?.stringValue?.count == 240)
        #expect(long.updateArguments["notes"]?.stringValue?.count == 500)
    }

    @Test
    func learningSaysWhatHappened() async throws {
        let next = Date(timeIntervalSince1970: 1_789_000_000)
        let tools = RecordingTools { name, arguments in
            guard name == "learn_voice_profile" else { return .object(["profile": .null, "nextLearnAt": .null]) }
            if arguments["replaceEdited"] == .bool(true) {
                return .object(["status": .string("learned"), "profile": .object(["greeting": .string("Hey"), "source": .string("learned")])])
            }
            return .object(["status": .string("too_soon"), "profile": .null, "nextLearnAt": .number(next.timeIntervalSince1970 * 1_000)])
        }
        let client = VoiceProfileClient(tools: tools)
        let state = try await client.load()
        #expect(state.profile == nil && state.nextLearnAt == nil)
        let soon = try await client.learn(replaceEdited: false)
        #expect(soon.status == .tooSoon)
        #expect(soon.message == "Albatross learns at most once a week. You can learn again on \(VoiceProfile.dayLabel(next)).")
        let learned = try await client.learn(replaceEdited: true)
        #expect(learned.profile?.greeting == "Hey")
        #expect(learned.message == "Albatross learned how you write.")
        #expect(await tools.arguments(of: "learn_voice_profile") == [[:], ["replaceEdited": .bool(true)]])

        let few = try #require(VoiceLearnResult(json: .object(["status": .string("not_enough_mail"), "sampleCount": .number(2)])))
        #expect(few.message == "Albatross needs at least 5 sent emails to learn how you write. It found 2.")
        let kept = try #require(VoiceLearnResult(json: .object(["status": .string("edited")])))
        #expect(kept.message == "Your edits are kept. Choose Replace my edits to learn again.")
    }
}
