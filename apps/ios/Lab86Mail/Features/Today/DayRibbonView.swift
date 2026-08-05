import SwiftUI

/// The day, drawn to scale.
///
/// A list of times tells you what is booked. A ribbon tells you what the day
/// *feels* like — where the pressure is, where the open air is, how much of the
/// afternoon is actually yours. That is the question Today is meant to answer,
/// and a bulleted list cannot answer it.
///
/// The maths is a mirror of `lib/albatross/day-ribbon.ts`, with the same
/// constants, so the two clients cannot draw the same day differently.
enum DayRibbon {
    /// The ribbon draws the waking window unless events push past it.
    static let defaultStartHour = 7
    static let defaultEndHour = 22
    /// Below this, a gap is a corridor between meetings rather than an opening.
    static let minimumOpeningMinutes = 45
    /// A fifteen-minute stand-up must stay readable and tappable.
    static let minimumBlockHeight = 0.035

    struct Window: Equatable {
        var startHour: Int
        var endHour: Int
    }

    struct Block: Identifiable, Equatable {
        let id: String
        let title: String
        /// 0…1 down the ribbon.
        var top: Double
        var height: Double
        let label: String
        let location: String?
        /// True when the block is too short to carry a title and a time on two lines.
        var compact: Bool = false
    }

    struct Gap: Equatable {
        let top: Double
        let height: Double
        let minutes: Int
        let label: String
    }

    struct Tick: Identifiable, Equatable {
        let hour: Int
        let top: Double
        let label: String
        var id: Int { hour }
    }

    private static func hour(of date: Date, calendar: Calendar) -> Double {
        let parts = calendar.dateComponents([.hour, .minute], from: date)
        return Double(parts.hour ?? 0) + Double(parts.minute ?? 0) / 60
    }

    /// How much of the clock the ribbon must cover. A 6am flight or a late
    /// concert is never clipped off the end of the day.
    static func window(events: [CalendarEventSummary], now: Date, calendar: Calendar = .current) -> Window {
        var start = defaultStartHour
        var end = defaultEndHour
        for event in events where !event.allDay {
            start = min(start, Int(hour(of: event.start, calendar: calendar).rounded(.down)))
            end = max(end, Int(hour(of: event.end, calendar: calendar).rounded(.up)))
        }
        // Keep "now" on the ribbon so the marker is never off either end.
        let current = hour(of: now, calendar: calendar)
        start = min(start, Int(current.rounded(.down)))
        end = max(end, Int(current.rounded(.up)))
        return Window(startHour: max(0, start), endHour: min(24, max(end, start + 4)))
    }

    private static func fraction(_ hour: Double, _ window: Window) -> Double {
        let span = Double(window.endHour - window.startHour)
        guard span > 0 else { return 0 }
        return min(1, max(0, (hour - Double(window.startHour)) / span))
    }

    /// Where "now" sits on the ribbon, or nil when it is off the drawn window.
    static func nowMarker(_ now: Date, _ window: Window, calendar: Calendar = .current) -> Double? {
        let current = hour(of: now, calendar: calendar)
        guard current >= Double(window.startHour), current <= Double(window.endHour) else { return nil }
        return fraction(current, window)
    }

    static func blocks(
        events: [CalendarEventSummary],
        window: Window,
        calendar: Calendar = .current,
        formatter: DateFormatter? = nil
    ) -> [Block] {
        let time = formatter ?? {
            let made = DateFormatter()
            made.dateFormat = "h:mm a"
            return made
        }()
        return events
            .filter { !$0.allDay }
            .map { event in
                let top = fraction(hour(of: event.start, calendar: calendar), window)
                let bottom = fraction(hour(of: event.end, calendar: calendar), window)
                return Block(
                    id: event.id,
                    title: event.title,
                    top: top,
                    height: max(bottom - top, minimumBlockHeight),
                    label: "\(time.string(from: event.start)) – \(time.string(from: event.end))",
                    location: event.location
                )
            }
            .sorted { $0.top < $1.top }
    }

