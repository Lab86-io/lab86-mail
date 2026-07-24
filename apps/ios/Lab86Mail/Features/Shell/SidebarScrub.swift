import SwiftUI
import UIKit

// MARK: - Destinations

// Where a sidebar scrub can land. Only navigable rows are destinations —
// section headers, dividers, loading/error rows, and action buttons are never
// scrub stops.
enum SidebarDestination: Hashable, Identifiable {
    case primary(PrimaryTab)
    case mail(MailCategoryScope)
    case area(id: String, name: String)
    case settings

    var id: String {
        switch self {
        case .primary(let tab): "primary.\(tab.rawValue)"
        case .mail(let scope): "mail.\(scope.rawValue)"
        case .area(let id, _): "area.\(id)"
        case .settings: "settings"
        }
    }

    var title: String {
        switch self {
        case .primary(let tab): tab.title
        case .mail(let scope): scope.title
        case .area(_, let name): name
        case .settings: "Settings"
        }
    }
}

// MARK: - Scrub session state

// One scrub session: `previewed` follows the thumb, `committed` remembers the
// selection to restore on cancel. Previews are never real navigation — the
// NavigationModel only changes on commit().
struct SidebarScrubState: Equatable {
    private(set) var committed: SidebarDestination?
    private(set) var previewed: SidebarDestination?
    private(set) var isActive = false
    // The page preview stays hidden until the finger crosses into another row
    // or the ready delay elapses — a plain tap never flashes it.
    private(set) var previewReady = false

    mutating func activate(over destination: SidebarDestination?, committed current: SidebarDestination?) {
        isActive = true
        committed = current
        previewed = destination
    }

    mutating func markPreviewReady() {
        guard isActive else { return }
        previewReady = true
    }

    // Moves the highlight; returns true when the thumb actually crossed into
    // a new row (that's the selection-haptic trigger). Gaps between rows keep
    // the current highlight rather than clearing it. Any crossing makes the
    // preview ready immediately.
    mutating func move(to destination: SidebarDestination?) -> Bool {
        guard isActive, let destination, destination != previewed else { return false }
        previewed = destination
        previewReady = true
        return true
    }

    // Ends the session, returning the destination to navigate to (nil when
    // nothing was previewed).
    mutating func commit() -> SidebarDestination? {
        defer { self = SidebarScrubState() }
        return isActive ? previewed : nil
    }

    // Cancels without navigating; the prior committed selection stands.
    mutating func cancel() {
        self = SidebarScrubState()
    }
}

// MARK: - Pure gesture rules

// The scrub's geometry rules, extracted so crossing/cancel math is
// unit-testable without SwiftUI.
enum SidebarScrubLogic {
    static let cancelSlop: CGFloat = 44
    static let edgeZone: CGFloat = 40
    // How long a stationary touch waits before the page preview appears.
    static let previewDelayMilliseconds = 250

    // The row under the thumb; frames are in the sidebar's named space.
    static func destination(
        at point: CGPoint,
        rows: [SidebarDestination: CGRect]
    ) -> SidebarDestination? {
        rows.first { $0.value.contains(point) }?.key
    }

    // Cancel when the thumb leaves the sidebar bounds by MORE than the slop —
    // exactly-at-the-slop stays in (CGRect.contains would exclude the max
    // edge, cancelling at 44pt rather than beyond it).
    static func isOutside(location: CGPoint, sidebarBounds: CGRect, slop: CGFloat = cancelSlop) -> Bool {
        let expanded = sidebarBounds.insetBy(dx: -slop, dy: -slop)
        return location.x < expanded.minX || location.x > expanded.maxX
            || location.y < expanded.minY || location.y > expanded.maxY
    }

    // Cancel on a dominant horizontal movement — that's the sidebar
    // reveal/dismiss language, not a scrub.
    static func isHorizontalDismissal(translation: CGSize) -> Bool {
        abs(translation.width) > 56 && abs(translation.width) > abs(translation.height) * 2
    }

    enum EdgeZone: Equatable { case top, bottom }

    // The scroll viewport's edge bands advance the wheel by one destination.
    // This keeps every Area reachable without turning the direct scrub into a
    // competing pan gesture.
    static func autoscrollZone(forY y: CGFloat, in bounds: CGRect, zone: CGFloat = edgeZone) -> EdgeZone? {
        guard bounds.height > zone * 2 else { return nil }
        if y < bounds.minY + zone { return .top }
        if y > bounds.maxY - zone { return .bottom }
        return nil
    }

