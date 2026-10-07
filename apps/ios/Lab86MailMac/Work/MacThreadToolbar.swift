import SwiftUI

// The toolbar of the Albatross thread on the Mac: the plan line after the
// title, then the Page and Details toggles and the menu at the trailing
// edge. The plan line is text on purpose: it is the one item the pointer
// must read without a tooltip. The toggles are glyphs, as Mac toolbar items
// are; the no-icon rule is for buttons with text in the content. Design
// note: docs/research/albatross-thread-macos-design-2026-10-07.md, 2.3.

/// The words of the toolbar.
enum MacThreadToolbarCopy {
    static let showPage = "Show the page (Control-Command-P)"
    static let hidePage = "Hide the page (Control-Command-P)"
    static let noPage = "No page yet"
    static let showDetails = "Show the details (Control-Command-I)"
    static let hideDetails = "Hide the details (Control-Command-I)"
    static let plan = "Shows the plan"

    static func pageHelp(mode: MacThreadPaneMode, hasPage: Bool) -> String {
        if mode == .page { return hidePage }
        return hasPage ? showPage : noPage
    }

    static func detailsHelp(mode: MacThreadPaneMode) -> String {
        mode == .details ? hideDetails : showDetails
    }
}

struct MacThreadToolbar<Plan: View, Details: View>: ToolbarContent {
    let planLine: String
    let planAvailable: Bool
    @Binding var showsPlan: Bool
    let paneMode: MacThreadPaneMode
    let pageAvailable: Bool
    /// The dot at the page glyph while a page is live but not on screen.
    let pageDot: Color?
    @Binding var showsDetailsPopover: Bool
    let busy: Bool
    let isPaused: Bool
    let onTogglePage: () -> Void
    let onToggleDetails: () -> Void
    let onSplit: () -> Void
    let onPutDown: () -> Void
    let onPickUp: () -> Void
    let onHorizon: () -> Void
    let onMarkDone: () -> Void
    let onArchive: () -> Void
    @ViewBuilder let planPopover: () -> Plan
    @ViewBuilder let detailsPopover: () -> Details

    var body: some ToolbarContent {
        ToolbarItem(placement: .navigation) {
            Button {
                showsPlan = true
            } label: {
                HStack(spacing: 4) {
                    Text(planLine)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.tertiary)
                        .accessibilityHidden(true)
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .disabled(!planAvailable)
            .help(MacThreadToolbarCopy.plan)
            .accessibilityLabel("Plan: \(planLine)")
            .accessibilityHint("Opens the steps")
            .popover(isPresented: $showsPlan, arrowEdge: .bottom) {
                planPopover()
            }
        }
        ToolbarItemGroup(placement: .primaryAction) {
            Button(action: onTogglePage) {
                Label("Page", systemImage: "globe")
                    .labelStyle(.iconOnly)
                    .overlay(alignment: .topTrailing) {
                        if let pageDot {
                            Circle()
                                .fill(pageDot)
                                .frame(width: 6, height: 6)
                                .offset(x: 3, y: -3)
                                .accessibilityHidden(true)
                        }
                    }
            }
            .disabled(!pageAvailable && paneMode != .page)
            .help(MacThreadToolbarCopy.pageHelp(mode: paneMode, hasPage: pageAvailable))
            .accessibilityLabel("Page")
            .accessibilityValue(paneMode == .page ? "Open" : "Closed")

            Button(action: onToggleDetails) {
                Label("Details", systemImage: "sidebar.trailing")
                    .labelStyle(.iconOnly)
            }
            .help(MacThreadToolbarCopy.detailsHelp(mode: paneMode))
            .accessibilityLabel("Details")
            .accessibilityValue(paneMode == .details ? "Open" : "Closed")
            .popover(isPresented: $showsDetailsPopover, arrowEdge: .bottom) {
                detailsPopover()
            }

            Menu {
                Button("Split…", action: onSplit)
                if isPaused {
                    Button("Pick it up", action: onPickUp)
                } else {
                    Button("Put it down", action: onPutDown)
                }
                Button("Set horizon…", action: onHorizon)
                Button("Mark done", action: onMarkDone)
                Divider()
                Button("Archive…", role: .destructive, action: onArchive)
            } label: {
                Label("More", systemImage: "ellipsis.circle")
                    .labelStyle(.iconOnly)
            }
            .disabled(busy)
        }
    }
}
