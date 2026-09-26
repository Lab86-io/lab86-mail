import Foundation
#if os(iOS) && canImport(WidgetKit)
import WidgetKit
#endif

/// The app side of the Today widget: it writes the latest summary to the
/// shared App Group and asks WidgetKit to reload. Signing out removes the
/// file, so the widget never shows the last account's day.
@MainActor
enum TodayWidgetBridge {
    static func publish(_ snapshot: TodayWidgetSnapshot, to url: URL? = TodayWidgetSnapshot.containerURL()) {
        guard let url else { return }
        do {
            try snapshot.write(to: url)
            reload()
        } catch {
            // The widget keeps its last good snapshot.
        }
    }

    static func clear(at url: URL? = TodayWidgetSnapshot.containerURL()) {
        TodayWidgetSnapshot.remove(at: url)
        reload()
    }

    static func reload() {
        #if os(iOS) && canImport(WidgetKit)
        WidgetCenter.shared.reloadTimelines(ofKind: TodayWidgetSnapshot.widgetKind)
        #endif
    }
}