    static func autoscrollTarget(
        from current: SidebarDestination?,
        in ordered: [SidebarDestination],
        zone: EdgeZone
    ) -> SidebarDestination? {
        guard let current, let index = ordered.firstIndex(of: current) else { return nil }
        switch zone {
        case .top: return index > 0 ? ordered[index - 1] : nil
        case .bottom: return index + 1 < ordered.count ? ordered[index + 1] : nil
        }
    }

    static func autoscrollTargets(
        from current: SidebarDestination?,
        in ordered: [SidebarDestination],
        zone: EdgeZone,
        steps: Int
    ) -> [SidebarDestination] {
        guard steps > 0 else { return [] }
        var cursor = current
        var targets: [SidebarDestination] = []
        for _ in 0..<steps {
            guard let next = autoscrollTarget(from: cursor, in: ordered, zone: zone),
                  isAutoscrollable(next) else { break }
            targets.append(next)
            cursor = next
        }
        return targets
    }

    static func isAutoscrollable(_ destination: SidebarDestination) -> Bool {
        destination != .settings
    }

    // A restrained cylindrical projection inspired by the system wheel
    // picker. Only the active scrub neighborhood receives depth. The selected
    // row remains face-on; nearby rows curve away without losing legibility.
    static func wheelTransform(
        distance: Int?,
        reduceMotion: Bool
    ) -> SidebarWheelTransform {
        guard let distance else { return .identity }
        let clamped = max(-3, min(3, distance))
        guard !reduceMotion else {
            return SidebarWheelTransform(
                rotationDegrees: 0,
                scale: clamped == 0 ? 1.025 : 1,
                opacity: clamped == 0 ? 1 : 0.82,
                offsetY: 0
            )
        }
        let magnitude = CGFloat(abs(clamped))
        return SidebarWheelTransform(
            rotationDegrees: Double(clamped) * -10,
            scale: max(0.90, 1.035 - magnitude * 0.035),
            opacity: max(0.58, 1 - Double(magnitude) * 0.13),
            offsetY: CGFloat(clamped) * -1.5
        )
    }
}

// MARK: - Row visual treatment

struct SidebarWheelTransform: Equatable {
    let rotationDegrees: Double
    let scale: CGFloat
    let opacity: Double
    let offsetY: CGFloat

    static let identity = SidebarWheelTransform(
        rotationDegrees: 0,
        scale: 1,
        opacity: 1,
        offsetY: 0
    )
}

// The magnetic pick-up: the scrubbed row's capsule expands 2–3pt, contents
// scale ~1.025, text turns semibold and slightly brighter — layout and hit
// target stay fixed; only the visual treatment expands. Reduce Motion drops
// the scale and spring but keeps weight, highlight, and selection semantics.
private struct SidebarScrubHighlight: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let active: Bool

    func body(content: Content) -> some View {
        content
            .fontWeight(active ? .semibold : nil)
            .brightness(active ? 0.05 : 0)
            .background {
                if active {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(Color.primary.opacity(0.10))
                        .padding(-2.5)
                }
            }
            .scaleEffect(active && !reduceMotion ? 1.025 : 1)
            .animation(
                reduceMotion ? nil : .spring(response: 0.22, dampingFraction: 0.75),
                value: active
            )
    }
}

extension View {
    func sidebarScrubHighlight(_ active: Bool) -> some View {
        modifier(SidebarScrubHighlight(active: active))
    }
}

private struct SidebarScrubWheel: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let distance: Int?

    func body(content: Content) -> some View {
        let transform = SidebarScrubLogic.wheelTransform(
            distance: distance,
            reduceMotion: reduceMotion
        )
        content
            .rotation3DEffect(
                .degrees(transform.rotationDegrees),
                axis: (x: 1, y: 0, z: 0),
                perspective: reduceMotion ? 0 : 0.72
            )
            .scaleEffect(transform.scale)
            .opacity(transform.opacity)
            .offset(y: transform.offsetY)
            .animation(
                reduceMotion ? nil : .spring(response: 0.20, dampingFraction: 0.82),
                value: distance
            )
    }
}

extension View {
    func sidebarScrubWheel(distance: Int?) -> some View {
        modifier(SidebarScrubWheel(distance: distance))
    }
}

