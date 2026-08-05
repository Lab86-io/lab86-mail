import Foundation
import Testing
@testable import Lab86Mail

// The outcome contract and its proof. The rule that matters is the clamp: a
// confirmed receipt is not a confirmed outcome while the contract still has
// conditions outstanding. `tests/albatross-contract.test.ts` pins the same rule
// for the web, so the two clients cannot disagree about whether a thing is done.
struct OutcomeContractTests {
    private func detail(
        contract: JSONValue?,
        evidence: [JSONValue] = []
    ) -> WorkDetail {
        var payload: [String: JSONValue] = [
            "work": .object([
                "_id": .string("work_1"),
                "title": .string("Set up a gold allocation"),
            ]),
            "evidence": .array(evidence),
        ]
        if let contract { payload["contract"] = contract }
        return WorkDetail(json: .object(payload))!
    }

    private func proof(_ id: String, _ what: String, satisfiedAt: Double? = nil) -> JSONValue {
        var row: [String: JSONValue] = ["id": .string(id), "what": .string(what)]
        if let satisfiedAt { row["satisfiedAt"] = .number(satisfiedAt) }
        return .object(row)
    }

    private func evidenceRow(
        _ id: String,
        trust: String,
        claim: String? = nil,
        sourceKind: String = "mail_thread"
    ) -> JSONValue {
        var row: [String: JSONValue] = [
            "id": .string(id),
            "title": .string("A reply from the broker"),
            "trust": .string(trust),
            "sourceKind": .string(sourceKind),
        ]
        if let claim { row["claim"] = .string(claim) }
        return .object(row)
    }

    // MARK: The clamp

    @Test func confirmedProofDoesNotCloseAContractWithConditionsLeft() {
        let subject = detail(
            contract: .object([
                "outcome": .string("The allocation is placed"),
                "closeWhen": .string("outcome_confirmed"),
                "proofs": .array([
                    proof("p1", "The ETF order fills", satisfiedAt: 1_754_000_000_000),
                    proof("p2", "The physical is in the vault"),
                ]),
            ]),
            evidence: [evidenceRow("e1", trust: "confirmed", claim: "The ETF order filled")]
        )
        // One receipt is not the whole outcome. Saying "done" here is the exact
        // lie the contract exists to prevent.
        #expect(subject.proofStanding == .partly)
    }

    @Test func nothingSettledYetSaysSoRatherThanStayingSilent() {
        let subject = detail(
            contract: .object([
                "outcome": .string("The allocation is placed"),
                "closeWhen": .string("outcome_confirmed"),
                "proofs": .array([proof("p1", "The ETF order fills")]),
            ])
        )
        #expect(subject.proofStanding == .nothingYet)
    }

    @Test func aContractThatNeverClosesAloneStillWaitsOnTheUser() {
        let subject = detail(
            contract: .object([
                "outcome": .string("Choose a school"),
                "closeWhen": .string("never_automatically"),
                "proofs": .array([proof("p1", "A place is accepted", satisfiedAt: 1_754_000_000_000)]),
            ]),
            evidence: [evidenceRow("e1", trust: "confirmed")]
        )
        #expect(subject.proofStanding == .waitingOnYou)
    }

    @Test func everyConditionMetAndConfirmedReadsAsDone() {
        let subject = detail(
            contract: .object([
                "outcome": .string("The invoice is paid"),
                "closeWhen": .string("outcome_confirmed"),
                "proofs": .array([proof("p1", "A payment receipt arrives", satisfiedAt: 1_754_000_000_000)]),
            ]),
            evidence: [evidenceRow("e1", trust: "confirmed")]
        )
        #expect(subject.proofStanding == .confirmed)
    }

    @Test func ruledOutProofCountsForNothing() {
        let subject = detail(
            contract: nil,
            evidence: [evidenceRow("e1", trust: "rejected", claim: "Looked paid")]
        )
        #expect(subject.proofStanding == .none)
    }

    @Test func inferredProofSaysItOnlyLooksDone() {
        // "Looks done" and "Confirmed done" are different promises. Collapsing
        // them is how a system starts lying politely.
        let subject = detail(contract: nil, evidence: [evidenceRow("e1", trust: "inferred")])
        #expect(subject.proofStanding == .likely)
    }

    @Test func observedProofClaimsNothingMoreThanThatSomethingHappened() {
        let subject = detail(contract: nil, evidence: [evidenceRow("e1", trust: "observed")])
        #expect(subject.proofStanding == .seen)
    }

    // MARK: What the card says out loud

    @Test func statusLineCountsWhatIsLeftInWords() {
        let contract = WorkDetail.Contract(
            outcome: "The allocation is placed",
            proofs: [
                .init(id: "a", what: "The ETF order fills", satisfiedBy: nil, satisfiedAt: Date()),
                .init(id: "b", what: "The physical is in the vault", satisfiedBy: nil, satisfiedAt: nil),
            ],
            closeWhen: "outcome_confirmed"
        )
        #expect(contract.statusLine == "One thing left to settle this.")
        #expect(contract.closeWhenLabel == "Only when something confirms it")
    }

    @Test func aSingleOutstandingConditionReadsAsASentence() {
        // Live defect: with one proof and none met, the count branch matched
        // first and printed "any of the 1 things this needs".
        let contract = WorkDetail.Contract(
            outcome: "The invoice is paid",
            proofs: [.init(id: "a", what: "A receipt arrives", satisfiedBy: nil, satisfiedAt: nil)],
            closeWhen: "outcome_confirmed"
        )
        #expect(contract.statusLine == "Nothing has settled this yet.")
    }

    @Test func standingIsAStateNotASentence() {
        // The views test this to pick colour and to decide whether a contract
        // may close. A copy edit must not be able to change behaviour.
        #expect(WorkDetail.ProofStanding.confirmed.isConfirmed)
        for standing in [
            WorkDetail.ProofStanding.none, .seen, .likely, .nothingYet, .partly, .waitingOnYou,
        ] {
            #expect(!standing.isConfirmed)
            #expect(!standing.label.isEmpty)
        }
    }

    @Test func aContractWithNoNamedProofAdmitsIt() {
        let contract = WorkDetail.Contract(outcome: "Get healthier", proofs: [], closeWhen: "outcome_likely")
        #expect(contract.statusLine == "Nothing named yet that would settle this.")
    }

    @Test func evidenceNamesItsSourceInPlainWords() {
        let mail = WorkDetail.Evidence(
            id: "e1", title: "Reply", summary: nil, claim: nil, limits: nil, url: nil,
            sourceKind: "mail_thread", occurredAt: nil, trust: "reported"
        )
        #expect(mail.sourceLabel == "An email")
        #expect(!mail.isConfirmed)
        #expect(!mail.isRejected)
    }
}
