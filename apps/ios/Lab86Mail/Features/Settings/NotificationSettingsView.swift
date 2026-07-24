import SwiftUI
import UIKit
import UserNotifications

struct NotificationSettingsView: View {
    @Environment(AppEnvironment.self) private var environment
    @State private var preferences = MobileNotificationPreferences()
    @State private var isLoaded = false
    @State private var isSaving = false
    @State private var locationCoordinator = CaptureLocationCoordinator()

    var body: some View {
        Form {
            Section("System permission") {
                LabeledContent("Notifications", value: authorizationLabel)
                if environment.notifications.authorizationStatus == .denied {
                    Button("Open iOS Settings", systemImage: "gear") {
                        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
                        UIApplication.shared.open(url)
                    }
                } else if environment.notifications.authorizationStatus == .notDetermined {
                    Button("Enable notifications") {
                        Task { await environment.notifications.requestAuthorization() }
                    }
                }
            }

            Section {
                Toggle("Allow Albatross notifications", isOn: $preferences.nativePushEnabled)
                Toggle("New mail", isOn: $preferences.newMailPushEnabled)
                    .disabled(!preferences.nativePushEnabled)
                Toggle("Calendar suggestions from mail", isOn: $preferences.eventSuggestionPushEnabled)
                    .disabled(!preferences.nativePushEnabled)
                Toggle("Morning Brief is ready", isOn: $preferences.morningBriefEnabled)
                    .disabled(!preferences.nativePushEnabled)
                Toggle("In-app Activity", isOn: $preferences.inAppEnabled)
            } header: {
                Text("Delivery")
            } footer: {
                Text("iOS Focus and per-app notification settings still take precedence.")
            }

            Section {
                Toggle("Evening check-in", isOn: $preferences.eveningCheckinEnabled)
                DatePicker(
                    "Check-in time",
                    selection: checkinTimeBinding,
                    displayedComponents: .hourAndMinute
                )
                .disabled(!preferences.eveningCheckinEnabled)
                TextField("Timezone", text: $preferences.timezone)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            } header: {
                Text("Check-in schedule")
            } footer: {
                Text("Two freeform prompts ask what moved today and what matters tomorrow. Timezone uses an IANA identifier such as \(TimeZone.current.identifier).")
            }

            Section {
                LabeledContent(
                    "Brief weather",
                    value: preferences.briefLocationEnabled
                        ? (preferences.briefLocationLabel ?? "Current location")
                        : "Timezone estimate"
                )
                Button {
                    locationCoordinator.requestOnce()
                } label: {
                    if locationCoordinator.isRequesting {
                        Label("Finding location…", systemImage: "location")
                    } else {
                        Label(
                            preferences.briefLocationEnabled
                                ? "Update Current Location"
                                : "Use Current Location",
                            systemImage: "location.fill"
                        )
                    }
                }
                .disabled(locationCoordinator.isRequesting)
                if preferences.briefLocationEnabled {
                    Button("Stop Using Location", role: .destructive) {
                        preferences.briefLocationEnabled = false
                        preferences.briefLatitude = nil
                        preferences.briefLongitude = nil
                        preferences.briefLocationLabel = nil
                        preferences.briefLocationAccuracy = nil
                        preferences.briefLocationUpdatedAt = nil
                    }
                }
                if let error = locationCoordinator.errorMessage {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            } header: {
                Text("Daily Brief location")
            } footer: {
                Text("Albatross stores an approximate location only after you tap Use Current Location. It is used to fetch local morning weather and can be removed here.")
            }

            Section {
                Toggle("Fallback email", isOn: $preferences.emailFallbackEnabled)
                Stepper(
                    "Delay: \(preferences.emailFallbackDelayMinutes) minutes",
                    value: $preferences.emailFallbackDelayMinutes,
                    in: 15...1440,
                    step: 15
                )
                .disabled(!preferences.emailFallbackEnabled)
            } footer: {
                Text("Email is sent only when the scheduled check-in is still unanswered after this delay.")
            }

            if let error = environment.notifications.preferencesError {
                Section {
                    Text(error).font(.footnote).foregroundStyle(.red)
                }
            }
        }
        .navigationTitle("Notifications")
        .navigationBarTitleDisplayMode(.inline)
        .disabled(!isLoaded || isSaving)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button(isSaving ? "Saving…" : "Save") { Task { await save() } }
                    .disabled(!isLoaded || isSaving)
            }
        }
        .task {
            await environment.notifications.refreshAuthorizationStatus()
            await environment.notifications.loadPreferences()
            preferences = environment.notifications.preferences
            isLoaded = true
        }
        .onChange(of: locationCoordinator.location?.timestamp) { _, _ in
            guard let location = locationCoordinator.location,
                  CaptureLocationCoordinator.isValidHorizontalAccuracy(location.horizontalAccuracy) else {
                return
            }
            preferences.briefLocationEnabled = true
            preferences.briefLatitude = location.coordinate.latitude
            preferences.briefLongitude = location.coordinate.longitude
            preferences.briefLocationAccuracy = location.horizontalAccuracy
            preferences.briefLocationUpdatedAt = location.timestamp.timeIntervalSince1970 * 1_000
            preferences.briefLocationLabel = locationCoordinator.locationLabel ?? "Current location"
        }
        .onChange(of: locationCoordinator.locationLabel) { _, label in
            guard preferences.briefLocationEnabled, let label, !label.isEmpty else { return }
            preferences.briefLocationLabel = label
        }
    }

    private var checkinTimeBinding: Binding<Date> {
        Binding(
            get: {
                let parts = preferences.eveningCheckinLocalTime.split(separator: ":").compactMap {
                    Int($0)
                }
                return Calendar.current.date(
                    bySettingHour: parts.first ?? 19,
                    minute: parts.dropFirst().first ?? 0,
                    second: 0,
                    of: .now
                ) ?? .now
            },
            set: {
                let components = Calendar.current.dateComponents([.hour, .minute], from: $0)
                preferences.eveningCheckinLocalTime = String(
                    format: "%02d:%02d",
                    components.hour ?? 19,
                    components.minute ?? 0
                )
            }
        )
    }

    private var authorizationLabel: String {
        switch environment.notifications.authorizationStatus {
        case .authorized, .provisional, .ephemeral: "Enabled"
        case .denied: "Disabled"
        case .notDetermined: "Not requested"
        @unknown default: "Unknown"
        }
    }

    private func save() async {
        isSaving = true
        defer { isSaving = false }
        await environment.notifications.savePreferences(preferences)
        preferences = environment.notifications.preferences
    }
}
