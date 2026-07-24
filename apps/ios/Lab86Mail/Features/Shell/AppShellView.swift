import SwiftUI
import UIKit

struct AppShellView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var showsSourceList = false
    @GestureState private var sourceListDragOffset: CGFloat = 0
    // Hold-and-drag sidebar scrub session; previews render over the page
    // (compact) or detail pane (regular) without touching real navigation.
    @State private var scrub = SidebarScrubState()

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
            if !environment.pendingSends.records.isEmpty || environment.store.undoNotice != nil {
                VStack(spacing: 8) {
                    ForEach(environment.pendingSends.records) { record in
                        PendingSendToast(record: record)
                    }
                    if let notice = environment.store.undoNotice {
                        HStack(spacing: 12) {
                            Image(systemName: "arrow.uturn.backward.circle")
                                .foregroundStyle(environment.theme.accentColor)
                            Text(notice.summary)
                                .font(.subheadline)
                                .lineLimit(2)
                            Spacer()
                            Button("Undo") {
                                Task { await environment.store.undoLatestOperation() }
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(environment.theme.accentColor)
                            Button("Dismiss") {
                                environment.store.undoNotice = nil
                            }
                            .labelStyle(.iconOnly)
                            .buttonStyle(.plain)
                        }
                        .padding(12)
                        .background(.regularMaterial, in: .rect(cornerRadius: 18))
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, max(windowSafeAreaInsets.bottom, 12))
                .frame(maxWidth: 520)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
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
            SourceList(
                onSelect: {
                    // Selection updates the detail immediately; the
                    // regular-width source list remains visible.
                },
                scrub: $scrub
            )
            .navigationSplitViewColumnWidth(min: 250, ideal: 290, max: 360)
        } detail: {
            destinationStack(showsNavigationButton: false)
                .overlay {
                    if scrub.isActive, scrub.previewReady, let previewed = scrub.previewed {
                        SidebarDestinationPreview(destination: previewed)
                            .id(previewed)
                            .transition(.opacity)
                            .allowsHitTesting(false)
                    }
                }
                .animation(reduceMotion ? nil : .easeInOut(duration: 0.12), value: scrub.previewed)
        }
        .navigationSplitViewStyle(.balanced)
    }

    private var compactWidthShell: some View {
        GeometryReader { geometry in
            let revealWidth = min(max(geometry.size.width * 0.82, 286), 332)
            let baseOffset = showsSourceList ? revealWidth : 0
            let pageOffset = min(max(baseOffset + sourceListDragOffset, 0), revealWidth)
            let revealProgress = revealWidth > 0 ? pageOffset / revealWidth : 0

            ZStack(alignment: .leading) {
                environment.theme.railColor

                SourceList(onSelect: dismissSourceList, scrub: $scrub)
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
                    .overlay {
                        // While scrubbing, the visible page strip crossfades
                        // between read-only previews of the highlighted row.
                        if showsSourceList, scrub.isActive, scrub.previewReady, let previewed = scrub.previewed {
                            SidebarDestinationPreview(destination: previewed)
                                .clipShape(pageShape)
                                .id(previewed)
                                .transition(.opacity)
                                .allowsHitTesting(false)
                        }
                    }
                    .animation(reduceMotion ? nil : .easeInOut(duration: 0.12), value: scrub.previewed)
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

    @ViewBuilder private var rootDestination: some View {
        switch environment.navigation.selectedTab {
        case .today:
            TodayView()
        case .tasks:
            if let route = environment.navigation.projectRoute {
                ProjectDetailView(project: route.project)
            } else {
                TasksView()
            }
        case .calendar:
            CalendarView()
        case .work:
            if let route = environment.navigation.areaRoute {
                AreaDetailView(route: route)
            } else {
                WorkView()
            }
        case .mail:
            MailView()
        case .chat:
            if let chat = environment.assistantChat {
                AssistantChatView(model: chat)
            } else {
                TodayView()
            }
        }
    }

    private func dismissSourceList() {
        showsSourceList = false
        UIAccessibility.post(notification: .screenChanged, argument: environment.navigation.selectedTab.title)
    }

    private func consumeMailNotificationAction(defaults: UserDefaults = .standard) async {
        guard let action = defaults.string(forKey: "pendingAlbatrossMailNotificationAction"),
              let accountID = defaults.string(forKey: "pendingAlbatrossMailNotificationAccount"),
              let threadID = defaults.string(forKey: "pendingAlbatrossMailNotificationThread") else { return }
        defaults.removeObject(forKey: "pendingAlbatrossMailNotificationAction")
        defaults.removeObject(forKey: "pendingAlbatrossMailNotificationAccount")
        defaults.removeObject(forKey: "pendingAlbatrossMailNotificationThread")
        await environment.store.performMailNotificationAction(
            action: action,
            accountID: accountID,
            threadID: threadID
        )
    }
}

private struct PendingSendToast: View {
    @Environment(AppEnvironment.self) private var environment
    let record: PendingSendRecord

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            HStack(spacing: 12) {
                Image(systemName: "paperplane")
                    .foregroundStyle(environment.theme.accentColor)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Sending in \(remainingSeconds(at: context.date))s")
                        .font(.subheadline.weight(.semibold))
                    Text(record.snapshot.subject.isEmpty ? "Message held by the server" : record.snapshot.subject)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                Button("Undo Send") {
                    Task {
                        guard let prefill = await environment.pendingSends.undo(record) else { return }
                        environment.navigation.pendingCompose = prefill
                        environment.navigation.sheet = .compose
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(environment.theme.accentColor)
                .disabled(remainingSeconds(at: context.date) <= 0)
            }
            .padding(12)
            .background(.regularMaterial, in: .rect(cornerRadius: 18))
            .overlay {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(Color.primary.opacity(0.1))
            }
        }
        .task(id: record.id) {
            let delay = max(0, record.fireAt.timeIntervalSinceNow)
            try? await Task.sleep(for: .seconds(delay + 0.5))
            await environment.pendingSends.reconcile(ownerID: environment.sessionStore.ownerID)
            await environment.store.refreshMail()
        }
        .accessibilityElement(children: .combine)
    }

    private func remainingSeconds(at date: Date) -> Int {
        max(0, Int(ceil(record.fireAt.timeIntervalSince(date))))
    }
}

private struct SourceList: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let onSelect: () -> Void
    // Scrub session owned by the shell so it can drive the page preview.
    var scrub: Binding<SidebarScrubState>?

    @State private var rowFrames: [SidebarDestination: CGRect] = [:]
    @State private var containerBounds: CGRect = .zero
    @State private var scrollBounds: CGRect = .zero
    @State private var scrubCancelled = false
    @State private var previewDelayTask: Task<Void, Never>?
    @State private var autoscrollTarget: SidebarDestination?
    @State private var autoscrollTask: Task<Void, Never>?
    @State private var autoscrollZone: SidebarScrubLogic.EdgeZone?
    @State private var scrubDestinations: [SidebarDestination] = []

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Albatross")
                    .font(environment.theme.displayType.displayFont(size: 23))
                Spacer()
            }
            .padding(.horizontal, 16)
            .padding(.top, 10)
            .padding(.bottom, 14)

            // Every Area stays in the hierarchy. The viewport itself never
            // pans under the thumb: the direct scrub advances the centered
            // destination, giving long Area lists the behavior of a system
            // wheel without competing scroll and selection gestures.
            ScrollViewReader { proxy in
                ScrollView(.vertical) {
                    LazyVStack(alignment: .leading, spacing: 4) {
                    ForEach(PrimaryTab.sourceList) { destination in
                        sourceButton(destination)
                    }

                    Divider()
                        .padding(.vertical, 12)

                    Text("Your areas")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 12)
                        .padding(.bottom, 2)
                        .accessibilityAddTraits(.isHeader)

                    if environment.store.areas.isEmpty {
                        areaState
                    } else {
                        ForEach(environment.store.areas) { area in
                            let destination = SidebarDestination.area(id: area.id, name: area.name)
                            Button {
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
                                        Text(area.name)
                                            .font(.body)
                                            .foregroundStyle(.primary)
                                            .lineLimit(1)
                                        if let line = area.overview?.statusLine ?? area.detail {
                                            Text(line)
                                                .font(.caption)
                                                .foregroundStyle(.secondary)
                                                .lineLimit(1)
                                        }
                                    }
                                    Spacer(minLength: 4)
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
                                    if isSelected(area) {
                                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                                            .fill(Color.primary.opacity(0.075))
                                    }
                                }
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(areaAccessibilityLabel(area))
                            .accessibilityAddTraits(isSelected(area) ? [.isButton, .isSelected] : .isButton)
                            .id(destination)
                            .sidebarScrubRow(destination, frames: $rowFrames)
                            .sidebarScrubHighlight(isScrubbing(destination))
                            .sidebarScrubWheel(distance: wheelDistance(to: destination))
                        }
                    }

                    Divider()
                        .padding(.vertical, 12)

                    Text("Mail")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 12)
                        .padding(.bottom, 2)
                        .accessibilityAddTraits(.isHeader)

                    ForEach(MailCategoryScope.allCases) { category in
                        mailFilterButton(category)
                    }

                    Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 8)
                    .padding(.bottom, 16)
                }
                .scrollIndicators(.hidden)
                .scrollDisabled(true)
                .onGeometryChange(for: CGRect.self) { proxy in
                    proxy.frame(in: .named(SidebarScrubCoordinateSpace.name))
                } action: { bounds in
                    scrollBounds = bounds
                }
                .onChange(of: autoscrollTarget) { _, destination in
                    guard let destination else { return }
                    withAnimation(reduceMotion ? nil : .snappy(duration: 0.22, extraBounce: 0)) {
                        proxy.scrollTo(destination, anchor: .center)
                    }
                    autoscrollTarget = nil
                }
            }

            Divider()

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
            .sidebarScrubRow(.settings, frames: $rowFrames)
            .sidebarScrubHighlight(isScrubbing(.settings))
            .sidebarScrubWheel(distance: wheelDistance(to: .settings))
        }
        .background(environment.theme.railColor)
        .coordinateSpace(name: SidebarScrubCoordinateSpace.name)
        .onGeometryChange(for: CGRect.self) { proxy in
            proxy.frame(in: .named(SidebarScrubCoordinateSpace.name))
        } action: { bounds in
            containerBounds = bounds
        }
        .onAppear {
            refreshScrubDestinations()
        }
        .onChange(of: environment.store.areas.map { "\($0.id):\($0.name)" }) { _, _ in
            refreshScrubDestinations()
        }
        .onDisappear {
            stopAutoscroll()
            previewDelayTask?.cancel()
        }
        // One drag owns the wheel-style scrub. The viewport is programmatically
        // centered, so there is still no competing scroll pan; VoiceOver
        // continues to activate each real Button directly.
        .highPriorityGesture(scrubGesture, isEnabled: scrub != nil)
    }

    // MARK: - Scrub session

    private func refreshScrubDestinations() {
        scrubDestinations = PrimaryTab.sourceList.map(SidebarDestination.primary)
            + environment.store.areas.map { SidebarDestination.area(id: $0.id, name: $0.name) }
            + MailCategoryScope.allCases.map(SidebarDestination.mail)
            + [.settings]
    }

    private var currentDestination: SidebarDestination? {
        if let route = environment.navigation.areaRoute {
            return .area(id: route.areaID, name: route.name ?? "")
        }
        return .primary(environment.navigation.selectedTab)
    }

    private func isScrubbing(_ destination: SidebarDestination) -> Bool {
        scrub?.wrappedValue.isActive == true && scrub?.wrappedValue.previewed == destination
    }

    private func wheelDistance(to destination: SidebarDestination) -> Int? {
        guard scrub?.wrappedValue.isActive == true,
              let previewed = scrub?.wrappedValue.previewed,
              let selectedIndex = scrubDestinations.firstIndex(of: previewed),
              let destinationIndex = scrubDestinations.firstIndex(of: destination) else {
            return nil
        }
        return destinationIndex - selectedIndex
    }

    // Menu-style touch handling: the session opens on touch-down, the
    // highlight follows the finger, release commits whatever is under it. A
    // plain tap is just the degenerate scrub (down and up on one row). No
    // hold, no scroll — there is nothing left to arbitrate against.
    private var scrubGesture: some Gesture {
        DragGesture(
            minimumDistance: 0,
            coordinateSpace: .named(SidebarScrubCoordinateSpace.name)
        )
        .onChanged { drag in
            handleScrubChange(drag)
        }
        .onEnded { _ in
            endScrub()
        }
    }

    private func handleScrubChange(_ drag: DragGesture.Value) {
        guard let session = scrub, !scrubCancelled else { return }
        if SidebarScrubLogic.isHorizontalDismissal(translation: drag.translation)
            || SidebarScrubLogic.isOutside(location: drag.location, sidebarBounds: containerBounds) {
            if session.wrappedValue.isActive {
                session.wrappedValue.cancel()
                UIAccessibility.post(notification: .announcement, argument: "Navigation preview cancelled")
            }
            scrubCancelled = true
            stopAutoscroll()
            return
        }
        let destination = SidebarScrubLogic.destination(at: drag.location, rows: rowFrames)
        if !session.wrappedValue.isActive {
            session.wrappedValue.activate(over: destination, committed: currentDestination)
            // The page preview waits for a row crossing or the ready delay so
            // a plain tap never flashes it.
            previewDelayTask?.cancel()
            previewDelayTask = Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(SidebarScrubLogic.previewDelayMilliseconds))
                guard !Task.isCancelled else { return }
                scrub?.wrappedValue.markPreviewReady()
            }
            if let destination {
                UIAccessibility.post(notification: .announcement, argument: "Previewing \(destination.title)")
            }
        } else if session.wrappedValue.move(to: destination) {
            // One selection tick per row crossed.
            UISelectionFeedbackGenerator().selectionChanged()
            if let destination {
                UIAccessibility.post(notification: .announcement, argument: destination.title)
            }
        }
        updateAutoscroll(forY: drag.location.y)
    }

    private func endScrub() {
        stopAutoscroll()
        previewDelayTask?.cancel()
        previewDelayTask = nil
        defer { scrubCancelled = false }
        guard let session = scrub, !scrubCancelled, session.wrappedValue.isActive else {
            scrub?.wrappedValue.cancel()
            return
        }
        guard let destination = session.wrappedValue.commit() else { return }
        commitScrub(destination)
    }

    private func updateAutoscroll(forY y: CGFloat) {
        guard scrub?.wrappedValue.isActive == true,
              let zone = SidebarScrubLogic.autoscrollZone(forY: y, in: scrollBounds) else {
            stopAutoscroll()
            return
        }
        guard zone != autoscrollZone else { return }
        stopAutoscroll()
        autoscrollZone = zone
        advanceAutoscroll(zone)
        autoscrollTask = Task { @MainActor in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(240))
                guard !Task.isCancelled, autoscrollZone == zone else { return }
                advanceAutoscroll(zone)
            }
        }
    }

    private func advanceAutoscroll(_ zone: SidebarScrubLogic.EdgeZone) {
        guard let session = scrub,
              let next = SidebarScrubLogic.autoscrollTarget(
                  from: session.wrappedValue.previewed,
                  in: scrubDestinations,
                  zone: zone
              ),
              SidebarScrubLogic.isAutoscrollable(next) else { return }
        autoscrollTarget = next
        if session.wrappedValue.move(to: next) {
            UISelectionFeedbackGenerator().selectionChanged()
            UIAccessibility.post(notification: .announcement, argument: next.title)
        }
    }

    private func stopAutoscroll() {
        autoscrollTask?.cancel()
        autoscrollTask = nil
        autoscrollZone = nil
    }

    // Committing routes through the exact paths a tap uses — the preview never
    // navigated, so this is the session's single real navigation.
    private func commitScrub(_ destination: SidebarDestination) {
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

    private func sourceButton(_ destination: PrimaryTab) -> some View {
        let selected = environment.navigation.selectedTab == destination
            && (destination != .work || environment.navigation.areaRoute == nil)
        return Button {
            environment.navigation.selectPrimary(destination)
            onSelect()
        } label: {
            HStack(spacing: 12) {
                Image(systemName: destination.symbol)
                    .font(.body)
                    .frame(width: 20)
                Text(destination.title)
                    .font(.body.weight(selected ? .semibold : .regular))
                Spacer(minLength: 0)
            }
            .foregroundStyle(.primary)
            .padding(.horizontal, 12)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(.rect)
            .background {
                if selected {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(Color.primary.opacity(0.075))
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
        .id(SidebarDestination.primary(destination))
        .sidebarScrubRow(.primary(destination), frames: $rowFrames)
        .sidebarScrubHighlight(isScrubbing(.primary(destination)))
        .sidebarScrubWheel(distance: wheelDistance(to: .primary(destination)))
    }

    private func mailFilterButton(_ category: MailCategoryScope) -> some View {
        Button {
            environment.navigation.selectPrimary(.mail)
            environment.navigation.pendingMailCategory = category.rawValue
            onSelect()
        } label: {
            HStack(spacing: 12) {
                Image(systemName: category.symbol)
                    .font(.footnote)
                    .frame(width: 20)
                    .foregroundStyle(.secondary)
                Text(category.title)
                    .font(.subheadline)
                Spacer(minLength: 0)
            }
            .foregroundStyle(.primary)
            .padding(.horizontal, 12)
            .frame(maxWidth: .infinity, minHeight: 38, alignment: .leading)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .id(SidebarDestination.mail(category))
        .sidebarScrubRow(.mail(category), frames: $rowFrames)
        .sidebarScrubHighlight(isScrubbing(.mail(category)))
        .sidebarScrubWheel(distance: wheelDistance(to: .mail(category)))
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
            .frame(minHeight: 44)
        } else if environment.store.workError != nil {
            Button("Retry loading Areas") {
                Task { await environment.store.refreshWork() }
            }
            .padding(.horizontal, 12)
            .frame(minHeight: 44)
        } else {
            Text("No active areas")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 12)
                .frame(minHeight: 44)
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

private struct ShellToolbarModifier: ViewModifier {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    let includesCompose: Bool

    func body(content: Content) -> some View {
        content
            .toolbar {
                if includesCompose {
                    ToolbarItem(placement: .topBarPinnedTrailing) {
                        Button {
                            environment.navigation.sheet = .compose
                        } label: {
                            Label("Compose", systemImage: "square.and.pencil")
                        }
                    }
                    .visibilityPriority(.high)
                }
                if horizontalSizeClass == .regular {
                    ToolbarOverflowMenu {
                        activityButton
                    }
                } else {
                    ToolbarItem(placement: .topBarTrailing) {
                        activityButton
                    }
                    .visibilityPriority(.low)
                }
            }
    }

    private var activityButton: some View {
        Button {
            environment.navigation.sheet = .activity
        } label: {
            Label(
                "Activity",
                systemImage: environment.store.approvals.isEmpty
                    && environment.store.suggestions.isEmpty
                    && environment.store.pendingQuestions.isEmpty
                    ? "bell" : "bell.badge"
            )
        }
        .accessibilityLabel(
            environment.store.approvals.isEmpty
                && environment.store.suggestions.isEmpty
                && environment.store.pendingQuestions.isEmpty
                ? "Activity" : "Activity, decisions waiting"
        )
    }
}

extension View {
    func shellToolbar(includesCompose: Bool = false) -> some View {
        modifier(ShellToolbarModifier(includesCompose: includesCompose))
    }
}
