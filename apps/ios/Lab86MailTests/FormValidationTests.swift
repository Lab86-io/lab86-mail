import Foundation
import Testing
@testable import Lab86Mail

// The form card's pure rules: the validators for each field kind, the prefill
// from the personal details, the recommended option, the save toggle, and
// the answer on the wire.
struct FormValidationTests {
    // MARK: - Validators

    @Test func aPhoneNeedsSevenDigitsAndOnlyPhoneMarks() {
        #expect(FormValidation.phoneError("(555) 010-0100") == nil)
        #expect(FormValidation.phoneError("+1 555 010 0100") == nil)
        #expect(FormValidation.phoneError("555-01") == FormValidation.phoneLine)
        #expect(FormValidation.phoneError("call me") == FormValidation.phoneLine)
        #expect(FormValidation.phoneError(String(repeating: "5", count: 41)) == FormValidation.phoneLine)
    }

    @Test func anEmailNeedsOneAtAndADomainWithADot() {
        #expect(FormValidation.emailError("sam.rivera@example.com") == nil)
        #expect(FormValidation.emailError("sam@example") == FormValidation.emailLine)
        #expect(FormValidation.emailError("sam example.com") == FormValidation.emailLine)
        #expect(FormValidation.emailError("@example.com") == FormValidation.emailLine)
        #expect(FormValidation.emailError("sam@@example.com") == FormValidation.emailLine)
    }

    @Test func aDateIsARealCalendarDay() {
        #expect(FormValidation.dateError("2026-10-19") == nil)
        #expect(FormValidation.dateError("2026-02-30") == FormValidation.dateLine)
        #expect(FormValidation.dateError("19/10/2026") == FormValidation.dateLine)
        #expect(FormValidation.dateError("") == FormValidation.dateLine)
    }

    @Test func aDateRoundTripsThroughItsString() throws {
        let date = try #require(FormValidation.isoDate("2026-10-19"))
        #expect(FormValidation.isoString(date) == "2026-10-19")
    }

    @Test func structuredValuesNeedTheirRequiredParts() {
        #expect(FormValidation.nameError(first: "Sam", last: "Rivera") == nil)
        #expect(FormValidation.nameError(first: "Sam", last: " ") == FormValidation.nameLine)
        #expect(FormValidation.addressError(line1: "12 Elm Street", city: "Springfield", region: "IL", postalCode: "62704", country: "US") == nil)
        #expect(FormValidation.addressError(line1: "12 Elm Street", city: "", region: "IL", postalCode: "62704", country: "US") == FormValidation.addressLine)
        #expect(FormValidation.addressError(line1: "12 Elm Street", city: "Springfield", region: "IL", postalCode: "62704", country: "USA") == FormValidation.addressLine)
        #expect(FormValidation.contactError(name: "Alex Rivera", phone: "(555) 010-0122") == nil)
        #expect(FormValidation.contactError(name: "", phone: "(555) 010-0122") == FormValidation.contactLine)
        #expect(FormValidation.contactError(name: "Alex Rivera", phone: "12") == FormValidation.contactLine)
        #expect(FormValidation.numberError("70") == nil)
        #expect(FormValidation.numberError("seventy") == FormValidation.numberLine)
    }

    @Test func anEmptyOptionalFieldIsFineAndAnEmptyRequiredOneIsNot() {
        let optional = FormField(id: "note", label: "Note", kind: .text, required: false)
        #expect(FormValidation.error(for: optional, value: .text("")) == nil)
        let required = FormField(id: "phone", label: "Phone", kind: .phone)
        #expect(FormValidation.error(for: required, value: .text("")) == FormValidation.phoneLine)
        let choice = FormField(id: "class", label: "Class", kind: .choice, options: Self.options, multiple: true)
        #expect(FormValidation.error(for: choice, value: .choice(selected: [], other: "")) == FormValidation.chooseSomeLine)
        let withOther = FormField(id: "class", label: "Class", kind: .choice, options: Self.options, allowOther: true)
        #expect(FormValidation.error(for: withOther, value: .choice(selected: [], other: "Another day")) == nil)
    }

    // MARK: - The draft

    private static let options = [
        FormOption(id: "mon", label: "Monday, October 19", detail: "4:00–8:00 PM · Zoom · $70", recommended: "Matches what you said",
                   calendar: .init(fit: .free, note: "Free on your calendar")),
        FormOption(id: "wed", label: "Wednesday, October 21", detail: "4:00–8:00 PM · Zoom · $70",
                   calendar: .init(fit: .conflict, note: "Conflicts with Team sync")),
    ]

    private static let form = FormQuestion(
        title: "Which class?",
        fields: [
            FormField(id: "class", label: "Class", kind: .choice, options: options),
            FormField(id: "name", label: "Name", kind: .name, detailKey: "name"),
            FormField(id: "phone", label: "Phone", kind: .phone, detailKey: "phone"),
            FormField(id: "email", label: "Email", kind: .email, detailKey: "email", value: .string("sam.rivera@example.com"), valueSource: "From your email signature"),
        ]
    )

