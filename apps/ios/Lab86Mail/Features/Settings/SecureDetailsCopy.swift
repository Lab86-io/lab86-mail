import Foundation

// The words of Passwords and IDs (docs/albatross-secure-store.md and
// docs/research/secure-store-ios-design-2026-10-07.md), in one place for the
// views and the copy tests. Sentence case, no "AI", no "confirm", no "verify".

enum SecureDetailsCopy {
    // MARK: The list

    static let title = "Passwords and IDs"
    static let intro = "Albatross uses these to sign in, to fill forms, and to call services. It never shows a saved value again. To change one, replace it."
    static let signInsFooter = "A sign-in works only on its site. Albatross types it on the sign-in page and never reads it back."
    static let idsFooter = "An ID works on the sites you allow. Albatross asks you the first time a site needs one."
    static let keysFooter = "A key works only on its host. Albatross sends it in the request and reads only the reply."
    static let refusalFooter = "Albatross does not keep card numbers, bank numbers, or two-factor codes yet. The shared browser's own sign-ins are under Trust, Signed-in sites."
    static let addSignIn = "Add a sign-in"
    static let addID = "Add an ID"
    static let addKey = "Add a key"
    static let add = "Add"
    static let saved = "Saved."
    static let deleted = "Deleted."
    static let notUsedYet = "Not used yet"
    static let dateOfBirthSaved = "Saved"
    static let checking = "Checking…"
    static let loadFailed = "Could not read your passwords and IDs."
    static let tryAgain = "Try again"
    static let opensDetails = "Opens the details"

    /// "Used Oct 5", or "Not used yet".
    static func usedLine(_ date: Date?, locale: Locale = .current) -> String {
        guard let date else { return notUsedYet }
        return "Used " + date.formatted(.dateTime.month(.abbreviated).day().locale(locale))
    }

    /// "2 sites", "1 site".
    static func sitesCount(_ count: Int) -> String {
        count == 1 ? "1 site" : "\(count) sites"
    }

    /// The second line of a row: the sites, the facts, and the masked hints.
    static func detailLine(_ item: SecureItemView) -> String {
        var parts: [String] = []
        switch item.kind {
        case .signIn:
            if !item.sites.isEmpty { parts.append(item.sites.joined(separator: " · ")) }
            if let username = item.hint("username") { parts.append(username) }
            parts.append(item.hint("password") ?? "••••")
        case .idNumber:
            if let place = item.place { parts.append(place) }
            if let number = item.hint("number") { parts.append(number) }
            if !item.sites.isEmpty { parts.append(sitesCount(item.sites.count)) }
        case .dateOfBirth:
            parts.append(dateOfBirthSaved)
            if !item.sites.isEmpty { parts.append(sitesCount(item.sites.count)) }
        case .apiKey:
            if !item.sites.isEmpty { parts.append(item.sites.joined(separator: " · ")) }
            if let key = item.hint("key") { parts.append(key) }
        }
        return parts.joined(separator: " · ")
    }

    /// What VoiceOver says for a row. A hint never reads as punctuation.
    static func accessibilityLabel(_ item: SecureItemView, locale: Locale = .current) -> String {
        var parts = [item.label]
        switch item.kind {
        case .signIn:
            parts.append(item.sites.isEmpty ? "sign-in" : "sign-in for \(item.sites.joined(separator: ", "))")
            parts.append("password saved")
        case .idNumber:
            if let place = item.place { parts.append(place) }
            if let number = item.hint("number") { parts.append(spoken(hint: number, field: "number")) }
            if !item.sites.isEmpty { parts.append(sitesCount(item.sites.count)) }
        case .dateOfBirth:
            parts.append("saved")
        case .apiKey:
            parts.append(item.sites.isEmpty ? "key" : "key for \(item.sites.joined(separator: ", "))")
            if let key = item.hint("key") { parts.append(spoken(hint: key, field: "key")) }
        }
        parts.append(usedLine(item.lastUsedAt, locale: locale).lowercased())
        return parts.joined(separator: ", ") + "."
    }

