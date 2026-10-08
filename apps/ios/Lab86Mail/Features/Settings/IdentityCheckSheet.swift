import ClerkKit
import SwiftUI

// The identity check sheet (docs/research/secure-store-ios-design-2026-10-07.md,
// section 5): one more check before a saved value goes to a new place. It
// drives the clerk-ios session verification: a passkey when the account has
// one, else an email code, else a phone code, else the password; a second
// factor step when the account has one. After a pass it asks the SDK for a
// fresh token, so the next request carries the new claim. Clerk ships no
// sheet for this on iOS, so this is ours.

/// The SDK side of the window: the cached token, and the fresh one after a pass.
@MainActor
enum ClerkIdentity {
    static func cachedToken(clerk: Clerk = .shared) -> String? {
        clerk.session?.lastActiveToken?.jwt
    }

    /// True when the cached token says the first factor is under 10 minutes old.
    static func windowIsOpen(clerk: Clerk = .shared, now: Date = .now) -> Bool {
        guard let token = cachedToken(clerk: clerk) else { return false }
        return IdentityWindow.isOpen(token: token, now: now)
    }

    /// The SDK keeps the old token after a pass; the next request needs the new claim.
    static func refreshToken(clerk: Clerk = .shared) async {
        guard let session = clerk.session else { return }
        _ = try? await session.getToken(.init(skipCache: true))
    }
}

/// The words of the sheet.
enum IdentityCheckSheetCopy {
    static let oneMoment = "One moment."
    static let passkey = "Use your passkey to continue."
    static let sendCodeInstead = "Send a code instead"
    static let totp = "Enter the code from your authenticator app."
    static let password = "Enter your Albatross password."
    static let codeField = "Code"
    static let passwordField = "Password"
    static let sendAgain = "Send the code again"
    static let sent = "Sent."
    static let continueButton = "Continue"
    static let busy = "Checking…"
    static let codeWrong = "That code did not work. Check it and try again."
    static let passwordWrong = "That password did not work. Try again."
    static let sendFailed = "Could not send the code. Try again."

    /// "Enter the code Albatross sent to s•••@example.com."
    static func code(sentTo: String) -> String {
        "Enter the code Albatross sent to \(sentTo)."
    }
}

/// The steps of the check, and the SDK calls behind them.
@MainActor
@Observable
final class IdentityCheckModel {
    enum Step: Equatable, Sendable {
        case starting
        case passkey
        /// An email or phone code. `second` is the MFA phone code.
        case code(sentTo: String, second: Bool)
        case totp
        case password
    }

    private(set) var step: Step = .starting
    var code = ""
    var password = ""
    private(set) var errorLine: String?
    private(set) var busy = false
    private(set) var resent = false
    private var emailFactor: Factor?
    private var phoneFactor: Factor?
    private var hasPassword = false
    private var codeIsPhone = false
    private var wrongAttempts = 0

    static let attemptLimit = 3

    var canSubmit: Bool {
        guard !busy else { return false }
        switch step {
        case .code, .totp: return code.trimmingCharacters(in: .whitespaces).count >= 4
        case .password: return !password.isEmpty
        case .starting, .passkey: return false
        }
    }

    var instruction: String {
        switch step {
        case .starting: IdentityCheckSheetCopy.oneMoment
        case .passkey: IdentityCheckSheetCopy.passkey
        case .code(let sentTo, _): IdentityCheckSheetCopy.code(sentTo: sentTo)
        case .totp: IdentityCheckSheetCopy.totp
        case .password: IdentityCheckSheetCopy.password
        }
    }

