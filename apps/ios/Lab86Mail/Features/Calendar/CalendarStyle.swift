import SwiftUI

// The shared look of the calendar's grids: an event in its calendar's own
// colour, the flat tinted block with its leading edge, the day numeral of the
// strips, the bar title in the product's two voices, the reconnect banner,
// and the sync notice. The day, week, month, and Mac month views draw from
// here so one calendar reads the same way everywhere.

// MARK: - Calendar colours

// An event takes the colour of its calendar. The provider colour wins; a
// calendar without one takes a stable colour from the theme's avatar family,
// so one calendar is one colour across every grid.
@MainActor
struct CalendarColors {
    private let theme: ThemeStore
    private let byKey: [String: Color]
    // The provider hex of each calendar, kept for `key`.
    private let hexByKey: [String: String]

    init(choices: [CalendarChoice], theme: ThemeStore) {
        self.theme = theme
        var map: [String: Color] = [:]
        var hexes: [String: String] = [:]
        for choice in choices {
            if let hex = choice.hexColor, let rgb = CalendarPalette.rgb(hex: hex) {
                map[choice.id] = Color(red: rgb.red, green: rgb.green, blue: rgb.blue)
                hexes[choice.id] = hex
            }
        }
        byKey = map
        hexByKey = hexes
    }

    // A stable identity for HorizonCalendar's data dependency: it changes
    // when a calendar gains or loses a colour, and when its colour changes.
    var key: String {
        Self.key(hexByKey)
    }

    nonisolated static func key(_ hexByKey: [String: String]) -> String {
        hexByKey.keys.sorted().map { "\($0)=\(hexByKey[$0] ?? "")" }.joined(separator: ",")
    }

    func color(forKey key: String?, seed: String) -> Color {
        if let key, let color = byKey[key] { return color }
        return theme.avatarColor(seed: seed)
    }

    func color(for event: CalendarEventSummary) -> Color {
        color(forKey: CalendarVisibility.key(for: event), seed: DayChips.seed(for: event))
    }

    func color(for chip: DayChips.Chip) -> Color {
        if chip.kind == .task { return theme.accentColor }
        return color(forKey: chip.calendarKey, seed: chip.seed)
    }
}

// MARK: - Block style

extension View {
    // A flat tinted insert with a leading colour edge: the calendar colour at
    // low opacity under the text and the full colour as a thin edge. No
    // shadow, no stroke; the colour and the shape carry it.
    func calendarBlock(tint: Color, cornerRadius: CGFloat, edge: CGFloat = 3) -> some View {
        background(tint.opacity(0.16))
            .overlay(alignment: .leading) {
                Rectangle()
                    .fill(tint)
                    .frame(width: edge)
            }
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
    }

    // A new event wears a dashed 1 pt border until the server copy lands. The
    // border then cross-fades away and the solid block remains.
    func pendingServerCopyBorder(_ isPending: Bool, accent: Color, cornerRadius: CGFloat) -> some View {
        overlay {
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .strokeBorder(accent, style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
                .opacity(isPending ? 1 : 0)
        }
        .animation(.easeInOut(duration: 0.18), value: isPending)
    }
}

extension Int {
    func roundedToMultiple(_ multiple: Int) -> Int {
        guard multiple > 0 else { return self }
        return Int((Double(self) / Double(multiple)).rounded()) * multiple
    }
}

// MARK: - Day numeral

// The number of a day in the week strip and the week header. The circle and
// the numeral both scale with the text; at accessibility sizes the circle
// gives way to a bar under today and a soft field behind the selection, so
// the numeral never cuts to "…" (D2).
struct DayNumeral: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .body) private var circle: CGFloat = 32
    @ScaledMetric(relativeTo: .body) private var numeralSize: CGFloat = 17

    let text: String
    let isToday: Bool
    let isSelected: Bool
    // The week strip fills the selected day; the week header fills today and
    // only softens the selected day, because its selection is secondary.
    var fillsSelection = true

    private var fills: Bool { fillsSelection ? isSelected : isToday }
    private var softens: Bool { fillsSelection ? false : (isSelected && !isToday) }
    private var emphasised: Bool { isToday || isSelected }

    var body: some View {
        if dynamicTypeSize.isAccessibilitySize {
            accessibleNumeral
        } else {
            circledNumeral
        }
    }

    private var circledNumeral: some View {
        let side = min(circle, 40)
        return Text(text)
            .font(.callout.weight(emphasised ? .semibold : .regular))
            .monospacedDigit()
            .lineLimit(1)
            .minimumScaleFactor(0.7)
            .foregroundStyle(numeralColor)
            .frame(width: side, height: side)
            .background { circleField }
    }

    private var accessibleNumeral: some View {
        Text(text)
            .font(.system(
                size: DayNumeralSize.accessibleFontSize(scaled: numeralSize),
                weight: emphasised ? .semibold : .regular
            ))
            .monospacedDigit()
            .lineLimit(1)
            .foregroundStyle(isToday || fills ? environment.theme.accentColor : .primary)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background {
                if fills || softens {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(environment.theme.accentSoftColor)
                }
            }
            .overlay(alignment: .bottom) {
                if isToday {
                    Capsule()
                        .fill(environment.theme.accentColor)
                        .frame(height: 2)
                        .padding(.horizontal, 6)
                }
            }
    }

    private var numeralColor: Color {
        if fills { return environment.theme.paperColor }
        if isToday || softens { return environment.theme.accentColor }
        return .primary
    }

    @ViewBuilder private var circleField: some View {
        if fills {
            Circle().fill(environment.theme.accentColor)
        } else if softens {
            Circle().fill(environment.theme.accentSoftColor)
        }
    }
}

