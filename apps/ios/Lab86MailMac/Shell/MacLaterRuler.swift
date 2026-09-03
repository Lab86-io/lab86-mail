import AppKit
import SwiftUI

// The "Later" shelf on the Mac: an ordinal ruler. Each dormant Work is a
// card in wake order along one hairline. Cards get equal spacing; the
// hairline between two cards carries the elapsed time ("6 weeks"). Cards
// with no date sit at the far end after a longer gap under "Someday". Under
// 640 pt the ruler becomes a vertical list in the same order.

enum MacLaterRulerLayout {
    static let cardWidth: CGFloat = 200
    static let gap: CGFloat = 56
    static let somedayGap: CGFloat = 96
    static let verticalBreakpoint: CGFloat = 640
    static let wheelStep: CGFloat = 40

    struct Entry: Identifiable, Equatable {
        let item: WorkListItem
        // The elapsed time on the hairline before this card. Nil for the
        // first someday card, whose gap carries the "Someday" label instead.
        let gapLabel: String?
        let isSomeday: Bool

        var id: String { item.id }
    }

    static func usesVertical(width: CGFloat) -> Bool {
        width < verticalBreakpoint
    }

    // The cards in shelf order with the gap label before each one. The first
    // dated card measures from now. A later card measures from the card
    // before it. Someday cards carry no time.
    static func entries(_ items: [WorkListItem], now: Date, calendar: Calendar = .current) -> [Entry] {
        var previous = now
        return items.map { item in
            if let date = item.horizon?.notBefore, date > now {
                let label = gapLabel(from: previous, to: date, calendar: calendar)
                previous = date
                return Entry(item: item, gapLabel: label, isSomeday: false)
            }
            return Entry(item: item, gapLabel: nil, isSomeday: true)
        }
    }

    // "3 days", "6 weeks", "3 months", "1 year". The largest unit that fits
    // with a count of one or more. Under one day: "Same day".
    static func gapLabel(from start: Date, to end: Date, calendar: Calendar = .current) -> String {
        let from = calendar.startOfDay(for: start)
        let to = calendar.startOfDay(for: end)
        let days = calendar.dateComponents([.day], from: from, to: to).day ?? 0
        if days < 1 { return "Same day" }
        if days < 14 { return plural(days, "day") }
        if days < 60 { return plural(days / 7, "week") }
        let months = calendar.dateComponents([.month], from: from, to: to).month ?? (days / 30)
        if months < 12 { return plural(max(1, months), "month") }
        let years = months / 12
        return plural(years, "year")
    }

    // The next card to focus for an arrow key, inside the shelf order.
    static func neighbour(of id: String?, in entries: [Entry], step: Int) -> String? {
        guard !entries.isEmpty else { return nil }
        guard let id, let index = entries.firstIndex(where: { $0.id == id }) else {
            return entries.first?.id
        }
        let next = index + step
        guard entries.indices.contains(next) else { return id }
        return entries[next].id
    }

    // The next offset for one mouse-wheel notch. A wheel that rolls down
    // moves the ruler forward in time. The offset never goes under zero.
    static func wheelOffset(current: CGFloat, deltaY: CGFloat) -> CGFloat {
        max(0, current - deltaY * wheelStep)
    }

    private static func plural(_ count: Int, _ unit: String) -> String {
        count == 1 ? "1 \(unit)" : "\(count) \(unit)s"
    }
}

