import Foundation
import Testing
@testable import Lab86Mail

/// The vault is the boundary between mail and other apps' login screens, so the
/// matching rules get the most attention here: offering a code to the wrong
/// site is the one failure worth designing hard against.
struct OneTimeCodeVaultTests {
    private func makeVault() -> (OneTimeCodeVault, URL) {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("otp-vault-\(UUID().uuidString).json")
        return (OneTimeCodeVault(fileURL: url), url)
    }

    private func code(
        id: String = "code-1",
        value: String = "284917",
        services: [String] = ["google.com"],
        expiresIn: TimeInterval = 600
    ) -> StoredOneTimeCode {
        StoredOneTimeCode(
            id: id,
            code: value,
            label: "Google verification code",
            issuer: "Google",
            serviceIdentifiers: services,
            receivedAt: .now,
            expiresAt: Date(timeIntervalSinceNow: expiresIn)
        )
    }

    @Test func storesAndReadsBackCodes() throws {
        let (vault, url) = makeVault()
        defer { try? FileManager.default.removeItem(at: url) }

        vault.replace(codes: [code()], consumeToken: "token", cleanupMode: "archive", apiBaseURL: "https://x")
        #expect(vault.activeCodes().count == 1)
        #expect(vault.consumeToken == "token")
        #expect(vault.cleanupMode == "archive")
    }

    @Test func replacingDropsCodesTheServerNoLongerHolds() throws {
        let (vault, url) = makeVault()
        defer { try? FileManager.default.removeItem(at: url) }

        vault.replace(codes: [code(id: "a"), code(id: "b")], consumeToken: nil, cleanupMode: "none", apiBaseURL: nil)
        vault.replace(codes: [code(id: "b")], consumeToken: nil, cleanupMode: "none", apiBaseURL: nil)
        #expect(vault.activeCodes().map(\.id) == ["b"])
    }

    @Test func expiredCodesAreNeverOffered() throws {
        let (vault, url) = makeVault()
        defer { try? FileManager.default.removeItem(at: url) }

        vault.replace(
            codes: [code(id: "live"), code(id: "dead", expiresIn: -60)],
            consumeToken: nil,
            cleanupMode: "none",
            apiBaseURL: nil
        )
        #expect(vault.activeCodes().map(\.id) == ["live"])
    }

    @Test func matchesTheIssuingDomainAndItsSubdomains() throws {
        let (vault, url) = makeVault()
        defer { try? FileManager.default.removeItem(at: url) }

        vault.replace(codes: [code()], consumeToken: nil, cleanupMode: "none", apiBaseURL: nil)
        #expect(vault.codes(forServiceIdentifier: "google.com").count == 1)
        #expect(vault.codes(forServiceIdentifier: "accounts.google.com").count == 1)
        #expect(vault.codes(forServiceIdentifier: "https://accounts.google.com/signin").count == 1)
    }

    /// The whole point of label-aligned suffix matching. A plain `hasSuffix`
    /// would hand a Google code to whoever registered `notgoogle.com`.
    @Test func neverMatchesALookalikeDomain() throws {
        let (vault, url) = makeVault()
        defer { try? FileManager.default.removeItem(at: url) }

        vault.replace(codes: [code()], consumeToken: nil, cleanupMode: "none", apiBaseURL: nil)
        #expect(vault.codes(forServiceIdentifier: "notgoogle.com").isEmpty)
        #expect(vault.codes(forServiceIdentifier: "google.com.evil.example").isEmpty)
        #expect(vault.codes(forServiceIdentifier: "elgoog.com").isEmpty)
    }

    @Test func matchesAnyOfTheCodesServices() throws {
        let (vault, url) = makeVault()
        defer { try? FileManager.default.removeItem(at: url) }

        vault.replace(
            codes: [code(services: ["console.aws.amazon.com", "amazon.com"])],
            consumeToken: nil,
            cleanupMode: "none",
            apiBaseURL: nil
        )
        #expect(vault.codes(forServiceIdentifier: "amazon.com").count == 1)
        #expect(vault.codes(forServiceIdentifier: "console.aws.amazon.com").count == 1)
    }

    @Test func consumingRemovesTheCodeAndQueuesTheReport() throws {
        let (vault, url) = makeVault()
        defer { try? FileManager.default.removeItem(at: url) }

        vault.replace(codes: [code()], consumeToken: nil, cleanupMode: "archive", apiBaseURL: nil)
        vault.consume(codeID: "code-1", cleanup: "archive")

        // Spent locally first, so a killed extension can never offer it twice.
        #expect(vault.activeCodes().isEmpty)
        #expect(vault.pendingConsumptions().map(\.codeID) == ["code-1"])

        vault.clearPendingConsumption(codeID: "code-1")
        #expect(vault.pendingConsumptions().isEmpty)
    }

    @Test func consumingTwiceQueuesOneReport() throws {
        let (vault, url) = makeVault()
        defer { try? FileManager.default.removeItem(at: url) }

        vault.replace(codes: [code()], consumeToken: nil, cleanupMode: "archive", apiBaseURL: nil)
        vault.consume(codeID: "code-1", cleanup: "archive")
        vault.consume(codeID: "code-1", cleanup: "archive")
        #expect(vault.pendingConsumptions().count == 1)
    }

    @Test func clearingRemovesEverything() throws {
        let (vault, url) = makeVault()
        defer { try? FileManager.default.removeItem(at: url) }

        vault.replace(codes: [code()], consumeToken: "token", cleanupMode: "archive", apiBaseURL: "https://x")
        vault.consume(codeID: "code-1", cleanup: "archive")
        vault.clear()

        #expect(vault.activeCodes().isEmpty)
        #expect(vault.pendingConsumptions().isEmpty)
        #expect(vault.consumeToken == nil)
    }

    @Test func staleConsumptionsAreDroppedRatherThanRetriedForever() throws {
        let (vault, url) = makeVault()
        defer { try? FileManager.default.removeItem(at: url) }

        vault.replace(codes: [code()], consumeToken: nil, cleanupMode: "archive", apiBaseURL: nil)
        vault.consume(codeID: "code-1", cleanup: "archive", at: Date(timeIntervalSinceNow: -90_000))
        vault.removeExpired()
        #expect(vault.pendingConsumptions().isEmpty)
    }

    @Test func aVaultWithNoContainerStaysInertRatherThanCrashing() throws {
        let vault = OneTimeCodeVault(fileURL: nil)
        vault.replace(codes: [code()], consumeToken: "t", cleanupMode: "archive", apiBaseURL: nil)
        #expect(vault.isAvailable == false)
        #expect(vault.activeCodes().isEmpty)
    }
}
