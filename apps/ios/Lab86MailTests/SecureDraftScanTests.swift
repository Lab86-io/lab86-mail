import Foundation
import Testing
@testable import Lab86Mail

// The composer's secret detector, a port of lib/secure/redact.ts. Every
// vector is built from parts at run time, so no test file holds a value
// that looks real. Phone numbers, dates, ZIP codes, prices, and order
// numbers must pass through untouched.
struct SecureDraftScanTests {
    private static let ssnDashed = ["123", "45", "6789"].joined(separator: "-")
    private static let ssnSpaced = ["123", "45", "6789"].joined(separator: " ")
    private static let ssnPlain = ["123", "45", "6789"].joined()
    // The classic Visa test number: Luhn-valid, 16 digits, prefix 4.
    private static let visa = ["4111", "1111", "1111", "1111"].joined(separator: " ")
    private static let visaDashed = ["4111", "1111", "1111", "1111"].joined(separator: "-")
    private static let amex = ["3782", "822463", "10005"].joined(separator: " ")
    private static let openAIKey = "sk-" + String(repeating: "a1B2", count: 6)
    private static let gitHubKey = "ghp_" + String(repeating: "x9Yz", count: 9)
    private static let awsKey = "AKIA" + String(repeating: "AB12", count: 4)
    private static let slackKey = "xoxb-" + ["1234", "5678", "abcdEFGH"].joined(separator: "-")
    private static let googleKey = "AIza" + String(repeating: "Qw3_", count: 8)
    private static let stripeKey = "sk_live_" + String(repeating: "Zy8", count: 6)
    // The vectors of tests/secure-redact-scrub.test.ts, so both detectors
    // agree on the same inputs. The Stripe test card is Luhn-valid.
    private static let visaStripe = ["4242", "4242", "4242", "4242"].joined(separator: " ")
    private static let openAIKeyLong = "sk-" + "abcdefghijklmnop" + "qrstuvwxyz123456"
    private static let awsKeyLetters = "AKIA" + "ABCDEFGHIJKLMNOP"

    private func kinds(_ text: String) -> [SecretShapeKind] {
        SecureDraftScan.detect(text).map(\.kind)
    }

    private func values(_ text: String) -> [String] {
        SecureDraftScan.detect(text).map { String(text[$0.range]) }
    }

    @Test func socialSecurityNumbersInTheirGroupedForms() {
        #expect(kinds("my number is \(Self.ssnDashed), use it") == [.ssn])
        #expect(values("my number is \(Self.ssnDashed), use it") == [Self.ssnDashed])
        #expect(kinds(Self.ssnSpaced) == [.ssn])
        // Mixed separators are not a Social Security number.
        #expect(kinds(["123", "45", "6789"].joined(separator: "-").replacingOccurrences(of: "-6789", with: " 6789")).isEmpty)
        // 000, 666, and 9xx areas, 00 groups, and 0000 serials are not issued.
        #expect(kinds(["000", "45", "6789"].joined(separator: "-")).isEmpty)
        #expect(kinds(["666", "45", "6789"].joined(separator: "-")).isEmpty)
        #expect(kinds(["912", "45", "6789"].joined(separator: "-")).isEmpty)
        #expect(kinds(["123", "00", "6789"].joined(separator: "-")).isEmpty)
        #expect(kinds(["123", "45", "0000"].joined(separator: "-")).isEmpty)
    }

    @Test func socialSecurityNumbersNamedInPlainDigits() {
        #expect(values("my SSN is \(Self.ssnPlain).") == [Self.ssnPlain])
        #expect(values("Social Security number: \(Self.ssnPlain)") == [Self.ssnPlain])
        #expect(values("soc sec \(Self.ssnPlain)") == [Self.ssnPlain])
        // Nine plain digits with no word nearby are an order number.
        #expect(kinds("order \(Self.ssnPlain) shipped").isEmpty)
        #expect(kinds("the ssn\n\(Self.ssnPlain)").isEmpty)
    }