// MARK: - Bar title

// The calendar's inline title: the month in the display face, and under it
// the freshness in the display italic, the same two voices as the chat. The
// lines shrink before they cut at accessibility sizes.
struct CalendarBarTitle: View {
    @Environment(AppEnvironment.self) private var environment
    @ScaledMetric(relativeTo: .headline) private var titleSize: CGFloat = 17
    @ScaledMetric(relativeTo: .footnote) private var datelineSize: CGFloat = 13

    let title: String
    let dateline: String

    var body: some View {
        VStack(spacing: 0) {
            if !title.isEmpty {
                Text(title)
                    .font(environment.theme.displayType.fixedDisplayFont(size: min(titleSize, 22)))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
            Text(dateline)
                .font(environment.theme.displayType.fixedDisplayItalicFont(size: min(datelineSize, 16)))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

// MARK: - Reconnect banner

// One row for each account whose calendar sign-in ended. The row says what
// stopped and offers the one action that fixes it. Nothing shows when every
// account is authorized.
struct CalendarReconnectBanner: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var reconnectingID: String?

    private var accounts: [AccountSummary] {
        CalendarReconnect.accounts(
            unauthorizedIDs: environment.store.calendarUnauthorizedAccountIDs,
            accounts: environment.store.accounts
        )
    }

    var body: some View {
        let rows = accounts
        if !rows.isEmpty {
            VStack(spacing: 8) {
                ForEach(rows) { account in
                    row(account)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
    }

    @ViewBuilder private func row(_ account: AccountSummary) -> some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 8) {
                    message(account)
                    button(account)
                }
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    message(account)
                    Spacer(minLength: 8)
                    button(account)
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .insetPanel(cornerRadius: 12)
    }

    private func message(_ account: AccountSummary) -> some View {
        Text(CalendarReconnect.message(for: account))
            .font(.footnote)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func button(_ account: AccountSummary) -> some View {
        Button(reconnectingID == account.id ? "Reconnecting…" : "Reconnect") {
            Task { await reconnect(account) }
        }
        .font(.footnote.weight(.semibold))
        .buttonStyle(.plain)
        .foregroundStyle(environment.theme.accentColor)
        .disabled(reconnectingID != nil)
    }

    private func reconnect(_ account: AccountSummary) async {
        reconnectingID = account.id
        defer { reconnectingID = nil }
        do {
            try await environment.webAuthentication.connectMailbox(provider: account.provider, accountId: account.id)
            await environment.store.refreshCalendarChoices()
            await environment.store.resyncCalendar(reason: .manualHTTP, accountID: account.id)
        } catch {
            // The sign-in sheet reports its own failure; the row stays.
        }
    }
}

// MARK: - Sync notice

// What went wrong with the sync, and the one action that tries again.
struct CalendarNotice: View {
    @Environment(AppEnvironment.self) private var environment
    let message: String
    let onSync: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(message)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button("Sync now", action: onSync)
                .font(.footnote.weight(.semibold))
                .buttonStyle(.plain)
                .foregroundStyle(environment.theme.accentColor)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .insetPanel(cornerRadius: 12)
        .accessibilityElement(children: .contain)
    }
}
