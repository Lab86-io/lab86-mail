#if os(iOS)
import SwiftUI
import UIKit

struct AppShellView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var showsSourceList = false
    @GestureState private var sourceListDragOffset: CGFloat = 0

    var body: some View {
        @Bindable var navigation = environment.navigation
        Group {
            if horizontalSizeClass == .regular {
                regularWidthShell
            } else {
                compactWidthShell
            }
        }
        .overlay(alignment: .bottom) {
            ShellStatusOverlay()
                .padding(.horizontal, 16)
                .padding(.bottom, max(windowSafeAreaInsets.bottom, 12))
        }
        .task {
            BackgroundRefreshCoordinator.shared.install {
                let ownerID = environment.sessionStore.ownerID
                let outboxSucceeded = await environment.flushCommandOutbox(ownerID: ownerID)
                let accountsSucceeded = if let ownerID {
                    await environment.refreshAccounts(ownerID: ownerID)
                } else {
                    true
                }
                await environment.store.bootstrap(cacheOwner: ownerID)
                return outboxSucceeded && accountsSucceeded && environment.store.errorMessage == nil
            }
            let ownerID = environment.sessionStore.ownerID
            _ = await environment.flushCommandOutbox(ownerID: ownerID)
            if let ownerID {
                _ = await environment.refreshAccounts(ownerID: ownerID)
            }
            await environment.store.bootstrap(cacheOwner: ownerID)
            await environment.notifications.refreshAuthorizationStatus()
            await environment.notifications.retryPendingTextResponses()
            environment.navigation.consumeAppIntentRequests()
            await consumeMailNotificationAction()
            await environment.pendingSends.reconcile(ownerID: environment.sessionStore.ownerID)
            BackgroundRefreshCoordinator.shared.schedule()
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
            environment.navigation.consumeAppIntentRequests()
            BackgroundRefreshCoordinator.shared.schedule()
            Task {
                await environment.notifications.retryPendingTextResponses()
                await consumeMailNotificationAction()
                await environment.pendingSends.reconcile(ownerID: environment.sessionStore.ownerID)
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .lab86MailNotificationAction)) { _ in
            Task { await consumeMailNotificationAction() }
        }
        .sheet(item: $navigation.sheet) { destination in
            switch destination {
            case .assistant:
                AssistantView()
            case .activity:
                ActivityView()
            case .compose:
                ComposeView()
            case .settings:
                SettingsView()
            }
        }
        .alert(
            "Albatross couldn’t finish that",
            isPresented: Binding(
                get: { environment.store.errorMessage != nil },
                set: { if !$0 { environment.store.clearError() } }
            )
        ) {
            Button("OK") { environment.store.clearError() }
        } message: {
            Text(environment.store.errorMessage ?? "Try again.")
        }
        .alert(
            "Pending message",
            isPresented: Binding(
                get: { environment.pendingSends.errorMessage != nil },
                set: { if !$0 { environment.pendingSends.errorMessage = nil } }
            )
        ) {
            Button("OK") { environment.pendingSends.errorMessage = nil }
        } message: {
            Text(environment.pendingSends.errorMessage ?? "Albatross will check again.")
        }
    }

    private var regularWidthShell: some View {
        NavigationSplitView {
            SourceList(isActive: true, onSelect: {
                // Selection updates the detail immediately; the regular-width
                // source list remains visible.
            })
            .navigationSplitViewColumnWidth(min: 250, ideal: 290, max: 360)
        } detail: {
            // The destination renders on commit and not before. Building a
            // preview per crossing meant a full view teardown and a synchronous
            // store query inside the gesture, several times a second.
            destinationStack(showsNavigationButton: false)
        }
        .navigationSplitViewStyle(.balanced)
    }

    private var compactWidthShell: some View {
        GeometryReader { geometry in
            let revealWidth = min(max(geometry.size.width * 0.82, 286), 332)
            let baseOffset = showsSourceList ? revealWidth : 0
            let pageOffset = min(max(baseOffset + sourceListDragOffset, 0), revealWidth)
            let revealProgress = revealWidth > 0 ? pageOffset / revealWidth : 0

            // Pinned to the top as well as the leading edge: every child here is
            // full height, so this changes nothing in the normal case — but a
            // child that ever overflows now hangs off the bottom instead of
            // silently recentring the page.
            ZStack(alignment: .topLeading) {
                environment.theme.railColor

                SourceList(isActive: showsSourceList, onSelect: dismissSourceList)
                    .padding(.top, windowSafeAreaInsets.top)
                    .padding(.bottom, windowSafeAreaInsets.bottom)
                    .frame(width: revealWidth)
                    .frame(maxHeight: .infinity)
                    .offset(x: -14 * (1 - revealProgress))
                    .opacity(0.6 + (0.4 * revealProgress))
                    .allowsHitTesting(showsSourceList)
                    .accessibilityHidden(!showsSourceList)

                // The page keeps its full size and a constant display-concentric
                // corner radius while it slides: at rest the rounding coincides
                // with the screen corners, so revealing the navigation never
                // changes the radius — matching ChatGPT/Claude.
                destinationStack(showsNavigationButton: true)
                    .frame(width: geometry.size.width, height: geometry.size.height)
                    .background(Color(uiColor: .systemBackground))
                    .clipShape(pageShape)
                    .overlay {
                        if showsSourceList {
                            // Attached to the page itself so the dismiss hit
                            // area always matches the visible strip and can
                            // never sit over the source list.
                            Color.clear
                                .contentShape(pageShape)
                                .onTapGesture { dismissSourceList() }
                                .gesture(sourceListDrag(revealWidth: revealWidth))
                                .accessibilityHidden(true)
                        }
                    }
                    .shadow(color: .black.opacity(0.18 * revealProgress), radius: 24, x: -8)
                    .offset(x: pageOffset)
                    .accessibilityHidden(showsSourceList)

                if !showsSourceList, environment.navigation.canRevealSourceList {
                    Color.clear
                        .frame(width: 24, height: geometry.size.height)
                        .contentShape(.rect)
                        .gesture(sourceListDrag(revealWidth: revealWidth))
                        .accessibilityHidden(true)
                }
            }
            .animation(reduceMotion ? nil : .snappy(duration: 0.32, extraBounce: 0.04), value: showsSourceList)
        }
        .ignoresSafeArea()
        .onChange(of: environment.navigation.requestsSourceList) { _, requested in
            guard requested else { return }
            environment.navigation.requestsSourceList = false
            guard environment.navigation.canRevealSourceList else { return }
            showsSourceList = true
            UIAccessibility.post(notification: .screenChanged, argument: "Navigation")
        }
    }

    private var pageShape: ConcentricRectangle {
        ConcentricRectangle(corners: .concentric(minimum: 28), isUniform: true)
    }

    // The compact shell ignores the safe area so the page can slide as a
    // full-bleed sheet; the source list re-applies the real window insets
    // (GeometryProxy reports zero inside the ignored container).
    private var windowSafeAreaInsets: UIEdgeInsets {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first(where: \.isKeyWindow)?
            .safeAreaInsets ?? .zero
    }

    private func sourceListDrag(revealWidth: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 12)
            .updating($sourceListDragOffset) { value, offset, _ in
                let horizontal = value.translation.width
                guard abs(horizontal) > abs(value.translation.height) else { return }
                offset = showsSourceList ? min(0, horizontal) : max(0, horizontal)
            }
            .onEnded { value in
                let horizontal = value.translation.width
                guard abs(horizontal) > abs(value.translation.height) else { return }
                let predicted = value.predictedEndTranslation.width
                if showsSourceList {
                    if horizontal < -(revealWidth * 0.16) || predicted < -(revealWidth * 0.34) {
                        dismissSourceList()
                    }
                } else if horizontal > revealWidth * 0.14 || predicted > revealWidth * 0.3 {
                    showsSourceList = true
                    UIAccessibility.post(notification: .screenChanged, argument: "Navigation")
                }
            }
    }

    private func destinationStack(showsNavigationButton: Bool) -> some View {
        NavigationStack {
            rootDestination
                .toolbar {
                    if showsNavigationButton && !environment.navigation.hasNestedDestination {
                        ToolbarItem(placement: .topBarLeading) {
                            Button {
                                showsSourceList = true
                                UIAccessibility.post(notification: .screenChanged, argument: "Navigation")
                            } label: {
                                Label("Open navigation", systemImage: "line.3.horizontal")
                            }
                            .accessibilityLabel("Open navigation")
                        }
                    }
                }
        }
        .overlay(alignment: .bottomTrailing) {
            // The create surface floats over root pages as a liquid-glass
            // button. Mail hides the floating copy because it mounts the same
            // menu in its bottom toolbar beside the system search field; chat
            // hides it because its composer owns that corner.
            if GlobalCreateMenuPolicy.showsFloatingButton(
                selectedTab: environment.navigation.selectedTab,
                hasNestedDestination: environment.navigation.hasNestedDestination
            ) {
                GlobalCreateMenu {
                    Image(systemName: "plus")
                        .font(.system(size: 22, weight: .medium))
                        .foregroundStyle(.primary)
                        .frame(width: 56, height: 56)
                        .contentShape(Circle())
                }
                .glassEffect(.regular.interactive(), in: .circle)
                .padding(.trailing, 20)
                .padding(.bottom, 24)
            }
        }
    }

    private var rootDestination: some View {
        RootDestinationView()
    }

    private func dismissSourceList() {
        showsSourceList = false
        UIAccessibility.post(notification: .screenChanged, argument: environment.navigation.selectedTab.title)
    }

    private func consumeMailNotificationAction() async {
        await ShellNotificationActions.consumePendingMailAction(environment: environment)
    }
}