    /// Make the drawn blocks legible without lying about the day.
    ///
    /// Two problems only appear once the ribbon has a real pixel height. A
    /// quarter-hour block is shorter than the two lines of text inside it, so
    /// the text gets cut in half. And a stand-up at nine followed by a review at
    /// half past nine are close enough that the first block's minimum height
    /// runs into the second.
    ///
    /// So: anything with less room than `twoLineHeight` is marked compact and
    /// drawn on one line, nothing is drawn shorter than `minHeight`, and a block
    /// that would run into the one above it is nudged down to clear it. The
    /// label always states the true time, so a nudge changes the drawing, never
    /// the claim.
    static func stack(_ blocks: [Block], minHeight: Double, twoLineHeight: Double? = nil) -> [Block] {
        let twoLine = twoLineHeight ?? minHeight
        var stacked: [Block] = []
        var floor = 0.0
        for block in blocks {
            var placed = block
            placed.compact = block.height < twoLine
            placed.height = min(max(block.height, minHeight), 1)
            placed.top = min(max(block.top, floor), max(0, 1 - placed.height))
            stacked.append(placed)
            floor = placed.top + placed.height
        }
        return stacked
    }

    static func describe(minutes: Int) -> String {
        let hours = minutes / 60
        let rest = minutes % 60
        if hours > 0 && rest >= 15 { return "\(hours)h \(rest)m free" }
        if hours > 0 { return hours == 1 ? "1 hour free" : "\(hours) hours free" }
        return "\(minutes)m free"
    }

    /// The open air between commitments — the part a plain agenda never shows,
    /// and the part that decides whether anything can move today.
    static func gaps(
        blocks: [Block],
        window: Window,
        now: Date,
        calendar: Calendar = .current
    ) -> [Gap] {
        let spanMinutes = Double(window.endHour - window.startHour) * 60
        // Start from now rather than from the top: time already gone is not open.
        var cursor = max(0, nowMarker(now, window, calendar: calendar) ?? 0)
        var found: [Gap] = []
        for block in blocks {
            if block.top > cursor {
                let minutes = Int(((block.top - cursor) * spanMinutes).rounded())
                if minutes >= minimumOpeningMinutes {
                    found.append(
                        Gap(top: cursor, height: block.top - cursor, minutes: minutes, label: describe(minutes: minutes))
                    )
                }
            }
            cursor = max(cursor, block.top + block.height)
        }
        if cursor < 1 {
            let minutes = Int(((1 - cursor) * spanMinutes).rounded())
            if minutes >= minimumOpeningMinutes {
                found.append(Gap(top: cursor, height: 1 - cursor, minutes: minutes, label: describe(minutes: minutes)))
            }
        }
        return found
    }

    /// Hour ticks, thinned out so a long day does not turn into noise.
    static func ticks(_ window: Window) -> [Tick] {
        let span = window.endHour - window.startHour
        let step = span > 12 ? 3 : (span > 8 ? 2 : 1)
        var made: [Tick] = []
        var hour = window.startHour
        while hour <= window.endHour {
            let display = hour % 12 == 0 ? 12 : hour % 12
            let suffix = hour >= 12 && hour < 24 ? "pm" : "am"
            made.append(Tick(hour: hour, top: fraction(Double(hour), window), label: "\(display)\(suffix)"))
            hour += step
        }
        return made
    }

    /// One honest sentence about how much of the day is actually open.
    static func openAirLine(_ gaps: [Gap]) -> String {
        guard let longest = gaps.max(by: { $0.minutes < $1.minutes }) else {
            return "No real openings left today."
        }
        if gaps.count == 1 { return "One opening left — \(describe(minutes: longest.minutes))." }
        let total = gaps.reduce(0) { $0 + $1.minutes }
        return "\(gaps.count) openings left, \(describe(minutes: total)) in all."
    }
}

/// The ribbon itself.
///
/// Fixed blocks are solid and sit against an hour rail. Open air is dashed and
/// labelled with what it is worth. The now-line is the one live element on the
/// screen, so the eye finds the present before it reads anything.
struct DayRibbonView: View {
    let events: [CalendarEventSummary]
    var now: Date
    var height: CGFloat = 300
    var onSelect: ((CalendarEventSummary) -> Void)?

    private var allDay: [CalendarEventSummary] { events.filter(\.allDay) }

