import SwiftUI

/// The motion vocabulary of the horizon surfaces. Reduce Motion replaces
/// every move with `cross`. Nothing travels.
enum WorkMotion {
    static let settle: Animation = .snappy(duration: 0.32, extraBounce: 0.04)
    static let rise: Animation = .smooth(duration: 0.26)
    static let cross: Animation = .easeInOut(duration: 0.18)

    static func settle(reduceMotion: Bool) -> Animation { reduceMotion ? cross : settle }
    static func rise(reduceMotion: Bool) -> Animation { reduceMotion ? cross : rise }
}

/// The shelf as a timeline: one slot per month from the first wake month to
/// the last, then "Someday" at the far end. Months without a card keep a
/// narrow tick, so the distance between two cards reads as time.
enum LaterShelfLayout {
    struct Slot: Identifiable, Equatable {
        let id: String
        /// "Oct", "Nov", "Jan". Nil for the "Someday" group, which has no tick.
        let tick: String?
        let items: [WorkListItem]

        var isSomeday: Bool { tick == nil }
        var isEmpty: Bool { items.isEmpty }
    }

    static let cardWidth: CGFloat = 168
    static let cardGap: CGFloat = 12
    static let emptySlotWidth: CGFloat = 44
    static let stackOffset: CGFloat = 8
    static let stackScale: CGFloat = 0.96

    static func slots(
        for items: [WorkListItem],
        now: Date,
        calendar: Calendar = .current
    ) -> [Slot] {
        let dated = items.filter { $0.horizon?.notBefore != nil }
        let undated = items.filter { $0.horizon?.notBefore == nil }
        var slots: [Slot] = []

        if let first = dated.first?.horizon?.notBefore,
           let last = dated.last?.horizon?.notBefore {
            var byMonth: [String: [WorkListItem]] = [:]
            for item in dated {
                guard let date = item.horizon?.notBefore else { continue }
                byMonth[monthKey(date, calendar: calendar), default: []].append(item)
            }
            var cursor = startOfMonth(first, calendar: calendar)
            let end = startOfMonth(last, calendar: calendar)
            var guardCount = 0
            while cursor <= end, guardCount < 240 {
                let key = monthKey(cursor, calendar: calendar)
                slots.append(Slot(id: key, tick: tickLabel(cursor, now: now, calendar: calendar), items: byMonth[key] ?? []))
                guard let next = calendar.date(byAdding: .month, value: 1, to: cursor) else { break }
                cursor = next
                guardCount += 1
            }
        }

        if !undated.isEmpty {
            slots.append(Slot(id: "someday", tick: nil, items: undated))
        }
        return slots
    }

    /// "Nov" inside the current year, "Jan 2027" once the year changes.
    static func tickLabel(_ date: Date, now: Date, calendar: Calendar) -> String {
        let locale = Locale(identifier: "en_US")
        var style = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
        if calendar.component(.year, from: date) == calendar.component(.year, from: now) {
            style = style.month(.abbreviated)
        } else {
            style = style.month(.abbreviated).year()
        }
        return date.formatted(style)
    }

    /// The width of a slot: cards fanned open sit side by side.
    static func slotWidth(_ slot: Slot, expanded: Bool) -> CGFloat {
        if slot.isEmpty { return emptySlotWidth }
        if expanded, slot.items.count > 1 {
            return CGFloat(slot.items.count) * cardWidth + CGFloat(slot.items.count - 1) * cardGap
        }
        return cardWidth + CGFloat(min(slot.items.count - 1, 2)) * stackOffset
    }

    /// The container label: "Later, 4 items".
    static func containerLabel(count: Int) -> String {
        count == 1 ? "Later, 1 item" : "Later, \(count) items"
    }

