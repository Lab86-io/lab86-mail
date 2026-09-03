@preconcurrency import AVFoundation
import CoreLocation
import MapKit
import Observation
@preconcurrency import Speech

@MainActor
@Observable
final class CaptureVoiceCoordinator: NSObject {
    private let recognizer = SFSpeechRecognizer()
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?

    private(set) var isRecording = false
    private(set) var transcript = ""
    var errorMessage: String?

    func toggle() async {
        if isRecording {
            stop()
        } else {
            await start()
        }
    }

    func stop() {
        guard isRecording else { return }
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        task?.finish()
        isRecording = false
    }

    private func start() async {
        errorMessage = nil
        let speech = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
        guard speech == .authorized else {
            errorMessage = "Speech recognition permission was not granted. You can keep typing."
            return
        }
        #if os(iOS)
        let microphone = await AVAudioApplication.requestRecordPermission()
        #else
        let microphone = await AVCaptureDevice.requestAccess(for: .audio)
        #endif
        guard microphone else {
            errorMessage = "Microphone permission was not granted. You can keep typing."
            return
        }
        do {
            #if os(iOS)
            // AVAudioSession is an iOS concept; the Mac's audio engine taps the
            // default input without a session category.
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: [.duckOthers])
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            #endif

            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            self.request = request
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
                request.append(buffer)
            }
            engine.prepare()
            try engine.start()
            isRecording = true
            task = recognizer?.recognitionTask(with: request) { [weak self] result, error in
                Task { @MainActor in
                    if let result {
                        self?.transcript = result.bestTranscription.formattedString
                        if result.isFinal { self?.stop() }
                    }
                    if let error {
                        self?.errorMessage = error.localizedDescription
                        self?.stop()
                    }
                }
            }
        } catch {
            errorMessage = error.localizedDescription
            stop()
        }
    }
}

struct LocationLookupGeneration: Equatable {
    private(set) var value = 0

    @discardableResult
    mutating func invalidate() -> Int {
        value &+= 1
        return value
    }

    func isCurrent(_ candidate: Int) -> Bool {
        candidate == value
    }
}

@MainActor
protocol CaptureLocationManaging: AnyObject {
    var delegate: (any CLLocationManagerDelegate)? { get set }
    var desiredAccuracy: CLLocationAccuracy { get set }
    var authorizationStatus: CLAuthorizationStatus { get }

    func requestWhenInUseAuthorization()
    func requestLocation()
}

extension CLLocationManager: CaptureLocationManaging {}

@MainActor
protocol CaptureLocationLabelResolving: AnyObject {
    func resolveLabel(for location: CLLocation) async -> String?
    func cancel()
}

// MapKit's reverse geocoding replaced CLGeocoder in the 26 SDKs; the label
// is the city with its region ("Rochester, NY"), the same shape the old
// locality + administrative-area pair produced.
@MainActor
final class SystemLocationLabelResolver: CaptureLocationLabelResolving {
    private var request: MKReverseGeocodingRequest?

    func resolveLabel(for location: CLLocation) async -> String? {
        request?.cancel()
        guard let request = MKReverseGeocodingRequest(location: location) else { return nil }
        self.request = request
        defer { if self.request === request { self.request = nil } }
        guard let item = try? await request.mapItems.first else { return nil }
        return Self.label(for: item)
    }

    nonisolated static func label(for item: MKMapItem) -> String? {
        let representations = item.addressRepresentations
        let candidates = [representations?.cityWithContext, representations?.regionName, item.name]
        let label = candidates
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty }
        return label
    }

    func cancel() {
        request?.cancel()
        request = nil
    }
}

@MainActor
@Observable
final class CaptureLocationCoordinator: NSObject, CLLocationManagerDelegate {
    private let manager: any CaptureLocationManaging
    private let labelResolver: any CaptureLocationLabelResolving
    private(set) var location: CLLocation?
    private(set) var locationLabel: String?
    private(set) var isRequesting = false
    var errorMessage: String?
    private var lookupGeneration = LocationLookupGeneration()

    init(
        manager: any CaptureLocationManaging = CLLocationManager(),
        labelResolver: any CaptureLocationLabelResolving = SystemLocationLabelResolver()
    ) {
        self.manager = manager
        self.labelResolver = labelResolver
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    }

    nonisolated static func isValidHorizontalAccuracy(_ accuracy: CLLocationAccuracy) -> Bool {
        accuracy >= 0
    }

    // One platform-specific notion of "may request a fix", shared by the
    // explicit request and the authorization callback so neither path can
    // drift (macOS reports `.authorized`, iOS `.authorizedWhenInUse`).
    nonisolated static func grantsLocation(_ status: CLAuthorizationStatus) -> Bool {
        #if os(macOS)
        return status == .authorizedAlways || status == .authorized
        #else
        return status == .authorizedAlways || status == .authorizedWhenInUse
        #endif
    }

    func requestOnce() {
        errorMessage = nil
        let status = manager.authorizationStatus
        if Self.grantsLocation(status) {
            isRequesting = true
            manager.requestLocation()
            return
        }
        switch status {
        case .notDetermined:
            isRequesting = true
            manager.requestWhenInUseAuthorization()
        case .denied, .restricted:
            errorMessage = "Location permission is off. No location will be attached."
        default:
            errorMessage = "Location is unavailable. No location will be attached."
        }
    }

    func clear() {
        lookupGeneration.invalidate()
        labelResolver.cancel()
        location = nil
        locationLabel = nil
        isRequesting = false
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        Task { @MainActor [weak self] in
            guard let self else { return }
            if Self.grantsLocation(status) {
                self.manager.requestLocation()
            } else if status == .denied || status == .restricted {
                self.isRequesting = false
                self.errorMessage = "Location permission is off. No location will be attached."
            }
        }
    }

    nonisolated func locationManager(
        _ manager: CLLocationManager,
        didUpdateLocations locations: [CLLocation]
    ) {
        Task { @MainActor in
            guard let latest = locations.last else {
                isRequesting = false
                return
            }
            let generation = lookupGeneration.invalidate()
            labelResolver.cancel()
            guard Self.isValidHorizontalAccuracy(latest.horizontalAccuracy) else {
                isRequesting = false
                errorMessage = "Location accuracy is unavailable. Try again."
                return
            }
            location = latest
            locationLabel = nil
            isRequesting = false
            if let resolvedLabel = await labelResolver.resolveLabel(for: latest) {
                guard lookupGeneration.isCurrent(generation),
                      location?.timestamp == latest.timestamp else { return }
                locationLabel = resolvedLabel
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        let message = error.localizedDescription
        Task { @MainActor in
            isRequesting = false
            errorMessage = message
        }
    }
}
