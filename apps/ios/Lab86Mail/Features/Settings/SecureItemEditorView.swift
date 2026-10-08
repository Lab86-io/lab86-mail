import SwiftUI

// The sheets of Passwords and IDs (docs/research/secure-store-ios-design-2026-10-07.md,
// sections 3 and 4): add a sign-in, an ID, the date of birth, or a key;
// replace one secret field; add a site. A value goes from the field to the
// store and never through the chat. The sheet never prefills a secret,
// except the one the composer notice hands over (V9). "Show" shows fresh
// input while the user types; it is off at every open. The server is the
// authority for refusals and for the site rule; the client runs the same
// checks first so the user sees the line before a round trip.

struct SecureItemEditorView: View {
    enum Target: Identifiable, Hashable {
        case newSignIn(site: String?, label: String?)
        case newID(type: IdNumberType, number: String?)
        case newDateOfBirth
        case newKey(site: String?, label: String?, key: String?)
        case replace(item: SecureItemView, field: String)
        case addSite(item: SecureItemView)

        var id: String {
            switch self {
            case .newSignIn: "new:sign_in"
            case .newID(let type, _): "new:id:\(type.rawValue)"
            case .newDateOfBirth: "new:date_of_birth"
            case .newKey: "new:api_key"
            case .replace(let item, let field): "replace:\(item.id):\(field)"
            case .addSite(let item): "site:\(item.id)"
            }
        }

        /// The sheet opened with a site in the field.
        var sitePrefilled: Bool {
            switch self {
            case .newSignIn(let site, _), .newKey(let site, _, _): site?.nilIfBlank != nil
            default: false
            }
        }
    }

    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let target: Target
    /// Where a prefilled site came from. A run's page is read-only; the
    /// model's suggestion stays editable and carries a warning line.
    let siteSource: SecureSiteSource
    /// The saved item, or nil when the sheet closed without a save.
    let onFinish: (SecureItemView?) -> Void

    @State private var site = ""
    @State private var username = ""
    @State private var password = ""
    @State private var label = ""
    @State private var number = ""
    @State private var region = ""
    @State private var country = ""
    @State private var expires: Date?
    @State private var nameOnID = ""
    @State private var nameFromDetails = false
    @State private var key = ""
    @State private var header = ""
    @State private var birthDate: Date?
    @State private var showsSecret = false
    @State private var siteEdited = false
    @State private var isSaving = false
    @State private var errorLine: String?
    @State private var fieldErrors: [String: String] = [:]
    @State private var finished = false
    @State private var identity = IdentityCheckPresenter()
    @FocusState private var focus: String?

    init(target: Target, siteSource: SecureSiteSource = .user, onFinish: @escaping (SecureItemView?) -> Void) {
        self.target = target
        self.siteSource = siteSource
        self.onFinish = onFinish
        switch target {
        case .newSignIn(let site, let label):
            _site = State(initialValue: site ?? "")
            _label = State(initialValue: label ?? "")
        case .newID(_, let number):
            _number = State(initialValue: number ?? "")
            _country = State(initialValue: Locale.current.region?.identifier ?? "US")
        case .newKey(let site, let label, let key):
            _site = State(initialValue: site ?? "")
            _label = State(initialValue: label ?? "")
            _key = State(initialValue: key ?? "")
        case .newDateOfBirth, .replace, .addSite:
            break
        }
    }

    private var store: SecureDetailsStore { environment.secureDetails }

    private var title: String {
        switch target {
        case .newSignIn: SecureDetailsCopy.newSignIn
        case .newID(let type, _): type.label
        case .newDateOfBirth: SecureDetailsCopy.dateOfBirth
        case .newKey: SecureDetailsCopy.newKey
        case .replace(_, let field): SecureDetailsCopy.replaceTitle(field: field)
        case .addSite(let item): item.kind == .apiKey ? SecureDetailsCopy.addHost : SecureDetailsCopy.addSite
        }
    }

    /// The host as the server will see it, from what the user typed.
    private var cleanedSite: String { SecureSite.clean(site) }