    /// What VoiceOver reads for a card: "Passport renewal, back on November 1, Personal".
    static func cardLabel(_ item: WorkListItem, now: Date, calendar: Calendar = .current) -> String {
        var parts = [item.displayTitle]
        if let date = item.horizon?.notBefore, date > now {
            let locale = Locale(identifier: "en_US")
            var style = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
            style = style.month(.wide).day()
            if calendar.component(.year, from: date) != calendar.component(.year, from: now) {
                style = style.year()
            }
            parts.append("back on \(date.formatted(style))")
        } else if let line = item.horizon?.line(at: now, calendar: calendar) {
            parts.append(line.lowercased())
        }
        if let areaName = item.areaName { parts.append(areaName) }
        return parts.joined(separator: ", ")
    }

    private static func startOfMonth(_ date: Date, calendar: Calendar) -> Date {
        let components = calendar.dateComponents([.year, .month], from: date)
        return calendar.date(from: components) ?? date
    }

    private static func monthKey(_ date: Date, calendar: Calendar) -> String {
        let components = calendar.dateComponents([.year, .month], from: date)
        return String(format: "%04d-%02d", components.year ?? 0, components.month ?? 0)
    }
}

/// A horizontal timeline under the open groups: a hairline rail with month
/// ticks, one card per dormant Work at its wake month, a "Someday" group at
/// the far end. Shown only when dormant Work exists.
struct LaterShelf: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let items: [WorkListItem]
    let now: Date
    let onOpen: (WorkListItem) -> Void
    let onWake: (WorkListItem) -> Void
    let onChangeHorizon: (WorkListItem) -> Void

    @State private var expandedSlotID: String?
    @State private var appeared = false

    private var slots: [LaterShelfLayout.Slot] {
        LaterShelfLayout.slots(for: items, now: now)
    }

    /// At accessibility sizes the shelf becomes a vertical list with a
    /// leading date column. The fallback is for accessibility only.
    private var useVerticalLayout: Bool { dynamicTypeSize.isAccessibilitySize }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Rectangle().fill(Color.secondary.opacity(0.45)).frame(width: 18, height: 1)
                Text("Later").font(.system(.subheadline, design: .serif).weight(.semibold))
                Text("Sleeps until its date.").font(.caption2).foregroundStyle(.tertiary)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 20)

            if useVerticalLayout {
                verticalList
                    .padding(.horizontal, 20)
            } else {
                timeline
            }
        }
        .padding(.bottom, 24)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(LaterShelfLayout.containerLabel(count: items.count))
        .onAppear { appeared = true }
    }

    private var timeline: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .top, spacing: LaterShelfLayout.cardGap) {
                ForEach(Array(slots.enumerated()), id: \.element.id) { offset, slot in
                    slotView(slot, index: offset)
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 22)
            .padding(.bottom, 8)
            .background(alignment: .top) {
                // The rail runs the full width of the content, behind the ticks.
                Rectangle()
                    .fill(environment.theme.hairlineColor)
                    .frame(height: 1)
                    .padding(.top, 8)
            }
        }
        .animation(WorkMotion.settle(reduceMotion: reduceMotion), value: expandedSlotID)
    }

    @ViewBuilder
    private func slotView(_ slot: LaterShelfLayout.Slot, index: Int) -> some View {
        let expanded = expandedSlotID == slot.id
        VStack(alignment: .leading, spacing: 10) {
            tick(slot)
            if slot.isEmpty {
                Color.clear.frame(width: LaterShelfLayout.emptySlotWidth, height: 1)
            } else if expanded || slot.items.count == 1 {
                HStack(alignment: .top, spacing: LaterShelfLayout.cardGap) {
                    ForEach(Array(slot.items.enumerated()), id: \.element.id) { cardOffset, item in
                        card(item, index: index + cardOffset)
                    }
                }
            } else {
                stack(slot, index: index)
            }
        }
        .frame(width: LaterShelfLayout.slotWidth(slot, expanded: expanded), alignment: .leading)
    }

    @ViewBuilder
    private func tick(_ slot: LaterShelfLayout.Slot) -> some View {
        if let label = slot.tick {
            HStack(spacing: 6) {
                Rectangle()
                    .fill(Color.secondary.opacity(0.45))
                    .frame(width: 1, height: 8)
                Text(label)
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            .offset(y: -14)
            .accessibilityHidden(true)
        } else {
            Text("Someday")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .offset(y: -14)
                .accessibilityHidden(true)
        }
    }

    /// Cards in one month sit in a fanned stack. A tap fans them open.
    private func stack(_ slot: LaterShelfLayout.Slot, index: Int) -> some View {
        let visible = Array(slot.items.prefix(3))
        return ZStack(alignment: .topLeading) {
            ForEach(Array(visible.enumerated().reversed()), id: \.element.id) { depth, item in
                LaterCard(item: item, now: now)
                    .scaleEffect(depth == 0 ? 1 : LaterShelfLayout.stackScale, anchor: .topLeading)
                    .offset(x: CGFloat(depth) * LaterShelfLayout.stackOffset, y: CGFloat(depth) * 4)
                    .opacity(depth == 0 ? 1 : 0.7)
                    .allowsHitTesting(depth == 0)
                    .accessibilityHidden(depth != 0)
            }
        }
        .contentShape(.rect)
        .onTapGesture { expandedSlotID = slot.id }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(slot.items.count) items in \(slot.tick ?? "someday")")
        .accessibilityHint("Opens the stack")
        .accessibilityAddTraits(.isButton)
        .modifier(RiseIn(appeared: appeared, index: index, reduceMotion: reduceMotion))
    }

    private func card(_ item: WorkListItem, index: Int) -> some View {
        Button {
            onOpen(item)
        } label: {
            LaterCard(item: item, now: now)
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button("Wake now") { onWake(item) }
            Button("Change horizon") { onChangeHorizon(item) }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(LaterShelfLayout.cardLabel(item, now: now))
        .accessibilityAddTraits(.isButton)
        .modifier(RiseIn(appeared: appeared, index: index, reduceMotion: reduceMotion))
    }

    private var verticalList: some View {
        VStack(spacing: 0) {
            ForEach(items) { item in
                Button {
                    onOpen(item)
                } label: {
                    HStack(alignment: .top, spacing: 12) {
                        Text(dateColumn(item))
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                            .frame(minWidth: 56, alignment: .leading)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(item.displayTitle)
                                .font(.subheadline)
                                .foregroundStyle(.primary)
                                .multilineTextAlignment(.leading)
                            if let areaName = item.areaName {
                                Text(areaName)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, 10)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .contextMenu {
                    Button("Wake now") { onWake(item) }
                    Button("Change horizon") { onChangeHorizon(item) }
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(LaterShelfLayout.cardLabel(item, now: now))
                .accessibilityAddTraits(.isButton)
                if item.id != items.last?.id { Divider() }
            }
        }
    }

    private func dateColumn(_ item: WorkListItem) -> String {
        if let date = item.horizon?.notBefore, date > now {
            return WorkHorizon.shortDate(date, now: now)
        }
        return item.horizon?.kind == .someday ? "Someday" : "Later"
    }
}

/// One dormant Work: the title, the horizon line in the display italic, the
/// area name. One elevation step, 168 pt wide.
struct LaterCard: View {
    @Environment(AppEnvironment.self) private var environment
    let item: WorkListItem
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(item.displayTitle)
                .font(.subheadline)
                .foregroundStyle(.primary)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(item.horizon?.line(at: now) ?? "Later")
                .font(environment.theme.displayType.displayItalicFont(size: 14))
                .foregroundStyle(environment.theme.accentColor)
                .lineLimit(1)
            if let areaName = item.areaName {
                Text(areaName)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(14)
        .frame(width: LaterShelfLayout.cardWidth, alignment: .topLeading)
        .frame(minHeight: 96, alignment: .topLeading)
        .surfaceCard(cornerRadius: 14)
        .contentShape(.rect)
    }
}

/// `rise` with a 40 ms stagger, left to right. Reduce Motion: a crossfade.
private struct RiseIn: ViewModifier {
    let appeared: Bool
    let index: Int
    let reduceMotion: Bool

    func body(content: Content) -> some View {
        content
            .opacity(appeared ? 1 : 0)
            .offset(y: appeared || reduceMotion ? 0 : 8)
            .animation(WorkMotion.rise(reduceMotion: reduceMotion).delay(Double(index) * 0.04), value: appeared)
    }
}