    /// "ends in 4, 8, 2, 1": the last four characters of a hint, one by one.
    static func spoken(hint: String, field: String) -> String {
        let characters = hint.filter { $0.isLetter || $0.isNumber }
        guard !characters.isEmpty else { return "\(field) saved" }
        return "\(field), ends in " + characters.suffix(4).map(String.init).joined(separator: ", ")
    }

    // MARK: The detail

    static let neverShown = "Albatross never shows a saved value. Replace it to change it."
    static let replace = "Replace"
    static let rename = "Rename"
    static let sitesTitle = "Sites"
    static let hostsTitle = "Hosts"
    static let addSite = "Add a site"
    static let addHost = "Add a host"
    static let remove = "Remove"
    static let noSitesYet = "No sites yet. Albatross asks you the first time a site needs this."
    static let lastSite = "A sign-in needs at least one site."
    static let lastHost = "A key needs at least one host."
    static let recentUses = "Recent uses"
    static let noUses = "No uses yet."
    static let usesFooter = "Albatross keeps 90 days of uses."
    static let showLess = "Show less"
    static let delete = "Delete"
    static let deleting = "Deleting…"
    /// The Mac row button; the ellipsis says a dialog follows.
    static let deleteEllipsis = "Delete…"
    static let type = "Type"
    static let state = "State"
    static let country = "Country"
    static let expires = "Expires"

    static func showAll(_ count: Int) -> String { "Show all \(count)" }

    /// "Every page of ny.gov".
    static func everyPage(_ site: String) -> String { "Every page of \(site)" }

    /// "Saved on Oct 2".
    static func savedOn(_ date: Date?, locale: Locale = .current) -> String {
        guard let date else { return "Saved" }
        return "Saved on " + date.formatted(.dateTime.month(.abbreviated).day().locale(locale))
    }

    static func sitesFooter(_ kind: SecureItemKind) -> String {
        switch kind {
        case .signIn: "Albatross signs in on these sites and nowhere else. Adding a site needs a recent sign-in."
        case .apiKey: "Albatross calls these hosts with the key and nowhere else. Adding a host needs a recent sign-in."
        case .idNumber, .dateOfBirth: "Albatross uses this on these sites without a question. It asks you on any other site. Adding a site needs a recent sign-in."
        }
    }

    static func deleteRow(_ kind: SecureItemKind) -> String {
        switch kind {
        case .signIn: "Delete this sign-in"
        case .idNumber: "Delete this ID"
        case .dateOfBirth: "Delete your date of birth"
        case .apiKey: "Delete this key"
        }
    }

    static func deleteTitle(_ item: SecureItemView) -> String {
        switch item.kind {
        case .signIn: "Delete the \(item.label) sign-in?"
        case .idNumber: "Delete your \(SecureItemLabel.inSentence(item.label))?"
        case .dateOfBirth: "Delete your date of birth?"
        case .apiKey: "Delete the \(item.label) key?"
        }
    }

    /// What stops when the item goes.
    static func deleteMessage(_ item: SecureItemView) -> String {
        let sites = item.sites
        switch item.kind {
        case .signIn:
            let site = sites.first ?? "its site"
            return "Albatross can no longer sign in to \(site) for you. A run that needs it stops and asks you."
        case .idNumber:
            guard let first = sites.first else { return "A form that needs it asks you." }
            let others = sites.count - 1
            let where_ = others == 0 ? first : "\(first) and \(others) other \(others == 1 ? "site" : "sites")"
            return "Albatross can no longer type it on \(where_). A form that needs it asks you."
        case .dateOfBirth:
            return "Albatross can no longer type it into forms or check an age rule."
        case .apiKey:
            let host = sites.first ?? "its host"
            return "Albatross can no longer call \(host) for you."
        }
    }

    // MARK: The sheets