// Reports a scrub row's frame (in the sidebar's named coordinate space) into
// the shared frame table used for hit-testing.
struct SidebarScrubRowFrame: ViewModifier {
    let destination: SidebarDestination
    @Binding var frames: [SidebarDestination: CGRect]

    func body(content: Content) -> some View {
        content
            .onGeometryChange(for: CGRect.self) { proxy in
                proxy.frame(in: .named(SidebarScrubCoordinateSpace.name))
            } action: { frame in
                frames[destination] = frame
            }
    }
}

enum SidebarScrubCoordinateSpace {
    static let name = "sidebarScrub"
}

extension View {
    func sidebarScrubRow(
        _ destination: SidebarDestination,
        frames: Binding<[SidebarDestination: CGRect]>
    ) -> some View {
        modifier(SidebarScrubRowFrame(destination: destination, frames: frames))
    }
}

// MARK: - Previews

// Read-only preview of a destination, rendered from data ProductStore already
// holds. Previews run no tasks, no network loads, no analytics, and no writes
// — releasing the thumb performs the one real navigation.
struct SidebarDestinationPreview: View {
    @Environment(AppEnvironment.self) private var environment
    let destination: SidebarDestination

    private var store: ProductStore { environment.store }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header
                content
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollDisabled(true)
        .background(environment.theme.paperColor)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Preview of \(destination.title)")
    }

    private var header: some View {
        Text(destination.title)
            .font(environment.theme.displayType.displayFont(size: 26))
            .lineLimit(1)
    }

    @ViewBuilder private var content: some View {
        switch destination {
        case .primary(.today):
            if let report = store.dailyReport {
                Text(report.document?.title ?? report.title)
                    .font(.headline)
                if let summary = report.document?.summary, !summary.isEmpty {
                    Text(summary)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(4)
                }
            } else {
                quiet("Your day, assembled each morning.")
            }
        case .primary(.tasks):
            let columns = store.taskColumns.isEmpty
                ? Array(Set(store.tasks.map(\.column))).sorted()
                : store.taskColumns
            if columns.isEmpty {
                quiet("No board loaded yet.")
            } else {
                ForEach(columns.prefix(4), id: \.self) { column in
                    let count = store.tasks.filter { $0.column == column && !$0.completed }.count
                    row(title: column, detail: "\(count) open")
                }
            }
        case .primary(.calendar):
            let events = store.todaysEvents
            if events.isEmpty {
                quiet("Nothing scheduled today.")
            } else {
                ForEach(events.prefix(5)) { event in
                    row(
                        title: event.title,
                        detail: event.allDay
                            ? "All day"
                            : event.start.formatted(date: .omitted, time: .shortened)
                    )
                }
            }
        case .primary(.work):
            if store.areas.isEmpty {
                quiet("No areas yet.")
            } else {
                ForEach(store.areas.prefix(5)) { area in
                    row(title: area.name, detail: area.overview?.statusLine ?? area.kind.capitalized)
                }
            }
        case .primary:
            quiet("")
        case .mail(let scope):
            let threads = store.threads.filter { scope.includes(storedCategory: $0.category) }
            if threads.isEmpty {
                quiet("No mail here right now.")
            } else {
                ForEach(threads.prefix(5)) { thread in
                    row(title: thread.sender, detail: thread.subject)
                }
            }
        case .area(let id, _):
            if let area = store.areas.first(where: { $0.id == id }) {
                if let line = area.overview?.statusLine ?? area.detail {
                    Text(line)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                if let overview = area.overview, overview.needsAttention {
                    Label("Needs attention", systemImage: "circle.fill")
                        .font(.caption)
                        .foregroundStyle(environment.theme.accent2Color)
                }
            } else {
                quiet("Area overview")
            }
        case .settings:
            // Static landing summary; releasing opens the Settings sheet.
            row(title: "Appearance", detail: "Palette, type, and mode")
            row(title: "Mailboxes", detail: "Accounts and sync")
            row(title: "Notifications", detail: "What reaches you")
        }
    }

    private func quiet(_ text: String) -> some View {
        Text(text)
            .font(.subheadline)
            .foregroundStyle(.secondary)
    }

    private func row(title: String, detail: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.subheadline.weight(.medium))
                .lineLimit(1)
            if !detail.isEmpty {
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
