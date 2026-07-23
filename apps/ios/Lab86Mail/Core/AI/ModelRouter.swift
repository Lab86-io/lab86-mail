import Foundation
import FoundationModels

enum ModelSource: String, Sendable {
    case onDevice = "On device"
    case server = "Lab86"
}

struct ModelAnswer: Sendable {
    let text: String
    let source: ModelSource
}

actor ModelRouter {
    private let tools: ToolClient

    init(tools: ToolClient) { self.tools = tools }

    func summarize(thread: ThreadRoute, content: String) async throws -> ModelAnswer {
        let model = SystemLanguageModel.default
        if case .available = model.availability, model.supportsLocale() {
            let session = LanguageModelSession(
                model: model,
                instructions: "Summarize email accurately and concisely. Preserve dates, decisions, requests, and commitments. Never invent facts."
            )
            let prompt = String(content.prefix(14_000))
            let response = try await session.respond(to: prompt)
            return ModelAnswer(text: response.content, source: .onDevice)
        }
        let response = try await tools.invoke(
            "summarize_thread",
            arguments: ["account": .string(thread.accountID), "threadId": .string(thread.threadID)]
        )
        return ModelAnswer(text: response["summary"]?.stringValue ?? "", source: .server)
    }

    func availabilityLabel() -> String {
        switch SystemLanguageModel.default.availability {
        case .available:
            "Apple Intelligence is ready"
        case .unavailable(.deviceNotEligible):
            "This device does not support the on-device model"
        case .unavailable(.appleIntelligenceNotEnabled):
            "Apple Intelligence is turned off"
        case .unavailable(.modelNotReady):
            "The on-device model is still downloading"
        @unknown default:
            "On-device model unavailable"
        }
    }
}

