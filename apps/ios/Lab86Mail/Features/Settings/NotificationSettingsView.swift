import SwiftUI
import UIKit
import UserNotifications

struct NotificationSettingsView: View {
    @Environment(AppEnvironment.self) private var environment
    @State private var preferences = MobileNotificationPreferences()
    @State private var isLoaded = false
    @State private var isSaving = false

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
                Text("Timezone uses an IANA identifier such as \(TimeZone.current.identifier).")
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