    var body: some View {
        NavigationStack {
            Form {
                fields
                if let errorLine {
                    Section {
                        Text(errorLine)
                            .font(.footnote)
                            .foregroundStyle(.red)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(SecureDetailsCopy.cancel) { cancel() }
                        .disabled(isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? SecureDetailsCopy.saving : SecureDetailsCopy.save) { Task { await save() } }
                        .disabled(isSaving || !canSave)
                }
                #if os(iOS)
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") { focus = nil }
                }
                #endif
            }
        }
        .interactiveDismissDisabled(isSaving)
        .identityCheckSheet(identity)
        .task { prefillName() }
        .onDisappear {
            // A swipe down is a cancel.
            if !finished {
                finished = true
                onFinish(nil)
            }
        }
    }

    // MARK: - Fields

    @ViewBuilder private var fields: some View {
        switch target {
        case .newSignIn:
            signInFields
        case .newID(let type, _):
            idFields(type)
        case .newDateOfBirth:
            dateOfBirthFields
        case .newKey:
            keyFields
        case .replace(let item, let field):
            replaceFields(item: item, field: field)
        case .addSite(let item):
            addSiteFields(item: item)
        }
    }

    private var signInFields: some View {
        Section {
            siteField(title: SecureDetailsCopy.site, prompt: SecureDetailsCopy.sitePrompt)
            TextField(SecureDetailsCopy.username, text: $username, prompt: Text(SecureDetailsCopy.usernamePrompt))
                .focused($focus, equals: "username")
                .textContentType(.username)
                .keyboardType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.next)
                .onSubmit { focus = "password" }
            errorText("username")
            secretField(
                title: SecureDetailsCopy.password,
                text: $password,
                focusID: "password",
                isPassword: true,
                caption: password.isEmpty ? nil : SecureDetailsCopy.characters(password.count)
            )
            errorText("password")
            TextField(SecureDetailsCopy.name, text: $label, prompt: Text(cleanedSite.nilIfBlank ?? SecureDetailsCopy.sitePrompt))
                .focused($focus, equals: "label")
                .textInputAutocapitalization(.words)
        } footer: {
            Text(SecureDetailsCopy.signInFooter(site: cleanedSite) + " " + SecureDetailsCopy.siteCovers)
        }
    }

    private func idFields(_ type: IdNumberType) -> some View {
        Section {
            TextField(
                SecureDetailsCopy.number,
                text: $number,
                prompt: Text(type == .ssn ? SecureDetailsCopy.ssnPrompt : SecureDetailsCopy.number)
            )
            .focused($focus, equals: "number")
            .keyboardType(type == .ssn ? .numbersAndPunctuation : .default)
            .textInputAutocapitalization(type == .ssn ? .never : .characters)
            .autocorrectionDisabled()
            .monospacedDigit()
            if let ends = SecureDetailsCopy.ends(number) {
                caption(ends)
            }
            errorText("number")
            if type.usesRegion {
                TextField(SecureDetailsCopy.state, text: $region, prompt: Text(SecureDetailsCopy.statePrompt))
                    .focused($focus, equals: "region")
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .addressStateContentType()
                errorText("region")
            }
            if type.usesCountry {
                TextField(SecureDetailsCopy.country, text: $country, prompt: Text("US"))
                    .focused($focus, equals: "country")
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                errorText("country")
            }
            if type.usesExpiry {
                optionalDateRow(title: SecureDetailsCopy.expiryDate, date: $expires)
                errorText("expires")
            }
            if type.usesNameOnID {
                TextField(SecureDetailsCopy.nameOnID, text: $nameOnID, prompt: Text("Sam Rivera"))
                    .focused($focus, equals: "name_on_id")
                    .textInputAutocapitalization(.words)
                    .nameContentType()
                if nameFromDetails {
                    caption(SecureDetailsCopy.fromYourDetails)
                }
                errorText("name_on_id")
            }
        } footer: {
            Text(type == .ssn ? SecureDetailsCopy.ssnFooter : SecureDetailsCopy.idFooter)
        }
    }

    private var dateOfBirthFields: some View {
        Section {
            birthDatePicker
            errorText("date")
        } footer: {
            Text(SecureDetailsCopy.dobFooter)
        }
    }

    private var keyFields: some View {
        Section {
            TextField(SecureDetailsCopy.name, text: $label, prompt: Text(SecureDetailsCopy.keyNamePrompt))
                .focused($focus, equals: "label")
                .textInputAutocapitalization(.words)
            errorText("label")
            siteField(title: SecureDetailsCopy.host, prompt: SecureDetailsCopy.hostPrompt)
            secretField(
                title: SecureDetailsCopy.key,
                text: $key,
                focusID: "key",
                isPassword: false,
                caption: SecureDetailsCopy.keyCaption(key.trimmingCharacters(in: .whitespacesAndNewlines))
            )
            errorText("key")
            TextField(SecureDetailsCopy.header, text: $header, prompt: Text(SecureDetailsCopy.headerPrompt))
                .focused($focus, equals: "header")
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            caption(SecureDetailsCopy.headerHelp)
        } footer: {
            Text(SecureDetailsCopy.keyFooter(host: cleanedSite))
        }
    }

    @ViewBuilder private func replaceFields(item: SecureItemView, field: String) -> some View {
        Section {
            switch field {
            case "password", "key":
                secretField(
                    title: SecureFieldLabel.text(field),
                    text: field == "key" ? $key : $password,
                    focusID: field,
                    isPassword: field == "password",
                    caption: field == "key"
                        ? SecureDetailsCopy.keyCaption(key.trimmingCharacters(in: .whitespacesAndNewlines))
                        : (password.isEmpty ? nil : SecureDetailsCopy.characters(password.count))
                )
            case "username":
                TextField(SecureDetailsCopy.username, text: $username, prompt: Text(SecureDetailsCopy.usernamePrompt))
                    .focused($focus, equals: "username")
                    .textContentType(.username)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            case "number":
                let ssn = item.idType == .ssn
                TextField(SecureDetailsCopy.number, text: $number, prompt: Text(ssn ? SecureDetailsCopy.ssnPrompt : SecureDetailsCopy.number))
                    .focused($focus, equals: "number")
                    .keyboardType(ssn ? .numbersAndPunctuation : .default)
                    .textInputAutocapitalization(ssn ? .never : .characters)
                    .autocorrectionDisabled()
                    .monospacedDigit()
                if let ends = SecureDetailsCopy.ends(number) { caption(ends) }
            case "expires":
                optionalDateRow(title: SecureDetailsCopy.expiryDate, date: $expires)
            case "date":
                birthDatePicker
            case "name_on_id":
                TextField(SecureDetailsCopy.nameOnID, text: $nameOnID, prompt: Text("Sam Rivera"))
                    .focused($focus, equals: "name_on_id")
                    .textInputAutocapitalization(.words)
                    .nameContentType()
            default:
                TextField(SecureFieldLabel.text(field), text: $number)
                    .focused($focus, equals: field)
            }
            errorText(field)
        } footer: {
            Text(SecureDetailsCopy.replaceFooter)
        }
    }

    private func addSiteFields(item: SecureItemView) -> some View {
        Section {
            siteField(
                title: item.kind == .apiKey ? SecureDetailsCopy.host : SecureDetailsCopy.site,
                prompt: item.kind == .apiKey ? SecureDetailsCopy.hostPrompt : SecureDetailsCopy.sitePrompt
            )
        } footer: {
            Text(item.kind == .apiKey ? SecureDetailsCopy.addHostFooter : SecureDetailsCopy.addSiteFooter)
        }
    }

    // MARK: - Controls

    /// The site came from the page a run opened: the field is read-only.
    private var siteFromRun: Bool {
        target.sitePrefilled && siteSource == .run
    }

    @ViewBuilder private func siteField(title: String, prompt: String) -> some View {
        TextField(title, text: $site, prompt: Text(prompt))
            .focused($focus, equals: "site")
            .keyboardType(.URL)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .urlContentType()
            .disabled(siteFromRun)
            .onChange(of: site) { _, _ in siteEdited = true }
        if siteFromRun {
            caption(SecureDetailsCopy.fromTheRun)
        } else if target.sitePrefilled, SecureSite.showsSuggestedSiteWarning(source: siteSource, edited: siteEdited) {
            // The model named this site in the chat. An injected message
            // could name a fake one; the user checks it before a real
            // password binds to it.
            Text(title == SecureDetailsCopy.host ? SecureDetailsCopy.suggestedHost : SecureDetailsCopy.suggestedSite)
                .font(.caption)
                .foregroundStyle(.orange)
                .fixedSize(horizontal: false, vertical: true)
        } else if !cleanedSite.isEmpty, cleanedSite != site.trimmingCharacters(in: .whitespacesAndNewlines) {
            caption(SecureDetailsCopy.savedAs(cleanedSite))
        }
        errorText("site")
    }

    /// A secure field with "Show", and a live caption so a paste can be
    /// checked without a reveal.
    @ViewBuilder private func secretField(
        title: String,
        text: Binding<String>,
        focusID: String,
        isPassword: Bool,
        caption: String?
    ) -> some View {
        let field = Group {
            if showsSecret {
                TextField(title, text: text, prompt: Text(title))
            } else {
                SecureField(title, text: text, prompt: Text(title))
            }
        }
        .focused($focus, equals: focusID)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .passwordContentType(isPassword)
        let showButton = Button(showsSecret ? SecureDetailsCopy.hide : SecureDetailsCopy.show) { showsSecret.toggle() }
            .buttonStyle(.borderless)
            .font(.footnote)
            .accessibilityLabel(showsSecret ? "Hide the \(title.lowercased())" : "Show the \(title.lowercased())")
        #if os(macOS)
        // A grouped Mac form shows the title as the row label. The field
        // keeps the control column, and "Show" sits beside it.
        LabeledContent(title) {
            HStack(spacing: 10) {
                field.labelsHidden()
                showButton
            }
        }
        #else
        HStack(spacing: 10) {
            field
            showButton
        }
        #endif
        if let caption {
            self.caption(caption)
        }
    }

    /// "Set" opens a date; a set date shows the picker and a quiet remove.
    @ViewBuilder private func optionalDateRow(title: String, date: Binding<Date?>) -> some View {
        if let current = date.wrappedValue {
            DatePicker(
                title,
                selection: Binding(get: { current }, set: { date.wrappedValue = $0 }),
                displayedComponents: .date
            )
            .datePickerStyle(.compact)
            Button("No \(title.lowercased())") { date.wrappedValue = nil }
                .buttonStyle(.borderless)
                .font(.footnote)
        } else {
            #if os(macOS)
            LabeledContent(title) {
                Button(SecureDetailsCopy.set) { date.wrappedValue = Self.defaultExpiry }
                    .buttonStyle(.bordered)
            }
            #else
            Button {
                date.wrappedValue = Self.defaultExpiry
            } label: {
                LabeledContent(title, value: SecureDetailsCopy.set)
            }
            .foregroundStyle(.primary)
            #endif
        }
    }

    /// The date of birth: a wheel, so a year decades back is quick. The
    /// compact picker at accessibility sizes, where the wheel is unreadable.
    @ViewBuilder private var birthDatePicker: some View {
        let picker = DatePicker(
            SecureDetailsCopy.dateOfBirth,
            selection: Binding(get: { birthDate ?? Self.defaultBirthDate }, set: { birthDate = $0 }),
            in: Self.birthDateRange,
            displayedComponents: .date
        )
        #if os(iOS)
        if dynamicTypeSize.isAccessibilitySize {
            picker.datePickerStyle(.compact)
        } else {
            picker.datePickerStyle(.wheel).labelsHidden()
        }
        #else
        picker.datePickerStyle(.compact)
        #endif
        if birthDate == nil {
            caption(SecureDetailsCopy.pickDate)
        }
    }

    private func caption(_ text: String) -> some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder private func errorText(_ field: String) -> some View {
        if let line = fieldErrors[field] {
            Text(line)
                .font(.caption)
                .foregroundStyle(.red)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private static var defaultExpiry: Date {
        Calendar.current.date(byAdding: .year, value: 4, to: Calendar.current.startOfDay(for: .now)) ?? .now
    }

    private static var defaultBirthDate: Date {
        Calendar.current.date(byAdding: .year, value: -30, to: Calendar.current.startOfDay(for: .now)) ?? .now
    }

    private static var birthDateRange: ClosedRange<Date> {
        let today = Calendar.current.startOfDay(for: .now)
        let earliest = Calendar.current.date(byAdding: .year, value: -120, to: today) ?? today
        return earliest...today
    }

    /// The name on the ID starts as the user's own name, from Personal details.
    private func prefillName() {
        guard case .newID(let type, _) = target, type.usesNameOnID, nameOnID.isEmpty,
              let name = environment.personalDetails.detail(.name)?.display.nilIfBlank else { return }
        nameOnID = name
        nameFromDetails = true
    }

    // MARK: - Save

    private var canSave: Bool {
        switch target {
        case .newSignIn:
            return !cleanedSite.isEmpty && !trimmed(username).isEmpty && !password.isEmpty
        case .newID:
            return !trimmed(number).isEmpty
        case .newDateOfBirth:
            return birthDate != nil
        case .newKey:
            return !trimmed(label).isEmpty && !cleanedSite.isEmpty && !trimmed(key).isEmpty
        case .replace(_, let field):
            return replacement(for: field) != nil
        case .addSite:
            return !cleanedSite.isEmpty
        }
    }

    private func trimmed(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The new value of a replaced field, as the server takes it.
    private func replacement(for field: String) -> JSONValue? {
        switch field {
        case "password": return password.isEmpty ? nil : .string(password)
        case "key": return trimmed(key).nilIfBlank.map(JSONValue.string)
        case "username": return trimmed(username).nilIfBlank.map(JSONValue.string)
        case "number": return trimmed(number).nilIfBlank.map(JSONValue.string)
        case "expires": return expires.map { .string(FormValidation.isoString($0)) }
        case "date": return birthDate.map { .string(FormValidation.isoString($0)) }
        case "name_on_id": return trimmed(nameOnID).nilIfBlank.map(JSONValue.string)
        default: return trimmed(number).nilIfBlank.map(JSONValue.string)
        }
    }

    private func looksLikeCard(_ text: String) -> Bool {
        let digits = text.filter(\.isNumber)
        return digits.count >= 13 && digits.count <= 19 && SecureDraftScan.cardNetwork(digits) && SecureDraftScan.luhn(digits)
    }

    private func validate() -> [String: String] {
        var errors: [String: String] = [:]
        switch target {
        case .newSignIn:
            if cleanedSite.isEmpty {
                errors["site"] = SecureDetailsCopy.enterSite
            } else if !SecureSite.isPlausible(cleanedSite) {
                errors["site"] = SecureDetailsCopy.siteShape
            }
            if trimmed(username).isEmpty { errors["username"] = SecureDetailsCopy.enterUsername }
            if password.isEmpty { errors["password"] = SecureDetailsCopy.enterPassword }
        case .newID(let type, _):
            let digits = number.filter(\.isNumber)
            if trimmed(number).isEmpty {
                errors["number"] = SecureDetailsCopy.enterNumber
            } else if type == .ssn, digits.count != 9 {
                errors["number"] = SecureDetailsCopy.ssnDigits
            } else if looksLikeCard(number) {
                errors["number"] = SecureSaveError.cardLine
            }
            if type == .driversLicense || type == .stateID, trimmed(region).isEmpty {
                errors["region"] = SecureDetailsCopy.enterState
            }
            if type == .passport, trimmed(country).isEmpty {
                errors["country"] = SecureDetailsCopy.enterCountry
            }
        case .newDateOfBirth:
            if birthDate == nil { errors["date"] = SecureDetailsCopy.pickDate }
        case .newKey:
            if trimmed(label).isEmpty { errors["label"] = SecureDetailsCopy.enterName }
            if cleanedSite.isEmpty {
                errors["site"] = SecureDetailsCopy.enterHost
            } else if !SecureSite.isPlausible(cleanedSite) {
                errors["site"] = SecureDetailsCopy.hostShape
            }
            if trimmed(key).isEmpty {
                errors["key"] = SecureDetailsCopy.pasteKey
            } else if trimmed(key).count < 8 {
                errors["key"] = SecureDetailsCopy.keyShort
            }
        case .replace(_, let field):
            if replacement(for: field) == nil {
                errors[field] = "Enter the \(SecureFieldLabel.text(field).lowercasedFirst)."
            } else if field == "number", looksLikeCard(number) {
                errors[field] = SecureSaveError.cardLine
            }
        case .addSite(let item):
            if cleanedSite.isEmpty {
                errors["site"] = item.kind == .apiKey ? SecureDetailsCopy.enterHost : SecureDetailsCopy.enterSite
            } else if !SecureSite.isPlausible(cleanedSite) {
                errors["site"] = item.kind == .apiKey ? SecureDetailsCopy.hostShape : SecureDetailsCopy.siteShape
            } else if item.covers(host: cleanedSite) {
                errors["site"] = "This site is on the list already."
            }
        }
        return errors
    }

    private func save() async {
        errorLine = nil
        fieldErrors = validate()
        guard fieldErrors.isEmpty else {
            focus = fieldErrors.keys.sorted().first
            return
        }
        isSaving = true
        defer { isSaving = false }
        let transport = environment.backend
        do {
            switch target {
            case .newSignIn:
                let item = try await store.create(
                    kind: .signIn,
                    label: trimmed(label).nilIfBlank ?? cleanedSite,
                    sites: [cleanedSite],
                    values: ["username": .string(trimmed(username)), "password": .string(password)],
                    transport: transport
                )
                finish(with: item)
            case .newID(let type, _):
                var values: [String: JSONValue] = ["type": .string(type.rawValue), "number": .string(trimmed(number))]
                if type.usesRegion, let region = trimmed(region).nilIfBlank { values["region"] = .string(region.uppercased()) }
                if type.usesCountry, let country = trimmed(country).nilIfBlank { values["country"] = .string(country.uppercased()) }
                if type.usesExpiry, let expires { values["expires"] = .string(FormValidation.isoString(expires)) }
                if type.usesNameOnID, let name = trimmed(nameOnID).nilIfBlank { values["name_on_id"] = .string(name) }
                let item = try await store.create(kind: .idNumber, label: type.label, sites: [], values: values, transport: transport)
                finish(with: item)
            case .newDateOfBirth:
                guard let birthDate else { return }
                let item = try await store.create(
                    kind: .dateOfBirth,
                    label: nil,
                    sites: [],
                    values: ["date": .string(FormValidation.isoString(birthDate))],
                    transport: transport
                )
                finish(with: item)
            case .newKey:
                var values: [String: JSONValue] = ["key": .string(trimmed(key))]
                if let header = trimmed(header).nilIfBlank { values["header"] = .string(header) }
                let item = try await store.create(kind: .apiKey, label: trimmed(label), sites: [cleanedSite], values: values, transport: transport)
                finish(with: item)
            case .replace(let existing, let field):
                guard let value = replacement(for: field) else { return }
                let item = try await store.update(id: existing.id, values: [field: value], transport: transport)
                finish(with: item)
            case .addSite(let existing):
                await addSite(to: existing)
            }
        } catch let error as SecureSaveError {
            if let field = error.field {
                fieldErrors[field] = error.line
            } else {
                errorLine = error.line
            }
        } catch {
            errorLine = error.localizedDescription
        }
    }

    /// Adding a site needs the identity check: the window first, then the
    /// request, then one retry after a 403.
    private func addSite(to existing: SecureItemView) async {
        // The store's list, not the one captured when the sheet opened: a
        // site removed meanwhile must not come back.
        let current = store.item(id: existing.id)?.sites ?? existing.sites
        let sites = current.contains(cleanedSite) ? current : current + [cleanedSite]
        let reason = IdentityCheckCopy.addSiteReason(itemLabel: existing.label, noun: existing.kind.noun)
        var saved: SecureItemView?
        let outcome = await IdentityGuard.run(
            reason: reason,
            presenter: identity,
            windowOpen: { ClerkIdentity.windowIsOpen() }
        ) {
            saved = try await store.update(id: existing.id, sites: sites, transport: environment.backend)
        }
        switch outcome {
        case .done:
            if let saved { finish(with: saved) }
        case .cancelled:
            errorLine = IdentityCheckCopy.cancelledSite
        case .checkFailed:
            errorLine = IdentityCheckCopy.deviceFailedSite
        case .error(let error):
            errorLine = error.line
        }
    }

    private func finish(with item: SecureItemView) {
        finished = true
        onFinish(item)
        PlatformAccessibility.announce(SecureDetailsCopy.saved)
        dismiss()
    }

    private func cancel() {
        finished = true
        onFinish(nil)
        dismiss()
    }
}

// MARK: - Content types

// The sign-in fields name their AutoFill types on iOS, so the Passwords key
// in the keyboard bar fills from Apple Passwords and iOS never offers to
// invent a password (`.password`, not `.newPassword`). The Mac has
// `.username` and `.password` too; the other types have no Mac constant.
private extension View {
    @ViewBuilder func passwordContentType(_ on: Bool) -> some View {
        if on {
            textContentType(.password)
        } else {
            self
        }
    }

    @ViewBuilder func urlContentType() -> some View {
        #if os(iOS)
        textContentType(.URL)
        #else
        self
        #endif
    }

    @ViewBuilder func addressStateContentType() -> some View {
        #if os(iOS)
        textContentType(.addressState)
        #else
        self
        #endif
    }

    @ViewBuilder func nameContentType() -> some View {
        #if os(iOS)
        textContentType(.name)
        #else
        self
        #endif
    }
}