    /// Starts the verification. Returns a result when the check ended at
    /// once (a passkey passed, or this device cannot do it); nil when the
    /// sheet waits for a code or a password.
    func start() async -> IdentityCheckResult? {
        guard let session = Clerk.shared.session else { return .failed(IdentityCheckCopy.deviceFailed) }
        busy = true
        defer { busy = false }
        let verification: SessionVerification
        do {
            verification = try await session.startVerification(level: .firstFactor)
        } catch {
            return .failed(IdentityCheckCopy.deviceFailed)
        }
        if verification.status == .complete {
            await ClerkIdentity.refreshToken()
            return .passed
        }
        let factors = verification.supportedFirstFactors ?? []
        emailFactor = factors.first { $0.strategy == .emailCode && $0.primary == true }
            ?? factors.first { $0.strategy == .emailCode }
        phoneFactor = factors.first { $0.strategy == .phoneCode }
        hasPassword = factors.contains { $0.strategy == .password }
        if factors.contains(where: { $0.strategy == .passkey }) {
            step = .passkey
            do {
                let result = try await session.verifyWithPasskey()
                return await settle(result)
            } catch {
                // The system sheet was cancelled or failed: a code instead.
                return await sendFirstCode()
            }
        }
        return await sendFirstCode()
    }

    /// "Send a code instead", from the passkey step.
    func useCodeInstead() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        if let result = await sendFirstCode(), case .failed(let message) = result {
            errorLine = message
        }
    }

    /// Sends the current code again.
    func sendAgain() async {
        guard !busy, case .code(_, let second) = step else { return }
        busy = true
        defer { busy = false }
        guard let session = Clerk.shared.session else { return }
        do {
            if second, let phone = phoneFactor, let id = phone.phoneNumberId {
                _ = try await session.sendMfaPhoneCode(phoneNumberId: id)
            } else if codeIsPhone, let phone = phoneFactor, let id = phone.phoneNumberId {
                _ = try await session.sendPhoneCode(phoneNumberId: id)
            } else if let email = emailFactor, let id = email.emailAddressId {
                _ = try await session.sendEmailCode(emailAddressId: id)
            }
            resent = true
            errorLine = nil
        } catch {
            errorLine = IdentityCheckSheetCopy.sendFailed
        }
    }

    /// "Continue". Returns the result when the check ended; nil when the
    /// sheet goes on (a second factor, or a wrong code).
    func submit() async -> IdentityCheckResult? {
        guard canSubmit, let session = Clerk.shared.session else { return nil }
        busy = true
        defer { busy = false }
        errorLine = nil
        let entered = code.trimmingCharacters(in: .whitespaces)
        do {
            let result: SessionVerification
            switch step {
            case .code(_, let second):
                if second {
                    result = try await session.verifyWithMfaPhoneCode(code: entered)
                } else if codeIsPhone {
                    result = try await session.verifyWithPhoneCode(code: entered)
                } else {
                    result = try await session.verifyWithEmailCode(code: entered)
                }
            case .totp:
                result = try await session.verifyWithTOTP(code: entered)
            case .password:
                result = try await session.verifyWithPassword(password)
            case .starting, .passkey:
                return nil
            }
            return await settle(result)
        } catch {
            wrongAttempts += 1
            if wrongAttempts >= Self.attemptLimit { return .cancelled }
            errorLine = step == .password ? IdentityCheckSheetCopy.passwordWrong : IdentityCheckSheetCopy.codeWrong
            return nil
        }
    }

    // MARK: - Private

    private func sendFirstCode() async -> IdentityCheckResult? {
        guard let session = Clerk.shared.session else { return .failed(IdentityCheckCopy.deviceFailed) }
        do {
            if let email = emailFactor, let id = email.emailAddressId {
                _ = try await session.sendEmailCode(emailAddressId: id)
                codeIsPhone = false
                step = .code(sentTo: email.safeIdentifier ?? "your email", second: false)
                return nil
            }
            if let phone = phoneFactor, let id = phone.phoneNumberId {
                _ = try await session.sendPhoneCode(phoneNumberId: id)
                codeIsPhone = true
                step = .code(sentTo: phone.safeIdentifier ?? "your phone", second: false)
                return nil
            }
        } catch {
            return .failed(IdentityCheckCopy.deviceFailed)
        }
        if hasPassword {
            step = .password
            return nil
        }
        return .failed(IdentityCheckCopy.deviceFailed)
    }

    private func settle(_ verification: SessionVerification) async -> IdentityCheckResult? {
        switch verification.status {
        case .complete:
            await ClerkIdentity.refreshToken()
            return .passed
        case .needsSecondFactor:
            let seconds = verification.supportedSecondFactors ?? []
            code = ""
            errorLine = nil
            // The second code can be sent again on its own.
            resent = false
            if seconds.contains(where: { $0.strategy == .totp }) {
                step = .totp
                return nil
            }
            if let phone = seconds.first(where: { $0.strategy == .phoneCode }), let id = phone.phoneNumberId,
               let session = Clerk.shared.session {
                do {
                    _ = try await session.sendMfaPhoneCode(phoneNumberId: id)
                } catch {
                    return .failed(IdentityCheckCopy.deviceFailed)
                }
                phoneFactor = phone
                step = .code(sentTo: phone.safeIdentifier ?? "your phone", second: true)
                return nil
            }
            return .failed(IdentityCheckCopy.deviceFailed)
        default:
            errorLine = IdentityCheckSheetCopy.codeWrong
            return nil
        }
    }
}