struct MacLaterRuler: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let items: [WorkListItem]
    let now: Date
    let onOpen: (WorkListItem) -> Void
    let onWake: (WorkListItem) -> Void
    let onSetHorizon: (WorkListItem, WorkHorizon?) async -> Bool

    @State private var width: CGFloat = 1_000
    @State private var focusedCardID: String?
    @State private var changing: WorkListItem?
    @State private var appeared = false

    private var entries: [MacLaterRulerLayout.Entry] {
        MacLaterRulerLayout.entries(items, now: now)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Rectangle().fill(Color.secondary.opacity(0.45)).frame(width: 18, height: 1)
                Text("Later").font(.system(.subheadline, design: .serif).weight(.semibold))
                Text("Kept, not moved.").font(.caption2).foregroundStyle(.tertiary)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 20)

            if MacLaterRulerLayout.usesVertical(width: width) {
                verticalList
                    .padding(.horizontal, 20)
            } else {
                ruler
            }
        }
        .padding(.bottom, 24)
        .onGeometryChange(for: CGFloat.self) { proxy in proxy.size.width } action: { width = $0 }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(LaterShelfLayout.containerLabel(count: items.count))
        .onAppear { appeared = true }
    }

    // MARK: - Horizontal ruler

    private var ruler: some View {
        MacWheelScrollView {
            HStack(alignment: .top, spacing: 0) {
                originTick
                ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
                    segment(entry, previousWasSomeday: index > 0 && entries[index - 1].isSomeday)
                    card(entry.item, index: index)
                }
                Color.clear.frame(width: MacLaterRulerLayout.gap, height: 1)
            }
            .padding(.horizontal, 20)
            .padding(.top, 22)
            .padding(.bottom, 8)
        }
        .focusable()
        .onKeyPress(.leftArrow) {
            focusedCardID = MacLaterRulerLayout.neighbour(of: focusedCardID, in: entries, step: -1)
            return .handled
        }
        .onKeyPress(.rightArrow) {
            focusedCardID = MacLaterRulerLayout.neighbour(of: focusedCardID, in: entries, step: 1)
            return .handled
        }
        .onKeyPress(.return) {
            guard let focusedCardID, let item = items.first(where: { $0.id == focusedCardID }) else { return .ignored }
            onOpen(item)
            return .handled
        }
    }

    // The ruler starts at now. The first gap measures from here.
    private var originTick: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Now")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .offset(y: -14)
            Rectangle()
                .fill(Color.secondary.opacity(0.45))
                .frame(width: 1, height: 8)
        }
        .frame(width: 1, alignment: .leading)
        .accessibilityHidden(true)
    }

    // The hairline between two cards, with the elapsed time on it. The first
    // someday card gets a longer gap under "Someday".
    @ViewBuilder
    private func segment(_ entry: MacLaterRulerLayout.Entry, previousWasSomeday: Bool) -> some View {
        let isSomedayStart = entry.isSomeday && !previousWasSomeday
        let gapWidth = isSomedayStart ? MacLaterRulerLayout.somedayGap : MacLaterRulerLayout.gap
        ZStack(alignment: .top) {
            Rectangle()
                .fill(environment.theme.hairlineColor)
                .frame(height: 1)
                .padding(.top, 8)
            if let label = entry.gapLabel {
                Text(label)
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .offset(y: -8)
            } else if isSomedayStart {
                Text("Someday")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .offset(y: -8)
            }
        }
        .frame(width: gapWidth, height: 20, alignment: .top)
        .accessibilityHidden(true)
    }

    private func card(_ item: WorkListItem, index: Int) -> some View {
        MacLaterCard(
            item: item,
            now: now,
            isFocused: focusedCardID == item.id,
            onOpen: { onOpen(item) },
            onWake: { onWake(item) },
            onChange: { changing = item }
        )
        .popover(
            isPresented: Binding(
                get: { changing?.id == item.id },
                set: { if !$0 { changing = nil } }
            ),
            arrowEdge: .bottom
        ) {
            MacHorizonPopover(
                initial: item.horizon,
                onSet: { horizon in await onSetHorizon(item, horizon) },
                onClose: { changing = nil }
            )
        }
        .accessibilityLabel(LaterShelfLayout.cardLabel(item, now: now))
        .modifier(MacRiseIn(appeared: appeared, index: index, reduceMotion: reduceMotion))
    }

    // MARK: - Vertical fallback

    private var verticalList: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
                if let label = entry.gapLabel {
                    Text(label)
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .padding(.vertical, 6)
                        .padding(.leading, 14)
                } else if entry.isSomeday, index == 0 || !entries[index - 1].isSomeday {
                    Text("Someday")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .padding(.vertical, 6)
                        .padding(.leading, 14)
                }
                MacLaterCard(
                    item: entry.item,
                    now: now,
                    isFocused: focusedCardID == entry.id,
                    width: nil,
                    onOpen: { onOpen(entry.item) },
                    onWake: { onWake(entry.item) },
                    onChange: { changing = entry.item }
                )
                .popover(
                    isPresented: Binding(
                        get: { changing?.id == entry.id },
                        set: { if !$0 { changing = nil } }
                    ),
                    arrowEdge: .trailing
                ) {
                    MacHorizonPopover(
                        initial: entry.item.horizon,
                        onSet: { horizon in await onSetHorizon(entry.item, horizon) },
                        onClose: { changing = nil }
                    )
                }
                .accessibilityLabel(LaterShelfLayout.cardLabel(entry.item, now: now))
            }
        }
    }
}

