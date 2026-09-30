import Foundation
import Testing

@testable import Lab86Mail

// The Swift heuristic must agree with `lib/albatross/route-rules.ts`.
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

// The shared cases of `tests/albatross-route-classifier.test.ts`. Both
// classifiers must give the same route for each phrase. Change the two files
// together.
enum RouteParityCases {
    static let asks = [
        "what did Sarah say about the venue?",
        "what did Sarah say about the venue",
        "show me the last email from Alex",
        "find the invoice from March",
        "who is coming to the dinner on Friday",
        "when is my next flight",
        "where did we land on the contract",
        "why did the deploy fail",
        "how many meetings do I have tomorrow",
        "which thread has the venue quote",
        "did the passport arrive",
        "is the dentist confirmed",
        "are we still on for lunch",
        "can you summarize the board thread",
        "could you draft a reply to Dana",
        "tell me about the Acme renewal",
        "summarize my inbox",
        "explain the difference between the two quotes",
        "pull up the thread with Marco",
        "open the latest message from HR",
        "draft a note to the landlord about the leak",
        "write a short reply that says yes",
        "search for the hotel confirmation",
        "look up the flight number",
        "list my meetings for tomorrow",
        "give me the top three unread threads",
        "I need to know what Sarah said about the venue?",
        "how much did we pay for the venue",
        "does Alex know about the date change",
        "compare the two insurance offers",
    ]

    static let holds = [
        "book the dentist before the trip",
        "I need to renew the passport, but not before November",
        "remind me to call mom on Sunday",
        "I have to file the taxes by Friday",
        "renew the car registration",
        "pay the electric bill",
        "buy a gift for Dana",
        "cancel the gym membership",
        "sign up for the pottery class",
        "submit the expense report",
        "Movie list: Heat, Alien, Dune part two",
        "lose fifteen pounds by spring",
        "ship the Albatross Mac app",
        "hold this",
        "keep this as work",
        "remember to water the plants",
        "note to self: ask Priya about the budget",
        "I should clean the garage this weekend",
        "I want to learn Portuguese",
        "we need to replace the roof next year",
        "call the plumber tomorrow",
        "pick up the dry cleaning",
        "fix the bike brakes",
        "finish the grant application by the end of the month",
        "don't forget the passport photos",
        "someday visit Kyoto",
        "apply for the residency permit",
        "order new running shoes",
        "groceries:\n- milk\n- eggs\n- bread",
        "1. renew passport\n2. book flights\n3. reserve hotel",
    ]

    // WRK-6: contractions, curly apostrophes, and "may".
    static let contractionAsks = [
        "what’s on my calendar tomorrow",
        "what's on my calendar tomorrow",
        "when’s my flight next week",
        "who’s coming on friday",
        "may i see the invoice",
        "may we move the call to next week",
    ]

    static let contractionHolds = [
        "renew the passport in may",
        "book the cabin by may 12",
        "don’t forget to pay the rent",
        "i’m going to finish the deck this weekend",
    ]

    // An imperative that acts on mail, events, contacts, files, or tasks is
    // Ask, also with a date in it.
    static let appActions = [
        #"Archive the message "Board meeting materials for October 9""#,
        "Label the “Q3 offsite, October 9” thread as Offsite",
        #"Accept the "Board prep sync" invitation on Friday."#,
        #"Cancel "Board prep sync" tomorrow"#,
        "Create an event on October 9 at 3pm called Offsite",
        "Move the October 9 board meeting to October 10",
        "Mark the email from Dana as unread",
        "mark it as read by tomorrow",
        "Forward the October 9 minutes to Priya",
        "Delete the calendar event next week",
        "Cancel the meeting with Sam tomorrow",
        "Decline the invite for next week",
        "Please trash the newsletters from last month",
        "Add a task to the Offsite board for October 9",
        "RSVP yes to the October 9 dinner",
        "Reply to Dana by Friday",
        #"Rename the file "Budget October 9" to Budget"#,
        "Send the October 9 deck to Dana",
        "Snooze the thread from Dana until Monday",
    ]

    // Real deferrals stay Hold, also when they name an app action.
    static let deferrals = [
        "remind me on October 9 to send the board materials",
        "Remind me on October 9 to archive the board email",
        "Remind me on October 9 to send the board slides.",
        "hold this until Friday",
        "follow up next week about the contract",
        "follow up next week about the invoice",
        "Follow up with Dana on October 9 about the offsite",
        "Send flowers to mom on October 9",
        "Delete my old Facebook account next week",
        "cancel the gym membership",
        "file the taxes by Friday",
        "I need to archive the October 9 email",
        "schedule the car service by Friday",
    ]
}

@Suite("Bar route parity with the web")
struct BarRouteParityTests {
    @Test("The web ask phrases read as ask", arguments: RouteParityCases.asks)
    func webAsks(_ text: String) throws {
        let verdict = try #require(RouteHeuristic.verdict(for: text))
        #expect(verdict.route == .ask)
        #expect(verdict.confidence >= 0.6)
    }

