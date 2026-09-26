import SwiftUI

/// Daily Brief delivery (round 2, FEATURES items 3, 6, 9): the delivery
/// hour, the weekend edition, the Sunday weekly review, and the edition by
/// email. One row per choice, each change saved at once. The email switch is
/// off and says why when the server has no email service.
struct BriefSettingsView: View {
    @Environment(AppEnvironment.self) private var environment
    @State private var preferences: BriefPreferences?
    @State private var isSaving = false
    @State private var errorMessage: String?
    @State private var loadFailed = false

    private var client: BriefSettingsClient { BriefSettingsClient(tools: environment.tools) }

    var body: some View {
        Form {
            if let preferences {
                Section {
                    Picker("Delivery time", selection: binding(\.deliveryHour) { BriefPreferencesPatch(deliveryHour: $0) }) {
                        ForEach(BriefPreferences.deliveryHours, id: \.self) { hour in
                            Text(BriefPreferences.hourLabel(hour)).tag(hour)
                        }
                    }
                    Picker("Weekends", selection: binding(\.weekendMode) { BriefPreferencesPatch(weekendMode: $0) }) {
                        ForEach(BriefWeekendMode.allCases) { mode in
                            Text(mode.label).tag(mode)
                        }
                    }
                    Toggle(
                        "Weekly review on Sunday",
                        isOn: binding(\.weeklyReview) { BriefPreferencesPatch(weeklyReview: $0) }
                    )
                } header: {
                    Text("Delivery")
                } footer: {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(preferences.scheduleSummary)
                        Text(preferences.weekendMode.detail)
                        if preferences.weeklyReview {
                            Text("The weekly review lists what you finished, what is still open, who you wait on, and next week, with Defer and Drop on each item. It replaces the Sunday edition.")
                        }
                        Text(zoneLine(preferences))
                    }
                }

                Section {
                    Toggle(
                        "Send each edition by email",
                        isOn: binding(\.emailEnabled) { BriefPreferencesPatch(emailEnabled: $0) }
                    )
                    .disabled(!preferences.emailAvailable)
                } header: {
                    Text("Email")
                } footer: {
                    if preferences.emailAvailable {
                        Text("The edition goes to your sign-in address, with links back to each item.")
                    } else {
                        Text(preferences.emailUnavailableReason ?? "Email delivery is not set up on this server yet.")
                    }
                }

                Section {
                    Text("A missed delivery tries again each hour for four hours. Write a new edition from Today at any time.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            } else if loadFailed {
                Section {
                    Text("The brief delivery settings could not load.")
                        .foregroundStyle(.secondary)
                    Button("Try Again") { Task { await load() } }
                }
            } else {
                Section {
                    ProgressView("Loading brief delivery…")
                }
            }

            if let errorMessage {
                Section {
                    Text(errorMessage).font(.footnote).foregroundStyle(.red)
                }
            }
        }
        .navigationTitle("Daily Brief")
        .navigationBarTitleDisplayMode(.inline)
        .disabled(isSaving)
        .task { await load() }
    }

    private func zoneLine(_ preferences: BriefPreferences) -> String {
        if let timezone = preferences.timezone {
            return "In \(timezone.replacingOccurrences(of: "_", with: " ")). The zone comes from Notifications."
        }
        return "In your calendar zone once it syncs. You can set the zone in Notifications."
    }

    // A control bound to one field. A change saves at once; the control
    // moves back when the server refuses it.
    private func binding<Value: Equatable>(
        _ keyPath: WritableKeyPath<BriefPreferences, Value>,
        patch: @escaping (Value) -> BriefPreferencesPatch
    ) -> Binding<Value> {
        Binding(
            get: { preferences?[keyPath: keyPath] ?? BriefPreferences()[keyPath: keyPath] },
            set: { value in
                guard var current = preferences, current[keyPath: keyPath] != value else { return }
                let previous = current
                current[keyPath: keyPath] = value
                preferences = current
                Task { await save(patch(value), previous: previous) }
            }
        )
    }

    private func load() async {
        loadFailed = false
        do {
            preferences = try await client.preferences()
        } catch {
            loadFailed = preferences == nil
            errorMessage = preferences == nil ? nil : error.localizedDescription
        }
    }

    private func save(_ patch: BriefPreferencesPatch, previous: BriefPreferences) async {
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }
        do {
            preferences = try await client.save(patch)
        } catch {
            preferences = previous
            errorMessage = error.localizedDescription
        }
    }
}
