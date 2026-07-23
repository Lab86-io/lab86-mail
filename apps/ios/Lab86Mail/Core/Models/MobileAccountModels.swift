import Foundation

enum MobileDomain: String, Codable, CaseIterable, Sendable {
    case accounts
    case mail
    case calendar
    case tasks
    case today
    case work
    case assistant
    case activity
}

enum ProviderKind: String, Codable, CaseIterable, Sendable {
    case google
    case microsoft
    case icloud
    case imap
}

enum ProviderConnectionStatus: String, Codable, Sendable {
    case connected
    case disconnected
    case error
}

enum AccountSyncStatus: String, Codable, Sendable {
    case idle
    case backfilling
    case syncing
    case ready
    case error
}

struct ProviderCapabilities: Codable, Equatable, Sendable {
    let mail: Bool
    let calendar: Bool
    let contacts: Bool
    let folders: Bool
    let labels: Bool
    let drafts: Bool
    let scheduledSend: Bool
    let push: Bool
    let search: Bool
    let unsupportedReason: String?
}

struct MobileAccountSyncState: Codable, Equatable, Sendable {
    let status: AccountSyncStatus
    let corpusReady: Bool
    let itemsSynced: Int?
    let lastSyncedAt: Date?
    let error: String?
}

struct MobileAccount: Identifiable, Codable, Equatable, Sendable {
    let id: String
    let email: String
    let provider: ProviderKind
    let status: ProviderConnectionStatus
    let displayName: String?
    let scopes: [String]
    let capabilities: ProviderCapabilities
    let sync: MobileAccountSyncState
}

struct MobileBootstrapUser: Codable, Equatable, Sendable {
    let id: String
    let email: String
    let name: String
    let imageURL: URL?
}

struct MobileNotificationSettings: Codable, Equatable, Sendable {
    let nativePushEnabled: Bool
    let newMailPushEnabled: Bool
    let eventSuggestionPushEnabled: Bool
    let eveningCheckinEnabled: Bool
}

struct MobileBootstrapSnapshot: Codable, Equatable, Sendable {
    let user: MobileBootstrapUser
    let accounts: [MobileAccount]
    let featureFlags: [String: Bool]
    let notificationSettings: MobileNotificationSettings
    let cursors: [MobileDomain: String]
    let serverTime: Date
}

enum AccountRepositoryError: LocalizedError, Sendable, Equatable {
    case configuration
    case ownerMismatch(expected: String, received: String)

    var errorDescription: String? {
        switch self {
        case .configuration:
            "The mobile API is not configured."
        case .ownerMismatch:
            "The server returned account data for a different signed-in user."
        }
    }
}
