import Foundation
import Testing

@testable import Lab86Mail

// The Swift heuristic must agree with `lib/albatross/route-classifier.ts`.
// The phrases below are the ones the TypeScript suite asserts.
@Suite("Bar route")
struct BarRouteTests {
    @Test("A question mark always asks")
    func questionMarkAsks() {
        let verdict = RouteHeuristic.verdict(for: "book the dentist before the trip?")
        #expect(verdict?.route == .ask)
        #expect(verdict?.reason == "question mark")
    }

    @Test(
        "Questions and requests read as ask",
        arguments: [
            "what did Sarah say about the venue",
            "show me the invoices from June",
            "find the lease renewal",
            "summarize the thread with the landlord",
            "who is on the invite",
            "draft a reply to the accountant",
            "list my open tasks",
            "explain the change to the plan",
            "look up the flight time",
            "how much did we pay last year",
        ]
    )
    func asks(_ text: String) {
        #expect(RouteHeuristic.verdict(for: text)?.route == .ask)
    }

    @Test(
        "Commitments and errands read as hold",
        arguments: [
            "i need to renew the passport",
            "remind me to call the vet",
            "book the dentist",
            "hold this",
            "note to self: buy cat food",
            "we should cancel the storage unit",
            "renew the registration before the trip",
            "pay the water bill",
            "don't forget the dry cleaning",
            "lose fifteen pounds by spring",
        ]
    )
    func holds(_ text: String) {
        #expect(RouteHeuristic.verdict(for: text)?.route == .hold)
    }

    @Test("An enumerated list holds")
    func enumeratedHolds() {
        let verdict = RouteHeuristic.verdict(for: "movie list: Heat, Alien, Dune part two")
        #expect(verdict?.route == .hold)
        #expect(verdict?.reason == "enumerated list")
    }

    @Test("Bullet lines hold")
    func bulletsHold() {
        #expect(RouteHeuristic.looksEnumerated("- Heat\n- Alien"))
        #expect(RouteHeuristic.looksEnumerated("1. Heat\n2. Alien"))
        #expect(!RouteHeuristic.looksEnumerated("- Heat"))
    }

    @Test("A whole word must match")
    func wholeWordOnly() {
        // "i have to" must not match inside "i have tomorrow".
        #expect(!RouteHeuristic.includesAny("i have tomorrow free", ["i have to"]))
        #expect(RouteHeuristic.includesAny("i have to go", ["i have to"]))
    }

    @Test("Unclear text returns nothing")
    func unclearIsNil() {
        #expect(RouteHeuristic.verdict(for: "the venue") == nil)
    }

    @Test("Unclear text keeps the route the chip shows")
    func instantKeepsCurrent() {
        #expect(RouteHeuristic.instant("the venue", current: .hold).route == .hold)
        #expect(RouteHeuristic.instant("the venue", current: .ask).route == .ask)
    }

    @Test("Empty text asks")
    func emptyAsks() {
        #expect(RouteHeuristic.verdict(for: "   ")?.route == .ask)
        #expect(RouteHeuristic.verdict(for: "   ")?.confidence == 0)
    }

    @Test("A month name alone is a weak hold")
    func monthIsWeak() {
        let verdict = RouteHeuristic.verdict(for: "the passport in November")
        #expect(verdict?.route == .hold)
        #expect(verdict?.reason == "horizon phrase")
    }

    @Test("A pinned chip ignores the server")
    func pinnedIgnoresServer() {
        let hold = RouteVerdict(route: .hold, confidence: 0.9)
        #expect(!RoutePredictor.shouldAdopt(hold, pinned: true))
        #expect(RoutePredictor.shouldAdopt(hold, pinned: false))
    }

    @Test("A weak hold never flips the chip on its own")
    func weakHoldDoesNotFlip() {
        let weak = RouteVerdict(route: .hold, confidence: 0.4)
        #expect(!RoutePredictor.shouldAdopt(weak, pinned: false))
        let strong = RouteVerdict(route: .hold, confidence: 0.6)
        #expect(RoutePredictor.shouldAdopt(strong, pinned: false))
    }

    @Test("The fallback is ask with no confidence")
    func fallbackIsAsk() {
        #expect(RouteVerdict.askFallback.route == .ask)
        #expect(!RoutePredictor.shouldAdopt(.askFallback, pinned: false))
    }

    @Test("A route flips to the other one")
    func flip() {
        #expect(BarRoute.ask.flipped == .hold)
        #expect(BarRoute.hold.flipped == .ask)
        #expect(BarRoute.ask.word == "Ask")
        #expect(BarRoute.hold.word == "Hold")
    }

    @Test("The landing runs in 600 ms or less")
    func landingBudget() {
        // The design note gives 0 to 220, 220 to 340, and 340 to 600 ms.
        #expect(HoldPhase.total <= 0.6)
        #expect(HoldPhase.start(of: .collapse) == 0)
        #expect(HoldPhase.start(of: .hold) == HoldPhase.collapseDuration)
        #expect(HoldPhase.start(of: .travel) == HoldPhase.collapseDuration + HoldPhase.holdDuration)
    }

    @Test("A card reads the shape and the horizon")
    func cardLine() {
        let withHorizon = HoldCardModel(
            id: "w1",
            title: "Renew the passport",
            shapeWord: "Quick",
            horizonLine: "Back on Nov 1"
        )
        #expect(withHorizon.secondLine == "Quick · Back on Nov 1")
        let plain = HoldCardModel(id: "w2", title: "Book the dentist", shapeWord: "Quick", horizonLine: nil)
        #expect(plain.secondLine == "Quick")
    }
}
