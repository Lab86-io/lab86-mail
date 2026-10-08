import SwiftUI

// The allow card of an `allow_secure` handoff (docs/albatross-secure-store.md,
// V6; docs/research/secure-store-ios-design-2026-10-07.md, section 6): a run
// reached a site that is new for an ID or a date of birth. The question
// names the site; the reason names the host. "Allow once" and "Always on
// {site}" need the identity check; "Do not allow" needs none. The first
// answer is stored on the run (`next.allowAnswer`), so every device shows
// the same receipt. The owner supplies every action; the card never talks
// to the server.

/// How the answer of one allow goes on this device.
enum SecureAllowState: Equatable, Sendable {
    case idle
    case sending(SecureAllowScope)
    /// The check was cancelled: the buttons stay, with one quiet line.
    case cancelled
    /// This device could not do the check: the web, or "Do not allow".
    case checkFailed(String)
    case error(String)
    /// Sent, before the server echoes `allowAnswer`.
    case answered(SecureAllowScope)
}

/// The words of the card.
enum SecureAllowCopy {
    static let allowOnce = "Allow once"
    static let alwaysOnThisSite = "Always on this site"
    static let doNotAllow = "Do not allow"
    static let allowing = "Allowing…"
    static let sending = "Sending…"
    static let needsCheck = "An allow needs a recent sign-in."
    static let answered = "Answered."
    static let sendFailed = "Could not send your answer. Try again."
    /// A site longer than this falls back to "Always on this site".
    static let siteLengthLimit = 24

    /// "Always on ny.gov".
    static func always(site: String) -> String {
        site.count > siteLengthLimit ? alwaysOnThisSite : "Always on \(site)"
    }

    /// The question, which names the site: "Use your driver's license number on ny.gov?"
    static func title(_ request: SecureAllowRequest) -> String {
        switch request.kind {
        case .signIn:
            return "Use your \(request.itemLabel) sign-in on \(request.site)?"
        case .apiKey:
            return "Call \(request.host) with your \(request.itemLabel) key?"
        case .dateOfBirth:
            return "Use your date of birth on \(request.site)?"
        case .idNumber:
            let label = SecureItemLabel.inSentence(request.itemLabel)
            // "driver's license number", but not "Social Security number number".
            if request.fieldLabels.count == 1, !label.lowercased().hasSuffix(request.fieldLabels[0].lowercased()) {
                return "Use your \(label) \(request.fieldLabels[0].lowercased()) on \(request.site)?"
            }
            return "Use your \(label) on \(request.site)?"
        }
    }

    /// The reason, which names the host: "dmv.ny.gov asks for the number and the expiry date."
    static func reason(_ request: SecureAllowRequest) -> String {
        switch request.kind {
        case .signIn:
            return "\(request.host) asks you to sign in. Albatross types the saved username and password and never reads them."
        case .apiKey:
            return "Albatross sends the key in the request to \(request.host) and reads only the reply."
        case .dateOfBirth:
            return "\(request.host) asks for the date. Albatross types it and does not read it."
        case .idNumber:
            let fields = request.fieldLabels.map { "the \($0.lowercased())" }
            guard !fields.isEmpty else {
                return "\(request.host) asks for it. Albatross types it and does not read it."
            }
            let pronoun = fields.count == 1 ? "it" : "them"
            return "\(request.host) asks for \(joined(fields)). Albatross types \(pronoun) and does not read \(pronoun)."
        }
    }

    /// "Allowed once on ny.gov." / "Always allowed on ny.gov." / "Not allowed."
    static func receipt(_ scope: SecureAllowScope, site: String) -> String {
        switch scope {
        case .once: "Allowed once on \(site)."
        case .always: "Always allowed on \(site)."
        case .deny: "Not allowed."
        }
    }

    /// "a", "a and b", "a, b, and c".
    static func joined(_ parts: [String]) -> String {
        switch parts.count {
        case 0: return ""
        case 1: return parts[0]
        case 2: return "\(parts[0]) and \(parts[1])"
        default: return parts.dropLast().joined(separator: ", ") + ", and " + (parts.last ?? "")
        }
    }

    /// "Save a sign-in for chase.com, and the next run signs in by itself." (V13)
    static func saveSignInOffer(site: String) -> String {
        "Save a sign-in for \(site), and the next run signs in by itself."
    }

    static let saveSignIn = "Save a sign-in"
    static let signInSaved = "Saved. Press Continue, and Albatross signs in."
}

struct SecureAllowCard: View {
    @Environment(AppEnvironment.self) private var environment
    let request: SecureAllowRequest
    /// The server's record of the first answer.
    var answer: SecureAllowAnswerView? = nil
    var state: SecureAllowState = .idle
    var busy = false
    /// True when the session's first factor is under 10 minutes old: no
    /// warning line, because no sheet will come.
    var windowOpen = false
    var ownsWaitingShortcut = false
    let onAllow: (SecureAllowScope) -> Void
    let onOpenWeb: () -> Void

    private var settledScope: SecureAllowScope? {
        if let answer { return answer.scope }
        if case .answered(let scope) = state { return scope }
        return nil
    }

    private var isSending: Bool {
        if case .sending = state { return true }
        return false
    }

    private var isCancelled: Bool {
        if case .cancelled = state { return true }
        return false
    }

    private var failedMessage: String? {
        if case .checkFailed(let message) = state { return message }
        return nil
    }

    private var errorMessage: String? {
        if case .error(let message) = state { return message }
        return nil
    }

    var body: some View {
        QuestionShell(title: SecureAllowCopy.title(request)) {
            if let scope = settledScope {
                Text(SecureAllowCopy.receipt(scope, site: request.site))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                Text(SecureAllowCopy.reason(request))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let failedMessage {
                    Text(failedMessage)
                        .font(.footnote)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 12) {
                        Button(IdentityCheckCopy.openWeb, action: onOpenWeb)
                            .buttonStyle(.bordered)
                            .frame(minHeight: 44)
                        Spacer(minLength: 0)
                        denyButton
                    }
                } else {
                    if !windowOpen {
                        Text(SecureAllowCopy.needsCheck)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if isCancelled {
                        Text(IdentityCheckCopy.cancelledAllow)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 10) { grantButtons }
                        VStack(alignment: .leading, spacing: 10) { grantButtons }
                    }
                    denyButton
                    if let errorMessage {
                        Text(errorMessage)
                            .font(.footnote)
                            .foregroundStyle(.red)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder private var grantButtons: some View {
        Button(sendingLabel(for: .once) ?? SecureAllowCopy.allowOnce) { onAllow(.once) }
            .buttonStyle(.borderedProminent)
            .tint(environment.theme.accentColor)
            .disabled(busy || isSending)
            .waitingActionShortcut(ownsWaitingShortcut)
            .frame(minHeight: 44)
        Button(sendingLabel(for: .always) ?? SecureAllowCopy.always(site: request.site)) { onAllow(.always) }
            .buttonStyle(.bordered)
            .disabled(busy || isSending)
            .frame(minHeight: 44)
    }

    private var denyButton: some View {
        Button(sendingLabel(for: .deny) ?? SecureAllowCopy.doNotAllow) { onAllow(.deny) }
            .buttonStyle(.borderless)
            .font(.subheadline)
            .disabled(busy || isSending)
            .frame(minHeight: 44)
    }

    private func sendingLabel(for scope: SecureAllowScope) -> String? {
        guard case .sending(let sending) = state, sending == scope else { return nil }
        return scope == .deny ? SecureAllowCopy.sending : SecureAllowCopy.allowing
    }
}