    private static let details: [PersonalDetailKey: PersonalDetailView] = [
        .name: PersonalDetailView(key: .name, value: .name(PersonalNameValue(first: "Sam", last: "Rivera")), source: .account, saved: false),
    ]

    @Test func theDraftSelectsTheRecommendedOptionAndFillsTheBoundFields() {
        let draft = FormDraft.initial(form: Self.form, details: Self.details, country: "US")
        #expect(draft.values["class"] == .choice(selected: ["mon"], other: ""))
        #expect(draft.values["name"] == .name(first: "Sam", middle: "", last: "Rivera"))
        #expect(draft.sources["name"] == .account)
        #expect(draft.values["phone"] == .text(""))
        #expect(draft.sources["phone"] == nil)
        // A value the server found wins and names its source.
        #expect(draft.values["email"] == .text("sam.rivera@example.com"))
        #expect(draft.sources["email"] == .found("From your email signature"))
        #expect(draft.save)
    }

    @Test func theSaveToggleShowsOnlyForANewOrChangedBoundValue() {
        var draft = FormDraft.initial(form: Self.form, details: Self.details, country: "US")
        // The found email is new (nothing saved), so the toggle shows.
        #expect(draft.showsSaveToggle(Self.form))
        #expect(draft.changedBoundFields(Self.form).map(\.id) == ["email"])
        draft.values["phone"] = .text("(555) 010-0100")
        #expect(draft.changedBoundFields(Self.form).map(\.id) == ["phone", "email"])
        #expect(draft.savedLabels(Self.form) == ["Phone", "Email"])
        // The name equals the saved one: not a change.
        #expect(!draft.changedBoundFields(Self.form).contains { $0.id == "name" })
    }

    @Test func theDraftIsCompleteOnlyWhenEveryFieldIsValid() {
        var draft = FormDraft.initial(form: Self.form, details: Self.details, country: "US")
        #expect(!draft.isComplete(Self.form))
        #expect(draft.error(for: Self.form.fields[2]) == FormValidation.phoneLine)
        #expect(draft.shownError(for: Self.form.fields[2]) == nil)
        draft.touched.insert("phone")
        #expect(draft.shownError(for: Self.form.fields[2]) == FormValidation.phoneLine)
        draft.values["phone"] = .text("(555) 010-0100")
        #expect(draft.isComplete(Self.form))
    }

    @Test func theAnswerCarriesTheValuesAndTheSaveFlag() throws {
        var draft = FormDraft.initial(form: Self.form, details: Self.details, country: "US")
        draft.values["phone"] = .text("(555) 010-0100")
        let answer = draft.answer(Self.form)
        #expect(answer.values["class"] == FormFieldValue.choice(["mon"]))
        #expect(answer.values["phone"] == .string("(555) 010-0100"))
        #expect(answer.values["name"] == FormFieldValue.name(first: "Sam", middle: nil, last: "Rivera"))
        #expect(answer.save)
        #expect(!answer.skipped)
        draft.save = false
        #expect(!draft.answer(Self.form).save)
        let json = answer.json
        #expect(json["save"]?.boolValue == true)
        #expect(json["skipped"] == nil)
        #expect(FormAnswer.skippedForm.json["skipped"]?.boolValue == true)
        let restored = try #require(FormAnswer(json: json))
        #expect(restored == answer)
    }

    @Test func aDraftValueKnowsWhenItIsEmptyAndHowItReads() {
        #expect(FormDraftValue.text("  ").isEmpty)
        #expect(FormDraftValue.name(first: "", middle: "Lee", last: "").isEmpty)
        #expect(!FormDraftValue.contact(name: "Alex", phone: "", relationship: "").isEmpty)
        let field = FormField(id: "class", label: "Class", kind: .choice, options: Self.options)
        #expect(FormDraftValue.choice(selected: ["wed"], other: "").display(field: field) == "Wednesday, October 21")
        #expect(FormDraftValue.choice(selected: [], other: "Another day").display(field: field) == "Another day")
        let address = FormDraftValue.address(line1: "12 Elm Street", line2: "Apt 3", city: "Springfield", region: "IL", postalCode: "62704", country: "US")
        #expect(address.display(field: FormField(id: "home", label: "Home", kind: .address)) == "12 Elm Street, Apt 3, Springfield, IL 62704")
    }

    @Test func theReceiptRowsFollowTheFormFields() {
        let answer = FormAnswer(values: [
            "class": FormFieldValue.choice(["mon"]),
            "phone": .string("(555) 010-0100"),
            "email": .string("sam.rivera@example.com"),
        ], save: true)
        let rows = FormQuestionCard.rows(form: Self.form, answer: answer)
        #expect(rows.map(\.label) == ["Class", "Phone", "Email"])
        #expect(rows.first?.value == "Monday, October 19")
        #expect(FormQuestionCard.savedLabels(form: Self.form, answer: answer) == ["Phone", "Email"])
        #expect(FormQuestionCard.savedLabels(form: Self.form, answer: FormAnswer(values: answer.values, save: false)).isEmpty)
    }

    @Test func theFocusIDNamesItsField() {
        #expect(FormFocus.fieldID(of: "home.city") == "home")
        #expect(FormFocus.fieldID(of: "phone") == "phone")
    }
}
