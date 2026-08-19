import SwiftUI

// Albatross chat on the Mac: a bubble in the window's bottom-right corner
// opens a compact floating panel. The panel magnetizes to whichever corner
// its header is dragged toward, and can be torn out into its own window.

private enum ChatPanelCorner: CaseIterable {
    case topLeading
    case topTrailing
    case bottomLeading
    case bottomTrailing

    var alignment: Alignment {
        switch self {
        case .topLeading: .topLeading
        case .topTrailing: .topTrailing
        case .bottomLeading: .bottomLeading
        case .bottomTrailing: .bottomTrailing
        }
    }

    func anchorPoint(in size: CGSize) -> CGPoint {
        CGPoint(
            x: self == .topTrailing || self == .bottomTrailing ? size.width : 0,
            y: self == .bottomLeading || self == .bottomTrailing ? size.height : 0
        )
    }

    static func nearest(to point: CGPoint, in size: CGSize) -> ChatPanelCorner {
        allCases.min(by: { lhs, rhs in
            distanceSquared(lhs.anchorPoint(in: size), point) < distanceSquared(rhs.anchorPoint(in: size), point)
        }) ?? .bottomTrailing
    }

    private static func distanceSquared(_ a: CGPoint, _ b: CGPoint) -> CGFloat {
        let dx = a.x - b.x
        let dy = a.y - b.y
        return dx * dx + dy * dy
    }
}

struct MacChatOverlay: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.openWindow) private var openWindow
    @State private var corner: ChatPanelCorner = .bottomTrailing
    @GestureState private var dragTranslation: CGSize = .zero

    private static let panelSize = CGSize(width: 360, height: 480)

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                if environment.navigation.chatPanelPresented, let chat = environment.assistantChat {
                    panel(chat: chat, containerSize: geometry.size)
                } else {
                    chatButton
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: activeAlignment)
            .padding(14)
        }
    }

    // The launcher hides while the panel is up — the panel's close button is
    // the same toggle, and two bubbles in one corner read as clutter.
    private var chatButton: some View {
        Button {
            environment.toggleAssistantChatPanel()
        } label: {
            Image(systemName: "bubble.left.and.text.bubble.right")
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(.primary)
                .frame(width: 44, height: 44)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: .circle)
        // ⌘K lives on the Ask Albatross menu command; binding it here too
        // would double-register the shortcut.
        .accessibilityLabel("Ask Albatross")
    }

    private var activeAlignment: Alignment {
        environment.navigation.chatPanelPresented ? corner.alignment : .bottomTrailing
    }

    private func panel(chat: AssistantChatModel, containerSize: CGSize) -> some View {
        VStack(spacing: 0) {
            panelHeader(containerSize: containerSize)
            Divider()
            NavigationStack {
                AssistantChatView(model: chat)
            }
        }
        .frame(width: Self.panelSize.width, height: Self.panelSize.height)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.12), lineWidth: 1)
        }
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .shadow(color: .black.opacity(0.22), radius: 26, y: 10)
        .offset(dragTranslation)
        .animation(.snappy(duration: 0.25), value: corner)
    }

    private func panelHeader(containerSize: CGSize) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "bird")
                .foregroundStyle(environment.theme.accentColor)
            Text("Albatross")
                .font(.headline)
            Spacer()
            Button {
                environment.startAssistantChat()
            } label: {
                Image(systemName: "square.and.pencil")
            }
            .buttonStyle(.plain)
            .help("New chat")
            Button {
                environment.navigation.chatPanelPresented = false
                openWindow(id: MacChatWindowScene.identifier)
            } label: {
                Image(systemName: "arrow.up.right.square")
            }
            .buttonStyle(.plain)
            .help("Open in its own window")
            Button {
                environment.navigation.chatPanelPresented = false
            } label: {
                Image(systemName: "xmark")
            }
            .buttonStyle(.plain)
            .help("Close chat")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .contentShape(.rect)
        .gesture(dragGesture(containerSize: containerSize))
        .accessibilityAddTraits(.isHeader)
    }

    // Dragging the header carries the panel; release magnetizes it to the
    // nearest corner of the window.
    private func dragGesture(containerSize: CGSize) -> some Gesture {
        DragGesture(minimumDistance: 4)
            .updating($dragTranslation) { value, state, _ in
                state = value.translation
            }
            .onEnded { value in
                let origin = corner.anchorPoint(in: containerSize)
                let landed = CGPoint(
                    x: origin.x + value.predictedEndTranslation.width,
                    y: origin.y + value.predictedEndTranslation.height
                )
                corner = ChatPanelCorner.nearest(to: landed, in: containerSize)
            }
    }
}

// The torn-out chat: a real window over the same conversation model, so the
// panel and the window are two views of one exchange.
enum MacChatWindowScene {
    static let identifier = "albatross-chat"
}

struct MacChatWindowRoot: View {
    @Environment(AppEnvironment.self) private var environment

    var body: some View {
        Group {
            if let chat = environment.assistantChat {
                NavigationStack {
                    AssistantChatView(model: chat)
                }
            } else {
                ContentUnavailableView {
                    Label("No active chat", systemImage: "bubble")
                } description: {
                    Text("Start one with ⌘K in the main window.")
                }
            }
        }
        .frame(minWidth: 380, idealWidth: 440, minHeight: 480, idealHeight: 620)
        .background(environment.theme.paperColor)
    }
}
