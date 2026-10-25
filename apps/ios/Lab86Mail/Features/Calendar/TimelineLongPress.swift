import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

// The empty grid answers a hold with a new event at that slot. UIKit's long
// press recogniser reports where the hold began and lives well under a
// scroll view, which a SwiftUI long press does not. The Mac has no hold to
// create (it drags blocks and uses the toolbar), so there the surface is
// inert and takes no touches.
struct TimelineHoldSurface: View {
    let onHold: (CGPoint) -> Void

    var body: some View {
        #if os(iOS)
        HoldRecognizerView(onHold: onHold)
        #else
        Color.clear.allowsHitTesting(false)
        #endif
    }
}

#if os(iOS)
private struct HoldRecognizerView: UIViewRepresentable {
    let onHold: (CGPoint) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onHold: onHold)
    }

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.backgroundColor = .clear
        let recognizer = UILongPressGestureRecognizer(
            target: context.coordinator,
            action: #selector(Coordinator.handle(_:))
        )
        recognizer.minimumPressDuration = 0.45
        recognizer.allowableMovement = 12
        recognizer.cancelsTouchesInView = false
        view.addGestureRecognizer(recognizer)
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        context.coordinator.onHold = onHold
    }

    @MainActor
    final class Coordinator: NSObject {
        var onHold: (CGPoint) -> Void

        init(onHold: @escaping (CGPoint) -> Void) {
            self.onHold = onHold
        }

        @objc func handle(_ recognizer: UILongPressGestureRecognizer) {
            guard recognizer.state == .began, let view = recognizer.view else { return }
            PlatformHaptics.lightImpact()
            onHold(recognizer.location(in: view))
        }
    }
}
#endif
