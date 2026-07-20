import ClerkKit
import Foundation

enum ClerkConfiguration {
    static func options(for publishableKey: String) -> Clerk.Options {
        let requestMiddleware: [any ClerkRequestMiddleware]

        if publishableKey.hasPrefix("pk_test_") {
            // Clerk's development instance currently returns an invalid lcl.dev
            // WebAuthn relying-party ID. Cancel only passkey sign-in creation so
            // ClerkKitUI leaves email and phone authentication available without
            // presenting AuthenticationServices' domain-association error.
            requestMiddleware = [ClerkDevelopmentPasskeySafetyMiddleware()]
        } else {
            requestMiddleware = []
        }

        return Clerk.Options(
            middleware: .init(request: requestMiddleware)
        )
    }
}

struct ClerkDevelopmentPasskeySafetyMiddleware: ClerkRequestMiddleware {
    func prepare(_ request: inout URLRequest) async throws {
        guard Self.shouldCancel(request) else { return }

        // AuthStartView treats cancellation as an unavailable automatic
        // credential and intentionally does not surface its error sheet.
        throw CancellationError()
    }

    static func shouldCancel(_ request: URLRequest) -> Bool {
        guard request.httpMethod?.uppercased() == "POST",
              request.url?.path.hasSuffix("/v1/client/sign_ins") == true,
              request.value(forHTTPHeaderField: "Content-Type")?
                .lowercased()
                .contains("application/x-www-form-urlencoded") == true,
              let body = request.httpBody,
              let form = String(data: body, encoding: .utf8) else {
            return false
        }

        return formValue(named: "strategy", in: form) == "passkey"
    }

    private static func formValue(named name: String, in form: String) -> String? {
        for pair in form.split(separator: "&", omittingEmptySubsequences: false) {
            let components = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard let encodedName = components.first,
                  decodeFormComponent(String(encodedName)) == name else {
                continue
            }

            let encodedValue = components.count == 2 ? String(components[1]) : ""
            return decodeFormComponent(encodedValue)
        }

        return nil
    }

    private static func decodeFormComponent(_ value: String) -> String? {
        value
            .replacingOccurrences(of: "+", with: " ")
            .removingPercentEncoding
    }
}