    static let newSignIn = "New sign-in"
    static let newKey = "New key"
    static let dateOfBirth = "Date of birth"
    static let site = "Site"
    static let username = "Username"
    static let password = "Password"
    static let name = "Name"
    static let number = "Number"
    static let expiryDate = "Expiry date"
    static let nameOnID = "Name on the ID"
    static let host = "Host"
    static let key = "Key"
    static let header = "Header"
    static let show = "Show"
    static let hide = "Hide"
    static let fromTheRun = "From the run"
    static let fromYourDetails = "From your details"
    /// Under a site the model suggested in the chat (V12), until the user edits it.
    static let suggestedSite = "Albatross suggested this site. Check that it is the site where you sign in."
    static let suggestedHost = "Albatross suggested this site. Check that it is the API address of the service."
    static let optional = "Optional"
    static let set = "Set"
    static let save = "Save"
    static let saving = "Saving…"
    static let cancel = "Cancel"
    static let sitePrompt = "chase.com"
    static let usernamePrompt = "sam.rivera@example.com"
    static let ssnPrompt = "000-00-0000"
    static let statePrompt = "NY"
    static let hostPrompt = "api.openai.com"
    static let keyNamePrompt = "OpenAI"
    static let headerPrompt = "Authorization"
    static let headerHelp = "The request header that carries the key. Most services use Authorization."
    static let idFooter = "Type it exactly as it appears on the ID. Albatross asks you before it uses this on a new site."
    static let ssnFooter = "Type the nine digits. Albatross asks you before it uses this on a new site."
    static let dobFooter = "Albatross types this into forms. For an age rule, it knows only your age in years. It asks you before it uses this on a new site."
    static let replaceFooter = "The old value goes away when you save."
    static let addSiteFooter = "Albatross may use this item on the site without a question. This needs a recent sign-in."
    static let addHostFooter = "Albatross may call this host with the key. This needs a recent sign-in."
    static let siteCovers = "A site covers every page under it: chase.com covers secure.chase.com too."

    static func signInFooter(site: String) -> String {
        let site = site.nilIfBlank ?? "its site"
        return "Albatross types this on the sign-in page of \(site) and nowhere else. It never reads the password back."
    }

    static func keyFooter(host: String) -> String {
        let host = host.nilIfBlank ?? "its host"
        return "Albatross calls \(host) with this key from a run and reads only the reply. It never shows the key."
    }

    /// "Replace the password".
    static func replaceTitle(field: String) -> String {
        "Replace the \(SecureFieldLabel.text(field).lowercasedFirst)"
    }

    /// "Saved as secure.chase.com".
    static func savedAs(_ host: String) -> String { "Saved as \(host)" }

    /// "14 characters".
    static func characters(_ count: Int) -> String {
        count == 1 ? "1 character" : "\(count) characters"
    }

    /// "Ends 4821".
    static func ends(_ value: String) -> String? {
        let clean = value.filter { $0.isLetter || $0.isNumber }
        guard clean.count >= 4 else { return nil }
        return "Ends \(clean.suffix(4))"
    }

    /// "Ends f3a2 · 51 characters".
    static func keyCaption(_ value: String) -> String? {
        guard let tail = ends(value) else { return value.isEmpty ? nil : characters(value.count) }
        return "\(tail) · \(characters(value.count))"
    }

    // MARK: Validation

    static let enterSite = "Enter the site."
    static let siteShape = "Enter a site like chase.com."
    static let enterUsername = "Enter the username."
    static let enterPassword = "Enter the password."
    static let enterNumber = "Enter the number."
    static let ssnDigits = "A Social Security number has nine digits."
    static let enterState = "Enter the state."
    static let enterCountry = "Enter the country."
    static let enterName = "Enter the name."
    static let enterHost = "Enter the host."
    static let hostShape = "Enter a host like api.openai.com."
    static let pasteKey = "Paste the key."
    static let keyShort = "That is too short for a key."
    static let pickDate = "Pick the date."
    static let dateOfBirthExists = "Your date of birth is saved. Replace it there."
}