    @Test func cardNumbersNeedANetworkAndLuhn() {
        #expect(kinds("pay with \(Self.visa) please") == [.card])
        #expect(values("pay with \(Self.visa) please") == [Self.visa])
        #expect(kinds(Self.visaDashed) == [.card])
        #expect(kinds(Self.amex) == [.card])
        // A wrong check digit is not a card.
        #expect(kinds(["4111", "1111", "1111", "1112"].joined(separator: " ")).isEmpty)
        // No network has this prefix, Luhn or not.
        #expect(kinds(["1234", "5678", "9012", "3452"].joined(separator: " ")).isEmpty)
        // Too short for a card.
        #expect(kinds(["4111", "1111", "111"].joined(separator: " ")).isEmpty)
        #expect(SecureDraftScan.luhn("79927398713"))
        #expect(!SecureDraftScan.luhn("79927398710"))
        #expect(!SecureDraftScan.luhn(""))
        #expect(SecureDraftScan.cardNetwork("4" + String(repeating: "0", count: 15)))
        #expect(!SecureDraftScan.cardNetwork("4" + String(repeating: "0", count: 14)))
        #expect(SecureDraftScan.cardNetwork("5" + "1" + String(repeating: "0", count: 14)))
        #expect(SecureDraftScan.cardNetwork("2221" + String(repeating: "0", count: 12)))
        #expect(SecureDraftScan.cardNetwork("37" + String(repeating: "0", count: 13)))
        #expect(SecureDraftScan.cardNetwork("6011" + String(repeating: "0", count: 12)))
        #expect(SecureDraftScan.cardNetwork("3528" + String(repeating: "0", count: 12)))
        #expect(!SecureDraftScan.cardNetwork("9" + String(repeating: "0", count: 15)))
    }

    @Test func apiKeysByTheirPrefixes() {
        #expect(kinds("use \(Self.openAIKey) for the call") == [.apiKey])
        #expect(values("use \(Self.openAIKey) for the call") == [Self.openAIKey])
        #expect(kinds(Self.gitHubKey) == [.apiKey])
        #expect(kinds(Self.awsKey) == [.apiKey])
        #expect(kinds(Self.slackKey) == [.apiKey])
        #expect(kinds(Self.googleKey) == [.apiKey])
        #expect(kinds(Self.stripeKey) == [.apiKey])
        // Built from parts, so secret scanners do not report the test file.
        let header = "-----BEGIN RSA " + "PRIVATE KEY-----"
        let footer = "-----END RSA " + "PRIVATE KEY-----"
        let pem = header + "\nabc\ndef\n" + footer
        #expect(values(pem) == [pem])
        #expect(kinds("-----BEGIN " + "PRIVATE KEY-----\nabc") == [.apiKey])
        // Short prefixes are words, not keys.
        #expect(kinds("sk-short").isEmpty)
        #expect(kinds("AKIA1234").isEmpty)
    }

    @Test func ordinaryNumbersPassThrough() {
        #expect(kinds("call me at (555) 010-0100").isEmpty)
        #expect(kinds("555-010-0100").isEmpty)
        #expect(kinds("+1 555 010 0100").isEmpty)
        #expect(kinds("the court date is 2026-11-02 at 9:00").isEmpty)
        #expect(kinds("12 Elm Street, Springfield, IL 62704").isEmpty)
        #expect(kinds("it costs $70.00 or 7000 cents").isEmpty)
        #expect(kinds("order ORD-123456 and tracking 1Z999AA10123456784").isEmpty)
        #expect(kinds("the code is 123456").isEmpty)
        #expect(kinds("").isEmpty)
    }

    @Test func matchesComeInOrderWithoutOverlaps() {
        let text = "key \(Self.openAIKey), ssn \(Self.ssnDashed), card \(Self.visa)."
        let matches = SecureDraftScan.detect(text)
        #expect(matches.map(\.kind) == [.apiKey, .ssn, .card])
        for (left, right) in zip(matches, matches.dropFirst()) {
            #expect(left.range.upperBound <= right.range.lowerBound)
        }
    }

