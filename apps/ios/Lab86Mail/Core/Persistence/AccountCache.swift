import Foundation
import SwiftData

@ModelActor
actor AccountCache {
    private static let encoder = JSONEncoder()
    private static let decoder = JSONDecoder()

    func accounts(ownerID: String) throws -> [MobileAccount] {
        let descriptor = FetchDescriptor<CachedAccountRecord>(
            predicate: #Predicate { $0.ownerID == ownerID },
            sortBy: [SortDescriptor(\.email)]
        )
        return try modelContext.fetch(descriptor).compactMap { record in
            try? Self.decoder.decode(MobileAccount.self, from: record.capabilitiesData)
        }
    }

    func replace(ownerID: String, accounts: [MobileAccount]) throws {
        let descriptor = FetchDescriptor<CachedAccountRecord>(
            predicate: #Predicate { $0.ownerID == ownerID }
        )
        let existing = try modelContext.fetch(descriptor)
        let incomingIDs = Set(accounts.map(\.id))

        for record in existing where !incomingIDs.contains(record.accountID) {
            modelContext.delete(record)
        }

        let existingByID = Dictionary(uniqueKeysWithValues: existing.map { ($0.accountID, $0) })
        for account in accounts {
            let accountData = try Self.encoder.encode(account)
            if let record = existingByID[account.id] {
                record.email = account.email
                record.provider = account.provider.rawValue
                record.status = account.status.rawValue
                record.displayName = account.displayName
                record.capabilitiesData = accountData
                record.lastSyncedAt = account.sync.lastSyncedAt
                record.updatedAt = .now
            } else {
                modelContext.insert(
                    CachedAccountRecord(
                        ownerID: ownerID,
                        accountID: account.id,
                        email: account.email,
                        provider: account.provider.rawValue,
                        status: account.status.rawValue,
                        displayName: account.displayName,
                        capabilitiesData: accountData,
                        lastSyncedAt: account.sync.lastSyncedAt
                    )
                )
            }
        }
        try modelContext.save()
    }
}
