import SwiftUI

/// The outcome contract, drawn as a ledger — the same object as the web's, in
/// native materials.
///
/// A contract is a promise with a spine: an accent rule down its leading edge,
/// each condition marked met or outstanding, and the closing rule set at the
/// foot like a term. It should read as the most considered thing on the screen,
/// because it is the one that decides whether Albatross may say a thing is done.
struct OutcomeContractView: View {
    let contract: WorkDetail.Contract
    var canClose: Bool = false

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            // The spine. One rule is the whole signature of this object.
            Rectangle()
                .fill(canClose ? Color.green : Color.accentColor)
                .frame(width: 3)

            VStack(alignment: .leading, spacing: 10) {
                Text("What would settle this")
                    .font(.footnote.weight(.semibold))

                Text(contract.outcome)
                    .font(.system(.callout, design: .serif))
                    .fixedSize(horizontal: false, vertical: true)

                VStack(alignment: .leading, spacing: 8) {
                    ForEach(contract.proofs) { proof in
                        HStack(alignment: .top, spacing: 10) {
                            ZStack {
                                Circle()
                                    .strokeBorder(
                                        proof.isMet ? Color.green : Color.secondary.opacity(0.5),
                                        style: StrokeStyle(lineWidth: 1, dash: proof.isMet ? [] : [2, 2])
                                    )
                                    .background(Circle().fill(proof.isMet ? Color.green : .clear))
                                    .frame(width: 16, height: 16)
                                if proof.isMet {
                                    Image(systemName: "checkmark")
                                        .font(.system(size: 8, weight: .bold))
                                        .foregroundStyle(.white)
                                }
                            }
                            .padding(.top, 2)

                            VStack(alignment: .leading, spacing: 2) {
                                Text(proof.what)
                                    .font(.subheadline)
                                    .foregroundStyle(proof.isMet ? Color.primary : Color.secondary)
                                if let satisfiedBy = proof.satisfiedBy {
                                    Text(satisfiedBy)
                                        .font(.caption2)
                                        .foregroundStyle(.tertiary)
                                }
                            }
                            Spacer(minLength: 0)
                        }
                    }
                }

                Text(contract.statusLine)
                    .font(.caption)
                    .foregroundStyle(.secondary)

                // The closing rule, set like a term at the foot of an agreement.
                VStack(alignment: .leading, spacing: 2) {
                    Divider().overlay(Color.secondary.opacity(0.25))
                        .padding(.bottom, 6)
                    Text("Albatross may close this")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                    Text(contract.closeWhenLabel)
                        .font(.caption.weight(.medium))
                }
            }
            .padding(.leading, 14)
            .padding(.trailing, 14)
            .padding(.vertical, 14)
        }
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color(.secondarySystemGroupedBackground))
        )
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

/// Proof, drawn as a timeline rather than a list.
///
/// Proof accumulates over time toward a claim, and a flat stack of rows cannot
/// show that shape. A hairline spine with a node per piece, the strongest one
/// filled.
struct ProofTimelineView: View {
    let evidence: [WorkDetail.Evidence]
    let standing: WorkDetail.ProofStanding

    private var ordered: [WorkDetail.Evidence] {
        evidence.sorted { ($0.occurredAt ?? .distantPast) > ($1.occurredAt ?? .distantPast) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("Proof").font(.footnote.weight(.semibold))
                Text("What Albatross has seen that bears on whether this is done.")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }

            Text(standing.label)
                .font(.caption.weight(standing.isConfirmed ? .semibold : .regular))
                .foregroundStyle(standing.isConfirmed ? Color.green : Color.secondary)
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(
                    Capsule().fill(
                        standing.isConfirmed ? Color.green.opacity(0.12) : Color.secondary.opacity(0.1)
                    )
                )

            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(ordered.enumerated()), id: \.element.id) { index, row in
                    HStack(alignment: .top, spacing: 12) {
                        // The spine, drawn per row so it joins continuously.
                        VStack(spacing: 0) {
                            Rectangle()
                                .fill(index == 0 ? Color.clear : Color.secondary.opacity(0.25))
                                .frame(width: 1, height: 10)
                            Circle()
                                .fill(nodeColor(row))
                                .frame(width: 9, height: 9)
                            Rectangle()
                                .fill(index == ordered.count - 1 ? Color.clear : Color.secondary.opacity(0.25))
                                .frame(width: 1)
                                .frame(maxHeight: .infinity)
                        }
                        .frame(width: 9)

                        VStack(alignment: .leading, spacing: 2) {
                            if let claim = row.claim {
                                Text(claim)
                                    .font(.subheadline.weight(.medium))
                                    .strikethrough(row.isRejected)
                            }
                            Text(row.title)
                                .font(row.claim == nil ? .subheadline.weight(.medium) : .footnote)
                                .foregroundStyle(row.claim == nil ? Color.primary : Color.secondary)
                            if let summary = row.summary {
                                Text(summary).font(.caption).foregroundStyle(.secondary)
                            }
                            Text(footnote(for: row))
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                        .padding(.bottom, 12)
                        .opacity(row.isRejected ? 0.6 : 1)

                        Spacer(minLength: 0)
                    }
                }
            }
        }
    }

    private func nodeColor(_ row: WorkDetail.Evidence) -> Color {
        if row.isConfirmed { return .green }
        if row.isRejected { return .secondary.opacity(0.5) }
        return .accentColor
    }

    private func footnote(for row: WorkDetail.Evidence) -> String {
        var parts = [row.sourceLabel]
        if row.isRejected { parts.append("ruled out") }
        if let limits = row.limits { parts.append(limits) }
        return parts.joined(separator: " · ")
    }
}
