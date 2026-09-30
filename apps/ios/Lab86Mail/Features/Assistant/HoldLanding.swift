import SwiftUI

/// What the Hold landing shows about one new Work.
struct HoldCardModel: Identifiable, Equatable, Sendable {
    let id: String
    let title: String
    let shapeWord: String
    let horizonLine: String?

    /// "Quick · By the trip", or just the shape word when there is no horizon.
    var secondLine: String {
        guard let horizonLine, !horizonLine.isEmpty else { return shapeWord }
        return "\(shapeWord) · \(horizonLine)"
    }
}

/// One Hold from the bar: the Work it made and the text it kept. Undo
/// archives all of that Work and gives the text back to the bar.
struct HeldBarText: Equatable, Sendable {
    let workIDs: [String]
    let text: String
}

/// The Undo of a Hold. It mirrors `releaseHold` and `restoreHeldText` in
/// `lib/albatross/capture-client.ts`.
enum HoldUndo {
    static let errorText = "Could not undo the hold. Try again."

    /// The bar text when an undone Hold comes back. An empty bar gets the held
    /// text. A bar with a newer draft keeps that draft and gets the held text
    /// under it, so the bar never loses either text.
    static func restoredDraft(current: String, held: String) -> String {
        let draft = current.trimmingCharacters(in: .whitespacesAndNewlines)
        let text = held.trimmingCharacters(in: .whitespacesAndNewlines)
        if draft.isEmpty { return held }
        if text.isEmpty || draft.contains(text) { return current }
        guard let last = current.lastIndex(where: { !$0.isWhitespace }) else { return held }
        return "\(current[...last])\n\n\(text)"
    }
}

/// The three parts of the landing. The whole run takes under 600 ms.
enum HoldPhase: Equatable, Sendable {
    /// The text collapses into the card.
    case collapse
    /// The card holds still and reads.
    case hold
    /// The card moves toward the Work rail and fades.
    case travel

    static let collapseDuration: Double = 0.22
    static let holdDuration: Double = 0.12
    static let travelDuration: Double = 0.26

    /// The moment each phase starts, from the first frame.
    static func start(of phase: HoldPhase) -> Double {
        switch phase {
        case .collapse: 0
        case .hold: collapseDuration
        case .travel: collapseDuration + holdDuration
        }
    }

    static var total: Double { collapseDuration + holdDuration + travelDuration }
}

/// The card that stands in for the composer while the Work is kept.
struct HoldCard: View {
    let model: HoldCardModel
    var phase: HoldPhase = .collapse
    var isWorking: Bool = false

    @Environment(AppEnvironment.self) private var environment

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(model.title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(2)
                Text(model.secondLine)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            if isWorking {
                ProgressView().controlSize(.small)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .surfaceCard(cornerRadius: 14)
        .scaleEffect(phase == .travel ? 0.6 : 1, anchor: .leading)
        .opacity(phase == .travel ? 0 : 1)
        .offset(x: phase == .travel ? -60 : 0)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Held: \(model.title). \(model.secondLine)")
    }
}

/// The line that stays in the transcript after a Hold. It is client state, not
/// a chat message. A Hold from the bar also shows Undo.
struct HoldReceiptRow: View {
    let model: HoldCardModel
    var isUndoing: Bool = false
    let onOpen: () -> Void
    var onUndo: (() -> Void)? = nil

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text("Held for later: \(model.title)")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(2)
            Spacer(minLength: 0)
            if let onUndo {
                Button("Undo", action: onUndo)
                    .buttonStyle(.plain)
                    .font(.footnote.weight(.medium))
                    .disabled(isUndoing)
                    .accessibilityHint("Archives the Work and puts the text back in the bar")
            }
            Button("Open", action: onOpen)
                .buttonStyle(.plain)
                .font(.footnote.weight(.medium))
                .accessibilityHint("Shows the Work")
        }
        .padding(.vertical, 6)
    }
}

/// The quiet action under an assistant reply. It becomes "Kept" once used.
struct HoldThisButton: View {
    let isHeld: Bool
    var isWorking: Bool = false
    let onHold: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            Spacer(minLength: 0)
            if isWorking {
                ProgressView().controlSize(.mini)
            }
            Button(isHeld ? "Kept" : "Hold this") {
                guard !isHeld else { return }
                onHold()
            }
            .buttonStyle(.plain)
            .font(.footnote)
            .foregroundStyle(.secondary)
            .disabled(isHeld || isWorking)
        }
        .accessibilityLabel(isHeld ? "Kept" : "Hold this reply")
    }
}