private struct SourceList: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    // The wheel's recognizer lives on the window, so the sidebar being merely
    // laid out is not enough — while the page covers it, vertical drags on the
    // page sit inside the sidebar's rectangle and are not the wheel's.
    let isActive: Bool
    let onSelect: () -> Void

    @State private var model = SidebarWheelModel()

    @State private var measurementSequence = SidebarMeasurementSequence()
    @State private var wheelFrame: CGRect = .zero

    private var primaries: [PrimaryTab] { PrimaryTab.sourceList }
    private var areas: [AreaSummary] { environment.store.areas }

    var body: some View {
        VStack(spacing: 0) {
            // The masthead sits outside the wheel: it is the sidebar's title,
            // not a place you can go, so it neither turns nor fans.
            HStack {
                Text("Albatross")
                    .font(environment.theme.displayType.displayFont(size: 23))
                Spacer()
            }
            .padding(.horizontal, 16)
            .padding(.top, 10)
            .padding(.bottom, 14)

            wheel

            Divider()

            // Settings is outside the wheel deliberately — see SidebarDestination.
            Button {
                environment.navigation.sheet = .settings
                onSelect()
            } label: {
                Label("Settings", systemImage: "gearshape")
                    .font(.body)
                    .foregroundStyle(.primary)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(.rect)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 6)
            }
            .buttonStyle(.plain)
            .accessibilityHint("Opens account and app settings")
        }
        .background(environment.theme.railColor)
        .onAppear { refresh() }
        .onChange(of: areaIdentity) { _, _ in refresh() }
        .onChange(of: reduceMotion) { _, value in model.reduceMotion = value }
        .onDisappear { model.stop() }
    }

    // MARK: - The wheel

    private var wheel: some View {
        SidebarWheelLayout(
            position: model.position,
            slotY: model.slotY,
            engagement: model.engagement,
            spacing: 4,
            onMeasure: { [measurementSequence] centers, total in
                // Layout may measure off the main actor; the model is
                // main-actor state, so hand the measurement over rather than
                // assume. The sequence lets the model drop a measurement that
                // arrives after a newer one, since task order is not promised.
                let sequence = measurementSequence.next()
                Task { @MainActor in
                    model.setMeasurement(centers: centers, total: total, sequence: sequence)
                }
            }
        ) {
            rows
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .padding(.horizontal, 8)
        .clipped()
        .coordinateSpace(name: SidebarWheelSpace.name)
        .onGeometryChange(for: CGRect.self) { proxy in
            proxy.frame(in: .global)
        } action: { frame in
            wheelFrame = frame
            model.activeRect = frame
            model.viewportHeight = frame.height
        }
        .background {
            SidebarWheelGestureAttachment(
                isEnabled: isActive,
                activeRect: wheelFrame,
                onChange: { start, translation, velocity in
                    model.handleChange(start: start, translation: translation, velocity: velocity)
                },
                onEnd: { velocity, completed in
                    model.handleEnd(velocity: velocity, completed: completed)
                }
            )
            .allowsHitTesting(false)
        }
        // The wheel replaces scrolling, so the whole hierarchy is realised up
        // front. Twenty rows do not need laziness, and lazy instantiation
        // mid-fling is its own source of pop-in.
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder private var rows: some View {
        let engagement = model.engagement
        let focus = model.focusY

        ForEach(Array(primaries.enumerated()), id: \.element) { offset, destination in
            sourceButton(destination)
                .sidebarWheelDetent(offset)
                .sidebarPage(engagement: engagement, focusY: focus)
        }

        Divider()
            .padding(.vertical, 12)
            .sidebarPage(engagement: engagement, focusY: focus)

        sectionHeader("Your areas")
            .sidebarPage(engagement: engagement, focusY: focus)

        if areas.isEmpty {
            areaState
                .sidebarPage(engagement: engagement, focusY: focus)
        } else {
            ForEach(Array(areas.enumerated()), id: \.element.id) { offset, area in
                areaButton(area)
                    .sidebarWheelDetent(primaries.count + offset)
                    .sidebarPage(engagement: engagement, focusY: focus)
            }
        }

    }

    private func sectionHeader(_ title: String) -> some View {
        Text(title)
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 12)
            .padding(.bottom, 2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityAddTraits(.isHeader)
    }

    // MARK: - Wiring

    private var areaIdentity: [String] {
        areas.map { "\($0.id):\($0.name)" }
    }

    private func refresh() {
        model.destinations = primaries.map(SidebarDestination.primary)
            + areas.map { SidebarDestination.area(id: $0.id, name: $0.name) }
        // The seam between product sources and the user's contextual hierarchy.
        model.boundaryIndices = [primaries.count]
        model.reduceMotion = reduceMotion
        model.currentIndex = { [weak model] in
            guard let model else { return nil }
            return SidebarDestination.index(of: currentDestination, in: model.destinations)
        }
        model.onCommit = { destination in
            commit(destination)
        }
    }

    private var currentDestination: SidebarDestination? {
        if let route = environment.navigation.areaRoute {
            return .area(id: route.areaID, name: route.name ?? "")
        }
        switch environment.navigation.selectedTab {
        case .chat: return nil
        case let tab: return .primary(tab)
        }
    }

    // Committing routes through the exact paths a tap uses.
    private func commit(_ destination: SidebarDestination) {
        switch destination {
        case .primary(let tab):
            environment.navigation.selectPrimary(tab)
            onSelect()
        case .mail(let scope):
            environment.navigation.selectPrimary(.mail)
            environment.navigation.pendingMailCategory = scope.rawValue
            onSelect()
        case .area(let id, let name):
            environment.navigation.openArea(id: id, name: name)
            onSelect()
        case .settings:
            environment.navigation.sheet = .settings
            onSelect()
        }
    }

    // MARK: - Rows

    private func sourceButton(_ destination: PrimaryTab) -> some View {
        let selected = environment.navigation.selectedTab == destination
            && (destination != .work || environment.navigation.areaRoute == nil)
        return Button {
            guard !model.suppressesRowTaps else { return }
            environment.navigation.selectPrimary(destination)
            onSelect()
        } label: {
            HStack(spacing: 12) {
                Image(systemName: destination.symbol)
                    .font(.body)
                    .frame(width: 20)
                SidebarRowTitle(
                    text: destination.title,
                    font: .body,
                    model: model,
                    destination: .primary(destination),
                    restingWeight: selected ? .semibold : .regular
                )
                Spacer(minLength: 0)
            }
            .foregroundStyle(.primary)
            .padding(.horizontal, 12)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(.rect)
            .background {
                SidebarRowBackground(selected: selected, model: model)
            }
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }

    private func areaButton(_ area: AreaSummary) -> some View {
        let destination = SidebarDestination.area(id: area.id, name: area.name)
        return Button {
            guard !model.suppressesRowTaps else { return }
            environment.navigation.openArea(id: area.id, name: area.name)
            onSelect()
        } label: {
            HStack(spacing: 10) {
                AreaIdentityMark(
                    name: area.name,
                    seed: area.id,
                    imageURL: area.imageURL,
                    faviconURL: area.faviconURL,
                    size: 30
                )
                VStack(alignment: .leading, spacing: 2) {
                    SidebarRowTitle(
                        text: area.name,
                        font: .body,
                        model: model,
                        destination: destination,
                        restingWeight: .regular
                    )
                    // The open page has room the closed ones do not, so it is
                    // the one allowed to run to a second line.
                    SidebarRowDetail(
                        line: area.overview?.statusLine ?? area.detail,
                        model: model,
                        destination: destination
                    )
                }
                // Clearance for the picked title, which renders 12% wider than
                // the width it reserves.
                Spacer(minLength: 14)
                if area.overview?.needsAttention == true {
                    Circle()
                        .fill(environment.theme.accent2Color)
                        .frame(width: 7, height: 7)
                        .accessibilityLabel("Needs attention")
                }
            }
            .padding(.horizontal, 10)
            .frame(maxWidth: .infinity, minHeight: 50, alignment: .leading)
            .contentShape(.rect)
            .background {
                SidebarRowBackground(selected: isSelected(area), model: model)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(areaAccessibilityLabel(area))
        .accessibilityAddTraits(isSelected(area) ? [.isButton, .isSelected] : .isButton)
    }

    @ViewBuilder private var areaState: some View {
        if environment.store.isLoadingWork || !environment.store.workDidLoad {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Loading areas…")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 12)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        } else if environment.store.workError != nil {
            Button("Retry loading Areas") {
                Task { await environment.store.refreshWork() }
            }
            .padding(.horizontal, 12)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        } else {
            Text("No active areas")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 12)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        }
    }

    private func isSelected(_ area: AreaSummary) -> Bool {
        environment.navigation.selectedTab == .work
            && environment.navigation.areaRoute?.areaID == area.id
    }

    private func areaAccessibilityLabel(_ area: AreaSummary) -> String {
        var parts = [area.name, area.kind]
        if let status = area.overview?.statusLine { parts.append(status) }
        if area.overview?.needsAttention == true { parts.append("needs attention") }
        return parts.joined(separator: ", ")
    }
}

// MARK: - Row pieces that follow the pick

// These read `detent` and nothing else, so the pick can move without dragging
// whole rows — avatars, icons, backgrounds — through a rebuild with it.

private struct SidebarRowTitle: View {
    let text: String
    let font: Font
    let model: SidebarWheelModel
    let destination: SidebarDestination
    let restingWeight: Font.Weight

    @Environment(AppEnvironment.self) private var environment

    var body: some View {
        let picked = model.isPicked(destination)
        let accent = environment.theme.accentColor
        // Neither font size nor weight interpolates, so either one flipped on
        // pick would snap. The size comes from `scaleEffect`, which does
        // animate, anchored leading so the word grows out from the spine like
        // everything else. The two weights crossfade underneath it, and the
        // glow rides in on the same curve.
        Text(text)
            .font(font.weight(.semibold))
            .lineLimit(1)
            .hidden()
            .overlay(alignment: .leading) {
                ZStack(alignment: .leading) {
                    Text(text)
                        .font(font.weight(restingWeight))
                        .foregroundStyle(.primary)
                        .opacity(picked ? 0 : 1)
                    Text(text)
                        .font(font.weight(.semibold))
                        // Accent-tinted rather than a dark halo: on warm paper a
                        // grey shadow reads as a smudge, where a chromatic one
                        // reads as light.
                        .foregroundStyle(accent)
                        .shadow(color: accent.opacity(0.55), radius: 4)
                        .shadow(color: accent.opacity(0.32), radius: 11)
                        .shadow(color: accent.opacity(0.18), radius: 22)
                        .opacity(picked ? 1 : 0)
                }
                .lineLimit(1)
                .scaleEffect(picked ? 1.12 : 1, anchor: .leading)
                .animation(.smooth(duration: 0.26), value: picked)
            }
    }
}

private struct SidebarRowDetail: View {
    let line: String?
    let model: SidebarWheelModel
    let destination: SidebarDestination

    var body: some View {
        let picked = model.isPicked(destination)
        if let line, !line.isEmpty {
            Text(line)
                .font(.caption)
                .foregroundStyle(picked ? .primary : .secondary)
                .lineLimit(picked ? 2 : 1)
        }
    }
}

// The resting selection block is suppressed while the wheel is turning, so the
// pick is marked by weight and the open page alone rather than by two competing
// highlights.
private struct SidebarRowBackground: View {
    let selected: Bool
    let model: SidebarWheelModel

    var body: some View {
        if selected, model.engagement <= 0.01 {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color.primary.opacity(0.075))
        }
    }
}

#endif
