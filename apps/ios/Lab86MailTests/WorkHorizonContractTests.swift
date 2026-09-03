import Foundation
import MobileAPI
import Testing
@testable import Lab86Mail

// The horizon on the mobile v1 wire: the `workHorizon` sync change and the
// `work.setHorizon` durable command. `lib/mobile/v1/contract.ts` is the source.
struct WorkHorizonContractTests {
    private let november = Date(timeIntervalSince1970: 1_793_509_200) // 2026-11-01T05:00:00Z

    @Test
    func workHorizonSyncChangeDecodesToATypedPatch() throws {
        let millis = Int(november.timeIntervalSince1970 * 1_000)
        let envelope = try JSONDecoder().decode(
            Components.Schemas.SyncEnvelope.self,
            from: Data(
                """
                {"items":[
                  {"domain":"work","entityKind":"workHorizon","entityID":"work-1","revision":4,"operation":"upsert",
                   "payload":{"workID":"work-1","horizon":{"kind":"later","notBefore":\(millis),"label":"not before November"}}},
                  {"domain":"work","entityKind":"workHorizon","entityID":"work-2","revision":5,"operation":"upsert",
                   "payload":{"workID":"work-2","horizonCleared":true}}
                ],"deletedIDs":[],"cursor":"5","serverRevision":5,"hasMore":false}
                """.utf8
            )
        )

        let page = try MobileV1Client.syncPage(from: envelope, requestedDomain: .work)
        #expect(page.domain == .work)
        #expect(page.changes == [
            .workHorizon(
                WorkHorizonSyncPatch(
                    entityID: "work-1",
                    revision: 4,
                    workID: "work-1",
                    horizon: WorkHorizon(kind: .later, notBefore: november, label: "not before November"),
                    horizonCleared: false
                )
            ),
            .workHorizon(
                WorkHorizonSyncPatch(entityID: "work-2", revision: 5, workID: "work-2", horizon: nil, horizonCleared: true)
            ),
        ])
        #expect(page.changes.map(\.revision) == [4, 5])

        #expect(throws: MobileV1ClientError.invalidSyncPayload) {
            try MobileV1Client.syncPage(from: envelope, requestedDomain: .tasks)
        }
    }

    @Test
    func setHorizonCommandIsDurableAndCarriesExactlyOneShape() async throws {
        let container = MobilePersistence.makeContainer(inMemory: true)
        let outbox = CommandOutbox(modelContainer: container)
        let sleep = WorkSetHorizonCommandPayload(
            workID: "work-1",
            horizon: WorkHorizonCommandRequest(WorkHorizon(kind: .later, notBefore: november, label: "not before November"))
        )
        let clear = WorkSetHorizonCommandPayload(workID: "work-2", horizon: nil)
        #expect(sleep.horizonCleared == false)
        #expect(clear.horizonCleared)
        #expect(DurableMobileCommand.workSetHorizon(sleep).kind == .workSetHorizon)
        #expect(MobileCommandKind.workSetHorizon.rawValue == "work.setHorizon")

        _ = try await outbox.enqueue(ownerID: "user-one", command: .workSetHorizon(sleep), idempotencyKey: "h-1")
        _ = try await outbox.enqueue(ownerID: "user-one", command: .workSetHorizon(clear), idempotencyKey: "h-2")

        let pending = try await outbox.pending(ownerID: "user-one")
        #expect(pending.count == 2)
        guard case .workSetHorizon(let restored) = pending[0].command else {
            Issue.record("The first command did not restore as work.setHorizon.")
            return
        }
        #expect(restored == sleep)
        #expect(restored.horizon?.kind == .later)
        #expect(restored.horizon?.notBeforeAt == november)
        #expect(restored.horizon?.byAt == nil)
        guard case .workSetHorizon(let cleared) = pending[1].command else {
            Issue.record("The second command did not restore as work.setHorizon.")
            return
        }
        #expect(cleared == clear)
    }

    @Test
    func generatedSetHorizonCommandEncodesTheContractShape() throws {
        let command = Components.Schemas.WorkSetHorizonCommand(
            idempotencyKey: "h-1",
            baseRevision: nil,
            clientCreatedAt: november,
            kind: .work_setHorizon,
            payload: .init(
                workID: "work-1",
                horizon: .init(kind: .later, notBeforeAt: november, byAt: nil, label: "not before November"),
                horizonCleared: nil
            )
        )
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let object = try #require(
            JSONSerialization.jsonObject(with: encoder.encode(command)) as? [String: Any]
        )
        #expect(object["kind"] as? String == "work.setHorizon")
        let payload = try #require(object["payload"] as? [String: Any])
        #expect(payload["workID"] as? String == "work-1")
        #expect(payload["horizonCleared"] == nil)
        let horizon = try #require(payload["horizon"] as? [String: Any])
        #expect(horizon["kind"] as? String == "later")
        #expect(horizon["notBeforeAt"] as? String == "2026-11-01T05:00:00Z")
        #expect(horizon["byAt"] == nil)
    }
}