// One dormant Work. Title (2 lines), the horizon line, the user's own words
// in the italic display voice. Hover raises the card one step in 150 ms and
// shows "Wake now" and "Change" on the foot. Click opens the Work.
struct MacLaterCard: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.colorScheme) private var colorScheme
    let item: WorkListItem
    let now: Date
    let isFocused: Bool
    var width: CGFloat? = MacLaterRulerLayout.cardWidth
    let onOpen: () -> Void
    let onWake: () -> Void
    let onChange: () -> Void

    @State private var hovering = false

    private var showsFoot: Bool { hovering || isFocused }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button(action: onOpen) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(item.displayTitle)
                        .font(.subheadline)
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(item.horizon?.line(at: now) ?? "Later")
                        .font(.caption)
                        .foregroundStyle(environment.theme.accentColor)
                        .lineLimit(1)
                    if let label = item.horizon?.label?.nilIfBlank {
                        Text(WorkHorizon.sentenceCase(label))
                            .font(environment.theme.displayType.displayItalicFont(size: 14))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)

            HStack(spacing: 14) {
                Button("Wake now", action: onWake)
                Button("Change", action: onChange)
            }
            .buttonStyle(.plain)
            .font(.caption.weight(.medium))
            .foregroundStyle(environment.theme.accentColor)
            .opacity(showsFoot ? 1 : 0)
            .accessibilityHidden(!showsFoot)
        }
        .padding(14)
        .frame(width: width, alignment: .topLeading)
        .frame(maxWidth: width == nil ? .infinity : nil, minHeight: 104, alignment: .topLeading)
        .surfaceCard(cornerRadius: 14)
        .shadow(color: .black.opacity(hovering && colorScheme != .dark ? 0.08 : 0), radius: 10, y: 6)
        .overlay {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(isFocused ? environment.theme.accentColor : .clear, lineWidth: 1)
        }
        .scaleEffect(hovering ? 1.01 : 1, anchor: .center)
        .animation(.easeOut(duration: 0.15), value: hovering)
        .onHover { hovering = $0 }
        .contextMenu {
            Button("Open", action: onOpen)
            Button("Wake now", action: onWake)
            Button("Change horizon", action: onChange)
        }
        .accessibilityElement(children: .contain)
        .accessibilityAction(named: "Wake now", onWake)
        .accessibilityAction(named: "Change horizon", onChange)
    }
}

// A horizontal scroll view that also follows the mouse wheel while the
// pointer is over it. Trackpads scroll sideways on their own; a wheel only
// reports a vertical delta, so the view turns it into a horizontal move.
private struct MacWheelScrollView<Content: View>: View {
    @ViewBuilder let content: () -> Content

    @State private var position = ScrollPosition(edge: .leading)
    @State private var monitor = MacWheelMonitor()

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            content()
        }
        .scrollPosition($position)
        .onScrollGeometryChange(for: CGFloat.self) { $0.contentOffset.x } action: { _, value in
            monitor.offsetX = value
        }
        .onHover { monitor.hovering = $0 }
        .onAppear {
            monitor.scrollTo = { x in position.scrollTo(x: x) }
            monitor.start()
        }
        .onDisappear { monitor.stop() }
    }
}

// Holds the wheel monitor outside the view struct, so the handler reads the
// live hover state and the live offset.
@MainActor
private final class MacWheelMonitor {
    var hovering = false
    var offsetX: CGFloat = 0
    var scrollTo: ((CGFloat) -> Void)?
    private var token: Any?

    func start() {
        guard token == nil else { return }
        token = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
            // NSEvent is not Sendable, so read the values here and let the
            // isolated block work with plain numbers.
            let precise = event.hasPreciseScrollingDeltas
            let deltaY = event.scrollingDeltaY
            let deltaX = event.scrollingDeltaX
            let handled = MainActor.assumeIsolated { () -> Bool in
                guard let self, self.hovering, !precise,
                      abs(deltaY) > abs(deltaX) else { return false }
                self.scrollTo?(MacLaterRulerLayout.wheelOffset(current: self.offsetX, deltaY: deltaY))
                return true
            }
            return handled ? nil : event
        }
    }

    func stop() {
        if let token { NSEvent.removeMonitor(token) }
        token = nil
    }
}

// Rise with a 40 ms stagger, once. Reduce Motion: a crossfade.
private struct MacRiseIn: ViewModifier {
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
