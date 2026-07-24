@preconcurrency import AVFoundation
import CoreLocation
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
        let microphone = await withCheckedContinuation { continuation in
            AVAudioSession.sharedInstance().requestRecordPermission {
                continuation.resume(returning: $0)
            }
        }
        guard microphone else {
            errorMessage = "Microphone permission was not granted. You can keep typing."
            return
        }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: [.duckOthers])
            try session.setActive(true, options: .notifyOthersOnDeactivation)

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

@MainActor
final class SystemLocationLabelResolver: CaptureLocationLabelResolving {
    private let geocoder = CLGeocoder()

    func resolveLabel(for location: CLLocation) async -> String? {
        guard let placemark = try? await geocoder.reverseGeocodeLocation(location).first else {
            return nil
        }
        let resolvedLabel = [placemark.locality, placemark.administrativeArea]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: ", ")
        return resolvedLabel.isEmpty ? nil : resolvedLabel
    }

    func cancel() {
        geocoder.cancelGeocode()
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

    func requestOnce() {
        errorMessage = nil
        switch manager.authorizationStatus {
        case .notDetermined:
            isRequesting = true
            manager.requestWhenInUseAuthorization()
        case .authorizedAlways, .authorizedWhenInUse:
            isRequesting = true
            manager.requestLocation()
        case .denied, .restricted:
            errorMessage = "Location permission is off. No location will be attached."
        @unknown default:
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
            if status == .authorizedAlways || status == .authorizedWhenInUse {
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