    @Test func redactionPutsAMarkerInPlace() {
        let text = "my ssn is \(Self.ssnDashed) and my card is \(Self.visa)"
        let redacted = SecureDraftScan.redact(text)
        #expect(redacted.text == "my ssn is [removed: looks like a Social Security number] and my card is [removed: looks like a card number]")
        #expect(redacted.kinds == [.ssn, .card])
        #expect(SecureDraftScan.redact("nothing here").kinds.isEmpty)
        #expect(SecureDraftScan.redact("nothing here").text == "nothing here")
        #expect(SecureDraftScan.marker(.apiKey) == "[removed: looks like an API key]")
        // The same kind twice names itself once.
        let twice = SecureDraftScan.redact("\(Self.ssnDashed) and \(Self.ssnSpaced)")
        #expect(twice.kinds == [.ssn])
        // Removal leaves nothing in place.
        let matches = SecureDraftScan.detect(text)
        #expect(SecureDraftScan.removing(matches, from: text) == "my ssn is  and my card is ")
        #expect(SecureDraftScan.removing([matches[0]], from: text) == "my ssn is  and my card is \(Self.visa)")
    }

    @Test func vectorsSharedWithTheServerDetector() {
        // Social Security numbers: a lowercase name, the space-grouped form,
        // mixed separators, an impossible area, and bare digits after a word.
        #expect(kinds("social security number: \(Self.ssnPlain)") == [.ssn])
        #expect(kinds("My SSN is \(Self.ssnDashed).") == [.ssn])
        #expect(kinds(["123", "45", "6789"].joined(separator: " ")) == [.ssn])
        #expect(kinds(["123", "-45 ", "6789"].joined()).isEmpty)
        #expect(kinds(["900", "45", "6789"].joined(separator: "-")).isEmpty)
        #expect(kinds("order " + Self.ssnPlain).isEmpty)
        // Cards: the Stripe test number passes. A Luhn failure, a USPS and a
        // UPS tracking number, a phone number, and a no-network prefix do not.
        #expect(kinds("card \(Self.visaStripe) thanks") == [.card])
        #expect(SecureDraftScan.redact("card \(Self.visaStripe) thanks").text == "card \(SecureDraftScan.marker(.card)) thanks")
        #expect(kinds(["4242", "4242", "4242", "4241"].joined()).isEmpty)
        #expect(kinds(["9400", "1000", "0000", "0000", "0000", "00"].joined()).isEmpty)
        #expect(kinds(["9400", "1000", "0000", "0000", "0000", "00"].joined(separator: " ")).isEmpty)
        #expect(kinds(["1Z", "999AA1", "0123456784"].joined()).isEmpty)
        #expect(kinds("(555) 555-0100").isEmpty)
        #expect(kinds(["7489", "2345", "6712", "3456"].joined()).isEmpty)
        // Keys: a 32-character OpenAI key, an AWS key of letters only, and a
        // private key block with its END line.
        #expect(SecureDraftScan.redact("use \(Self.openAIKeyLong) please").text == "use \(SecureDraftScan.marker(.apiKey)) please")
        #expect(kinds(Self.awsKeyLetters) == [.apiKey])
        #expect(kinds("-----BEGIN " + "PRIVATE KEY-----\nabc\n-----END " + "PRIVATE KEY-----") == [.apiKey])
        // A second pass over redacted text finds nothing and changes nothing.
        let once = SecureDraftScan.redact("\(Self.ssnDashed) and \(Self.visaStripe)")
        #expect(once.kinds.sorted { $0.rawValue < $1.rawValue } == [.card, .ssn])
        let twice = SecureDraftScan.redact(once.text)
        #expect(twice.text == once.text)
        #expect(twice.kinds.isEmpty)
    }

    @Test func kindsKnowWhereTheyCanBeSaved() {
        #expect(SecretShapeKind.ssn.saveKind == .idNumber)
        #expect(SecretShapeKind.apiKey.saveKind == .apiKey)
        #expect(SecretShapeKind.card.saveKind == nil)
        #expect(SecretShapeKind.card.name == "a card number")
        #expect(ComposerNoticeCopy.line(.card).contains("does not keep card numbers yet"))
        #expect(ComposerNoticeCopy.line(.ssn) == "This looks like a Social Security number. Albatross does not send it.")
    }
}
