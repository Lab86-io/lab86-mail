import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

// Apple on-device Foundation Models stand in for the hosted nano tier
// (classification + short summaries) when Apple Intelligence is available —
// zero marginal cost, zero mail content leaving the machine.

#if canImport(FoundationModels)

// Mirrors the server's llmCategory verdict shape (lib/mail/llm-classify.ts) so
// verdicts can be written back to Convex once the authenticated mutation
// lands (PLAN.md M6).
@Generable
struct OnDeviceVerdict {
    @Guide(description: "The single best category for this email.", .anyOf([
        "main", "needs_reply", "codes", "orders", "finance_admin", "noise", "review",
    ]))
    var primary: String

    @Guide(description: "True only if a human reply or action is clearly expected.")
    var needsAttention: Bool

    @Guide(description: "Confidence in the verdict from 0 to 1.")
    var confidence: Double
}

struct OnDeviceClassifier {
    static var isAvailable: Bool {
        SystemLanguageModel.default.availability == .available
    }

    func classify(subject: String, from: String, excerpt: String) async throws -> OnDeviceVerdict {
        let session = LanguageModelSession(instructions: """
            You triage emails into exactly one category:
            - main: real human correspondence that matters
            - needs_reply: a human is waiting on a reply from the user
            - codes: one-time passcodes, verification links, sign-in alerts
            - orders: receipts, shipping, delivery updates
            - finance_admin: invoices, statements, bills, taxes, account admin
            - noise: newsletters, promotions, automated bulk mail
            - review: uncertain — a human should look
            Judge by sender, subject, and body. Automated senders are never main.
            """)
        let prompt = """
            From: \(from)
            Subject: \(subject)
            Body (truncated): \(String(excerpt.prefix(2000)))
            """
        let response = try await session.respond(to: prompt, generating: OnDeviceVerdict.self)
        return response.content
    }
}

struct OnDeviceSummarizer {
    static var isAvailable: Bool {
        SystemLanguageModel.default.availability == .available
    }

    func summarize(detail: ThreadDetail) async throws -> String {
        let session = LanguageModelSession(instructions: """
            Summarize email threads in 2-3 plain sentences. Lead with what the
            thread is about, then what (if anything) the reader needs to do.
            No preamble, no bullet points.
            """)
        // Newest messages matter most; keep the prompt inside the context window.
        let excerpt = detail.messages.suffix(6).map { message in
            let body = message.textBody.isEmpty ? message.snippet : message.textBody
            return "[\(message.fromDisplay)] \(String(body.prefix(1200)))"
        }.joined(separator: "\n---\n")
        let response = try await session.respond(
            to: "Subject: \(detail.subject)\n\n\(excerpt)")
        return response.content
    }
}

#else

// Non-Apple-Intelligence fallback so the target still compiles if the
// framework is unavailable; callers check isAvailable before use.
struct OnDeviceClassifier {
    static var isAvailable: Bool { false }
}

struct OnDeviceSummarizer {
    static var isAvailable: Bool { false }
    func summarize(detail: ThreadDetail) async throws -> String {
        throw NSError(domain: "Lab86Mail", code: 1, userInfo: [
            NSLocalizedDescriptionKey: "On-device models unavailable on this Mac.",
        ])
    }
}

#endif