    @Test("The web hold phrases read as hold", arguments: RouteParityCases.holds)
    func webHolds(_ text: String) throws {
        let verdict = try #require(RouteHeuristic.verdict(for: text))
        #expect(verdict.route == .hold)
        #expect(verdict.confidence >= 0.6)
    }

    @Test("A question mark wins over hold words")
    func questionMarkWins() {
        #expect(RouteHeuristic.verdict(for: "should I renew the passport before the trip?")?.route == .ask)
        #expect(RouteHeuristic.verdict(for: "remind me, did I book the dentist?")?.route == .ask)
    }

    @Test("Explicit hold words win over ask words")
    func explicitHoldWins() {
        let verdict = RouteHeuristic.verdict(for: "can you remind me to renew the passport")
        #expect(verdict?.route == .hold)
        #expect(verdict?.confidence == 0.95)
    }

    @Test("Mixed or absent signals return nothing")
    func mixedIsNil() {
        #expect(RouteHeuristic.verdict(for: "I need to know what Sarah said about the venue") == nil)
        #expect(RouteHeuristic.verdict(for: "the venue") == nil)
        #expect(RouteHeuristic.verdict(for: "Sarah and the budget") == nil)
    }

    @Test("Empty text is ask with confidence zero")
    func emptyText() {
        #expect(RouteHeuristic.verdict(for: "") == RouteVerdict(route: .ask, confidence: 0, reason: "empty"))
        #expect(RouteHeuristic.verdict(for: "   ") == RouteVerdict(route: .ask, confidence: 0, reason: "empty"))
    }

    @Test("Bullets, numbers, and comma lists after a colon are lists")
    func enumeration() {
        #expect(RouteHeuristic.looksEnumerated("- one\n- two"))
        #expect(RouteHeuristic.looksEnumerated("1. one\n2) two"))
        #expect(RouteHeuristic.looksEnumerated("films: Heat, Alien"))
        #expect(!RouteHeuristic.looksEnumerated("- one"))
        #expect(!RouteHeuristic.looksEnumerated("films: Heat"))
        #expect(!RouteHeuristic.looksEnumerated("we met Sarah, then left"))
    }

    @Test("A contraction or a modal \"may\" is a question", arguments: RouteParityCases.contractionAsks)
    func contractionAsks(_ text: String) {
        #expect(RouteHeuristic.verdict(for: text)?.route == .ask)
    }

    @Test("A contraction or the month May still holds", arguments: RouteParityCases.contractionHolds)
    func contractionHolds(_ text: String) {
        #expect(RouteHeuristic.verdict(for: text)?.route == .hold)
    }

    @Test("A contraction reads as two words")
    func contractionsExpand() {
        #expect(RouteHeuristic.normalize("What’s  on") == "what is on")
        #expect(RouteHeuristic.normalize("I can't and won't") == "i can not and will not")
        #expect(RouteHeuristic.normalize("don't forget") == "do not forget")
        #expect(RouteHeuristic.normalize("I'm sure we'll") == "i am sure we will")
    }

    @Test("The demo request with a date in a quoted subject is Ask")
    func demoRequestAsks() {
        let text = #"Add the label Offsite to the message "Board meeting materials for October 9" and mark it as unread."#
        #expect(RouteHeuristic.verdict(for: text) == RouteVerdict(route: .ask, confidence: 0.85, reason: "app action"))
        // The chip must show Ask before the endpoint answers, also after a Hold.
        #expect(RouteHeuristic.instant(text, current: .hold).route == .ask)
    }

    @Test("An app action with a date is Ask", arguments: RouteParityCases.appActions)
    func appActionsAsk(_ text: String) {
        #expect(RouteHeuristic.verdict(for: text)?.route == .ask)
    }

    @Test("Quoted text gives no date signal, and a quoted question mark does not win")
    func quotedTextIsNoSignal() {
        #expect(RouteHeuristic.verdict(for: #""Board meeting materials for October 9""#)?.route == .hold)
        let remind = RouteHeuristic.verdict(for: #"Remind me about "Can we meet?" next week"#)
        #expect(remind?.route == .hold)
        #expect(remind?.reason == "explicit hold")
        #expect(RouteHeuristic.verdict(for: "Find “Board meeting materials for October 9”")?.route == .ask)
        #expect(RouteHeuristic.verdict(for: "the “October 9” notes") == nil)
    }

    @Test("Quoted parts leave the text, and an all-quoted text stays whole")
    func withoutQuotes() {
        #expect(RouteHeuristic.withoutQuotes(#"find "october 9" notes"#) == "find notes")
        #expect(RouteHeuristic.withoutQuotes("find «october 9» notes") == "find notes")
        #expect(RouteHeuristic.withoutQuotes("find „october 9“ notes") == "find notes")
        #expect(RouteHeuristic.withoutQuotes(#""october 9""#) == #""october 9""#)
        #expect(RouteHeuristic.withoutQuotes("don't stop") == "don't stop")
    }

    @Test("A real deferral stays Hold", arguments: RouteParityCases.deferrals)
    func deferralsHold(_ text: String) {
        #expect(RouteHeuristic.verdict(for: text)?.route == .hold)
    }
}
