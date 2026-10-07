import Foundation
import Testing
@testable import Lab86Mail

// Personal details on the wire: keys, values, the settings rows, the source
// lines, and the save errors. Invented data only.
@MainActor
struct PersonalDetailsModelsTests {
    @Test func keysRoundTripThroughTheirWireWords() {
        for key in PersonalDetailKey.fixed {
            #expect(PersonalDetailKey(wire: key.wire) == key)
        }
        #expect(PersonalDetailKey(wire: "home_address") == .homeAddress)
        #expect(PersonalDetailKey(wire: "custom:employer") == .custom("employer"))
        #expect(PersonalDetailKey(wire: "custom:Employer") == nil)
        #expect(PersonalDetailKey(wire: "custom:") == nil)
        #expect(PersonalDetailKey(wire: "passport") == nil)
        #expect(PersonalDetailKey.custom("employer").wire == "custom:employer")
        #expect(PersonalDetailKey.custom("employer").fixedLabel == nil)
        #expect(PersonalDetailKey.homeAddress.fixedLabel == "Home address")
    }

    @Test func valuesDecodeByTheirKeysShape() throws {
        let name = try #require(PersonalDetailValue(key: .name, json: .object(["first": .string("Sam"), "last": .string("Rivera")])))
        #expect(name.display == "Sam Rivera")
        let address = try #require(PersonalDetailValue(key: .homeAddress, json: .object([
            "line1": .string("12 Elm Street"), "line2": .string("Apt 3"), "city": .string("Springfield"),
            "region": .string("IL"), "postalCode": .string("62704"), "country": .string("us"),
        ])))
        #expect(address.display == "12 Elm Street, Apt 3, Springfield, IL 62704")
        #expect(address.json["country"]?.stringValue == "US")
        let contact = try #require(PersonalDetailValue(key: .emergencyContact, json: .object([
            "name": .string("Alex Rivera"), "phone": .string("(555) 010-0122"), "relationship": .string("Partner"),
        ])))
        #expect(contact.display == "Alex Rivera · (555) 010-0122 · Partner")
        let custom = try #require(PersonalDetailValue(key: .custom("employer"), json: .object(["label": .string("Employer"), "value": .string("Northwind")])))
        #expect(custom.display == "Northwind")
        #expect(PersonalDetailValue(key: .phone, json: .object([:])) == nil)
        #expect(PersonalDetailValue(key: .name, json: .object(["first": .string("Sam")])) == nil)
    }

    @Test func theSettingsRowDecodesWithItsSourceAndLabel() throws {
        let row = try #require(PersonalDetailView(json: .object([
            "key": .string("phone"),
            "label": .string("Phone"),
            "value": .string("(555) 010-0100"),
            "display": .string("(555) 010-0100"),
            "source": .string("chat"),
            "saved": .bool(true),
            "updatedAt": .number(1_791_392_640_000),
        ])))
        #expect(row.key == .phone)
        #expect(row.display == "(555) 010-0100")
        #expect(row.source == .chat)
        #expect(row.sourceLine.hasPrefix("You told Albatross on "))
        let custom = try #require(PersonalDetailView(json: .object([
            "key": .string("custom:employer"),
            "value": .object(["label": .string("Employer"), "value": .string("Northwind")]),
            "source": .string("settings"),
        ])))
        #expect(custom.label == "Employer")
        #expect(custom.display == "Northwind")
        #expect(custom.saved)
        #expect(PersonalDetailView(json: .object(["key": .string("passport"), "value": .string("x")])) == nil)
    }

    @Test func theSourceLinesSayWhereADetailCameFrom() {
        #expect(PersonalDetailSource.account.line(updatedAt: nil) == "From your account")
        #expect(PersonalDetailSource.settings.line(updatedAt: nil) == "You saved this")
        #expect(PersonalDetailSource.form.line(updatedAt: nil) == "From a form")
        let day = Date(timeIntervalSince1970: 1_791_392_640)
        let line = PersonalDetailSource.chat.line(updatedAt: day, locale: Locale(identifier: "en_US"))
        #expect(line.hasPrefix("You told Albatross on "))
        #expect(line.count > "You told Albatross on ".count)
    }

    @Test func theResponseListsTheMissingKeysInCatalogOrder() {
        let response = PersonalDetailsResponse(json: .object([
            "ok": .bool(true),
            "details": .array([
                .object(["key": .string("email"), "value": .string("sam.rivera@example.com"), "source": .string("account"), "saved": .bool(false)]),
            ]),
        ]))
        #expect(response.details.map(\.key) == [.email])
        #expect(response.missing == [.name, .phone, .homeAddress, .emergencyContact])
        let named = PersonalDetailsResponse(json: .object(["details": .array([]), "missing": .array([.string("phone")])]))
        #expect(named.missing == [.phone])
    }

    @Test func aSaveErrorReadsTheRoutesCode() {
        #expect(PersonalDetailSaveError.from(status: 400, body: .object(["code": .string("refused"), "error": .string("x")])) == .refused)
        #expect(PersonalDetailSaveError.from(status: 400, body: .object(["code": .string("invalid"), "error": .string("Too long.")])) == .invalid("Too long."))
        #expect(PersonalDetailSaveError.from(status: 409, body: nil) == .limit)
        #expect(PersonalDetailSaveError.from(status: 500, body: nil) == .other("The detail did not save. Try again."))
        #expect(PersonalDetailSaveError.refused.line == "Albatross does not keep this number here.")
    }

    @Test func receiptLabelsComeFromTheKeys() {
        #expect(PersonalDetailsStore.labels(for: ["phone", "home_address", "custom:employer"]) == ["Phone", "Home address", "employer"])
    }
}