    var body: some View {
        let window = DayRibbon.window(events: events, now: now)
        // One line of text needs about 26 points and two lines need about 42. A
        // block with room for neither cannot carry a title, so the drawing gives
        // it the room rather than cut the words in half.
        let blocks = DayRibbon.stack(
            DayRibbon.blocks(events: events, window: window),
            minHeight: 26 / Double(height),
            twoLineHeight: 42 / Double(height)
        )
        let gaps = DayRibbon.gaps(blocks: blocks, window: window, now: now)
        let ticks = DayRibbon.ticks(window)
        let marker = DayRibbon.nowMarker(now, window)

        VStack(alignment: .leading, spacing: 8) {
            ForEach(allDay) { event in
                HStack(spacing: 8) {
                    Rectangle().fill(Color.accentColor).frame(width: 2)
                    Text(event.title)
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(Color.accentColor)
                    Text("all day")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 5)
                .padding(.trailing, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.accentColor.opacity(0.08))
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            }

            GeometryReader { geometry in
                let full = geometry.size.height
                HStack(alignment: .top, spacing: 0) {
                    // Hour rail: small, quiet, the only numerals on the surface.
                    ZStack(alignment: .topLeading) {
                        Color.clear
                        ForEach(ticks) { tick in
                            Text(tick.label)
                                .font(.system(size: 10, design: .monospaced))
                                .monospacedDigit()
                                .foregroundStyle(.tertiary)
                                // Centre the numeral on its rule.
                                .offset(y: tick.top * full - 6)
                        }
                    }
                    .frame(width: 36)

                    ZStack(alignment: .topLeading) {
                        Color.clear
                        ForEach(ticks) { tick in
                            Rectangle()
                                .fill(Color.secondary.opacity(0.15))
                                .frame(height: 1)
                                .offset(y: tick.top * full)
                        }

                        // Open air, dashed — never a promise, only room.
                        ForEach(Array(gaps.enumerated()), id: \.offset) { _, gap in
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .strokeBorder(
                                    Color.secondary.opacity(0.4),
                                    style: StrokeStyle(lineWidth: 1, dash: [4, 4])
                                )
                                .frame(height: max(gap.height * full, 18))
                                .overlay(
                                    Text(gap.label)
                                        .font(.caption2)
                                        .foregroundStyle(.tertiary)
                                )
                                .offset(y: gap.top * full)
                        }

                        // The now-line runs behind the blocks. Over them it reads
                        // as a rule struck through the title of whatever meeting
                        // you are in.
                        if let marker {
                            Rectangle()
                                .fill(Color.accentColor.opacity(0.7))
                                .frame(height: 1)
                                .offset(y: marker * full)
                                .allowsHitTesting(false)
                                .accessibilityHidden(true)
                        }

                        // Fixed blocks, solid — somebody is expecting these.
                        ForEach(blocks) { block in
                            blockView(block, height: max(block.height * full, 22))
                                .offset(y: block.top * full)
                        }

                        // Only the cap sits on top, so the present is still the
                        // first thing the eye finds.
                        if let marker {
                            Circle()
                                .fill(Color.accentColor)
                                .frame(width: 6, height: 6)
                                .offset(x: -3, y: marker * full - 3)
                                .allowsHitTesting(false)
                                .accessibilityHidden(true)
                        }
                    }
                    .padding(.leading, 8)
                    .overlay(alignment: .leading) {
                        Rectangle().fill(Color.secondary.opacity(0.2)).frame(width: 1)
                    }
                }
            }
            .frame(height: height)

            Text(DayRibbon.openAirLine(gaps))
                .font(.caption)
                .foregroundStyle(gaps.isEmpty ? .tertiary : .secondary)
        }
    }

    @ViewBuilder
    private func blockView(_ block: DayRibbon.Block, height: CGFloat) -> some View {
        // A short block puts its title and time on one line rather than cutting
        // the words in half.
        let content = Group {
            if block.compact {
                HStack(spacing: 8) {
                    Text(block.title)
                        .font(.footnote.weight(.medium))
                        .lineLimit(1)
                    Text(block.label)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .layoutPriority(1)
                }
            } else {
                VStack(alignment: .leading, spacing: 1) {
                    Text(block.title)
                        .font(.footnote.weight(.medium))
                        .lineLimit(1)
                    Text(block.location.map { "\(block.label) · \($0)" } ?? block.label)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, block.compact ? 0 : 6)
        .frame(
            maxWidth: .infinity,
            minHeight: height,
            maxHeight: height,
            alignment: block.compact ? .leading : .topLeading
        )
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Color(.secondarySystemGroupedBackground))
        )
        // A leading bar on each booked block. It reads as a spine down the
        // day, and it separates what somebody expects of you from open air at a
        // glance, before any word is read.
        .overlay(alignment: .leading) {
            Rectangle()
                .fill(Color.accentColor)
                .frame(width: 2)
                .padding(.vertical, 2)
        }
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(Color.secondary.opacity(0.18))
        )
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))

        if let onSelect, let event = events.first(where: { $0.id == block.id }) {
            Button { onSelect(event) } label: { content }
                .buttonStyle(.plain)
        } else {
            content
        }
    }
}
