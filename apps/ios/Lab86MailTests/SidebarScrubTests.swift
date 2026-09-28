#if os(iOS)
import Foundation
import Testing
@testable import Lab86Mail

// The page fan. Distance is in rows, signed, and derived from where a row
// actually landed, so these are the shape rules for the whole sidebar.
struct SidebarPageGeometryTests {
    private func page(_ distance: Double, engagement: Double = 1) -> SidebarPageTransform {
        SidebarPageGeometry.transform(
            distance: distance,
            engagement: engagement,
            reduceMotion: false
        )
    }

    @Test
    func theOpenPageIsFlatAndTheRestFanShut() {
        let open = page(0)
        #expect(open.hingeDegrees == 0)
        #expect(open.opacity > 0.999)
        #expect(open.lift > 1)
        // Pages shut in both directions — a fan, not a tilt.
        #expect(page(2).hingeDegrees < 0)
        #expect(page(-2).hingeDegrees < 0)
        #expect(abs(page(2).hingeDegrees - page(-2).hingeDegrees) < 1e-9)
        #expect(abs(page(2).lift - page(-2).lift) < 1e-9)
    }

    @Test
    func theFanIsSmoothThroughTheOpenPageAndHasNoClampToFreezeAgainst() {
        // A crease at the open page is what a `tanh(|d|)` shape would give.
        let step = 0.01
        let left = page(-step).hingeDegrees
        let right = page(step).hingeDegrees
        #expect(abs(left - right) < 1e-6)
        #expect(abs(left) < 0.02)

        // Every channel keeps separating row to row all the way out; nothing
        // freezes at a limit the way the old clamped version did.
        let distances = stride(from: 0.0, through: 14.0, by: 1.0).map { page($0) }
        for index in 0..<(distances.count - 1) {
            #expect(distances[index + 1].hingeDegrees < distances[index].hingeDegrees)
            #expect(distances[index + 1].lift < distances[index].lift)
            #expect(distances[index + 1].opacity < distances[index].opacity)
        }
    }

    @Test
    func nothingEverBendsOrFadesOutOfLegibility() {
        for distance in stride(from: -40.0, through: 40.0, by: 2.0) {
            let transform = page(distance)
            #expect(abs(transform.hingeDegrees) <= SidebarPageGeometry.maximumHinge)
            #expect(transform.opacity >= SidebarPageGeometry.farOpacity)
            #expect(transform.lift <= 1 + CGFloat(SidebarPageGeometry.liftAmount))
            #expect(transform.lift >= 1)
            // Growth is always outward from the spine, never inward.
            #expect(transform.slide >= 0)
        }
    }

    @Test
    func aRestingSidebarIsCompletelyUntouched() {
        // At zero engagement the wheel leaves no trace, whatever the distance.
        for distance in stride(from: -10.0, through: 10.0, by: 1.0) {
            #expect(page(distance, engagement: 0) == .identity)
        }
        // And it scales in continuously rather than appearing.
        let partial = page(3, engagement: 0.5)
        let full = page(3, engagement: 1)
        #expect(partial.hingeDegrees > full.hingeDegrees)
        #expect(partial.hingeDegrees < 0)
        #expect(partial.opacity > full.opacity)
    }

    @Test
    func reduceMotionKeepsTheFocusAndDropsTheThirdDimension() {
        let reduced = SidebarPageGeometry.transform(
            distance: 3,
            engagement: 1,
            reduceMotion: true
        )
        #expect(reduced.hingeDegrees == 0)
        #expect(reduced.slide == 0)
        // The open page is still the one that stands out.
        let open = SidebarPageGeometry.transform(distance: 0, engagement: 1, reduceMotion: true)
        #expect(open.lift > reduced.lift)
        #expect(open.opacity > reduced.opacity)
    }

    @Test
    func theOpenPageStaysMarkedWhileTheWheelTurns() {
        // The riffle only looks, so the page you are on must not lose its
        // mark under the pick — at any point in the blend.
        for tenths in 0...10 {
            let engagement = Double(tenths) / 10
            #expect(SidebarSelectionMark.opacity(selected: true, engagement: engagement) >= SidebarSelectionMark.restingOpacity)
            #expect(SidebarSelectionMark.opacity(selected: false, engagement: engagement) == 0)
        }
        #expect(SidebarSelectionMark.opacity(selected: true, engagement: 0) == SidebarSelectionMark.restingOpacity)
        #expect(SidebarSelectionMark.opacity(selected: true, engagement: 1) == SidebarSelectionMark.turningOpacity)
    }
}

// Destination identity, which the wheel uses to find where it should start.
struct SidebarDestinationTests {
    private let ordered: [SidebarDestination] = [
        .primary(.today),
        .area(id: "area_1", name: "House"),
        .mail(.main),
    ]

    @Test
    func anAreaResolvesOnIdSoAStaleRouteNameStillFindsItsRow() {
        #expect(SidebarDestination.index(of: .primary(.today), in: ordered) == 0)
        #expect(SidebarDestination.index(of: .mail(.main), in: ordered) == 2)
        #expect(SidebarDestination.index(of: .area(id: "area_1", name: ""), in: ordered) == 1)
        #expect(SidebarDestination.index(of: .area(id: "gone", name: "House"), in: ordered) == nil)
        #expect(SidebarDestination.index(of: nil, in: ordered) == nil)
        // Settings is not a wheel stop at all.
        #expect(SidebarDestination.index(of: .settings, in: ordered) == nil)
    }
}

@MainActor
struct SidebarMeasurementTests {
    @Test
    func aLateOlderMeasurementCannotOverwriteANewerOne() {
        let model = SidebarWheelModel()
        model.setMeasurement(centers: [10, 20], total: 100, sequence: 2)
        model.setMeasurement(centers: [1, 2], total: 50, sequence: 1)
        #expect(model.publishedMeasurement.centers == [10, 20])
        #expect(model.publishedMeasurement.total == 100)
        model.setMeasurement(centers: [30, 40], total: 200, sequence: 3)
        #expect(model.publishedMeasurement.total == 200)
        // Unsequenced callers keep the old contract.
        model.setMeasurement(centers: [5], total: 5)
        #expect(model.publishedMeasurement.total == 5)
    }

    @Test
    func theSequenceCounterIsMonotonicAcrossThreads() async {
        let sequence = SidebarMeasurementSequence()
        let values = await withTaskGroup(of: Int.self) { group in
            for _ in 0..<64 { group.addTask { sequence.next() } }
            var seen: [Int] = []
            for await value in group { seen.append(value) }
            return seen.sorted()
        }
        #expect(values == Array(1...64))
    }
}
#endif