/// The sheet: the reason, one instruction, one field, Cancel and Continue.
struct IdentityCheckSheet: View {
    let request: IdentityCheckRequest
    let onFinish: (IdentityCheckResult) -> Void

    @State private var model = IdentityCheckModel()
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(request.reason)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(model.instruction)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Section {
                    control
                } footer: {
                    Text(IdentityCheckCopy.footer)
                }
                if let line = model.errorLine {
                    Section {
                        Text(line)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle(IdentityCheckCopy.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(SecureDetailsCopy.cancel) { onFinish(.cancelled) }
                        .disabled(model.busy)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(model.busy ? IdentityCheckSheetCopy.busy : IdentityCheckSheetCopy.continueButton) {
                        Task { await submit() }
                    }
                    .disabled(!model.canSubmit)
                }
            }
        }
        .interactiveDismissDisabled(model.busy)
        .task {
            if let result = await model.start() {
                onFinish(result)
            } else {
                focused = true
            }
        }
        #if os(iOS)
        .presentationDetents([.medium, .large])
        #endif
    }

    @ViewBuilder private var control: some View {
        switch model.step {
        case .starting:
            ProgressView()
        case .passkey:
            HStack {
                ProgressView()
                Spacer()
                Button(IdentityCheckSheetCopy.sendCodeInstead) {
                    Task { await model.useCodeInstead() }
                }
                .disabled(model.busy)
            }
        case .code, .totp:
            TextField(IdentityCheckSheetCopy.codeField, text: $model.code)
                .focused($focused)
                .textContentType(.oneTimeCode)
                .keyboardType(.numberPad)
                .autocorrectionDisabled()
                .onSubmit { Task { await submit() } }
            if case .code = model.step {
                Button(model.resent ? IdentityCheckSheetCopy.sent : IdentityCheckSheetCopy.sendAgain) {
                    Task { await model.sendAgain() }
                }
                .disabled(model.busy || model.resent)
            }
        case .password:
            SecureField(IdentityCheckSheetCopy.passwordField, text: $model.password)
                .focused($focused)
                .textContentType(.password)
                .onSubmit { Task { await submit() } }
        }
    }

    private func submit() async {
        if let result = await model.submit() {
            onFinish(result)
        }
    }
}

extension View {
    /// Mounts the check sheet for a presenter. A host mounts it once, on the
    /// view that is on top when the check can happen (a sheet presents from
    /// the sheet it is in).
    func identityCheckSheet(_ presenter: IdentityCheckPresenter) -> some View {
        sheet(item: Binding(
            get: { presenter.request },
            set: { if $0 == nil { presenter.cancel() } }
        )) { request in
            IdentityCheckSheet(request: request) { result in presenter.finish(result) }
            #if os(macOS)
                // A Mac sheet takes the size of its content, and a form gives
                // it almost none; the grouped style keeps the labels whole.
                .macFormSheet(.editor)
            #endif
        }
    }
}
