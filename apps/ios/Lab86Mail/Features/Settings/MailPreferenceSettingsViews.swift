import SwiftUI

/// Settings, Mail alerts (round 2, FEATURES item 12): priority-only push,
/// quiet hours, and VIP senders. Each change saves at once; the control moves
/// back when the server refuses it.
struct MailAlertsSettingsView: View {
    @Environment(AppEnvironment.self) private var environment
    @State private var settings: MailAlertSettings?
    @State private var loadFailed = false
    @State private var isSaving = false
    @State private var errorMessage: String?
    @State private var vipInput = ""

    var body: some View {
        Form {
            if let settings {
                Section {
                    Picker("Push for", selection: Binding(
                        get: { settings.mode },
                        set: { mode in apply(MailAlertSettingsPatch(mode: mode)) { $0.mode = mode } }
                    )) {
                        ForEach(MailAlertSettings.Mode.allCases) { mode in
                            Text(mode.label).tag(mode)
                        }
                    }
                } header: {
                    Text("Mail alerts")
                } footer: {
                    Text(settings.mode.detail)
                }

                Section {
                    Toggle("Quiet hours", isOn: Binding(
                        get: { settings.quietHoursEnabled },
                        set: { on in apply(MailAlertSettingsPatch(quietHoursEnabled: on)) { $0.quietHoursEnabled = on } }
                    ))
                    if settings.quietHoursEnabled {
                        hourPicker("From", value: settings.quietStart) { hour in
                            apply(MailAlertSettingsPatch(quietStart: hour)) { $0.quietStart = hour }
                        }
                        hourPicker("To", value: settings.quietEnd) { hour in
                            apply(MailAlertSettingsPatch(quietEnd: hour)) { $0.quietEnd = hour }
                        }
                        if !settings.quietHoursValid {
                            Text("Choose two different hours.")
                                .font(.footnote)
                                .foregroundStyle(.red)
                        }
                    }
                } footer: {
                    Text("No mail pushes in these hours, except from VIP senders. What arrives waits for one summary when quiet hours end. Hours use your notification time zone (\(settings.timezone)).")
                }

                Section {
                    ForEach(settings.vipSenders, id: \.self) { entry in
                        Text(entry)
                            .swipeActions {
                                Button("Remove", role: .destructive) { remove(entry) }
                            }
                            .contextMenu {
                                Button("Remove", role: .destructive) { remove(entry) }
                            }
                    }
                    HStack {
                        TextField("ann@example.com or @example.com", text: $vipInput)
                            .textContentType(.emailAddress)
                            .keyboardType(.emailAddress)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .onSubmit(addVIP)
                            .accessibilityLabel("Add a VIP sender")
                        Button("Add", action: addVIP)
                            .disabled(MailAlertSettings.normalizedVIP(vipInput) == nil)
                    }
                } header: {
                    Text("VIP senders")
                } footer: {
                    Text("Mail from these addresses or domains always pushes, in quiet hours too. These settings apply to mail pushes on iPhone and Mac.")
                }
            } else if loadFailed {
                Section {
                    Text("Mail alerts could not load.").foregroundStyle(.secondary)
                    Button("Try Again") { Task { await load() } }
                }
            } else {
                Section { ProgressView("Loading mail alerts…") }
            }
            if let errorMessage {
                Section { Text(errorMessage).font(.footnote).foregroundStyle(.red) }
            }
        }
        .navigationTitle("Mail alerts")
        .navigationBarTitleDisplayMode(.inline)
        .disabled(isSaving)
        .task { await load() }
    }

    private func hourPicker(_ title: String, value: Int, onChange: @escaping (Int) -> Void) -> some View {
        Picker(title, selection: Binding(get: { value }, set: onChange)) {
            ForEach(0..<24, id: \.self) { hour in
                Text(MailAlertSettings.hourLabel(hour)).tag(hour)
            }
        }
    }

    private func addVIP() {
        guard let entry = MailAlertSettings.normalizedVIP(vipInput) else { return }
        apply(MailAlertSettingsPatch(addVipSenders: [entry])) { settings in
            if !settings.vipSenders.contains(entry) { settings.vipSenders.append(entry) }
        }
        vipInput = ""
    }

    private func remove(_ entry: String) {
        apply(MailAlertSettingsPatch(removeVipSenders: [entry])) { $0.vipSenders.removeAll { $0 == entry } }
    }

    // Shows the change at once, saves it, and takes the server's copy. A
    // refusal puts the previous settings back and says why.
    private func apply(_ patch: MailAlertSettingsPatch, local: (inout MailAlertSettings) -> Void) {
        guard var next = settings else { return }
        let previous = next
        local(&next)
        settings = next
        // The server refuses equal quiet hours; wait until they differ.
        if next.quietHoursEnabled, next.quietStart == next.quietEnd { return }
        Task { await save(patch, previous: previous) }
    }

    private func load() async {
        loadFailed = false
        do {
            let json = try await environment.backend.get(path: MailAlertSettings.path)
            guard let loaded = MailAlertSettings(json: json) else { throw BackendError.invalidResponse }
            settings = loaded
        } catch {
            loadFailed = settings == nil
        }
    }

    private func save(_ patch: MailAlertSettingsPatch, previous: MailAlertSettings) async {
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }
        do {
            let json = try await environment.backend.put(path: MailAlertSettings.path, body: patch.body)
            if let saved = MailAlertSettings(json: json) { settings = saved }
        } catch {
            settings = previous
            errorMessage = error.localizedDescription
        }
    }
}

/// Settings, How you write (round 2, FEATURES item 16): greeting, sign-off,
/// typical length, and tone, learned from up to 50 recent sent emails at
/// most once a week, and editable. Drafts use it.
struct VoiceProfileSettingsView: View {
    @Environment(AppEnvironment.self) private var environment
    @State private var profile: VoiceProfile?
    @State private var form = VoiceProfile()
    @State private var nextLearnAt: Date?
    @State private var didLoad = false
    @State private var isSaving = false
    @State private var isLearning = false
    @State private var confirmsReplace = false
    @State private var notice: String?
    @State private var errorMessage: String?

    private var client: VoiceProfileClient { VoiceProfileClient(tools: environment.tools) }
    private var dirty: Bool { form.editableFields != (profile ?? VoiceProfile()).editableFields }
    private var waitUntil: Date? {
        guard let nextLearnAt, nextLearnAt > .now else { return nil }
        return nextLearnAt
    }

    var body: some View {
        Form {
            Section {
                Text(VoiceProfile.sourceLine(profile))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Section {
                TextField("Hi {name},", text: $form.greeting)
                    .accessibilityLabel("Greeting")
            } header: {
                Text("Greeting")
            } footer: {
                Text("How you open. {name} becomes the recipient’s first name.")
            }
            Section {
                TextEditor(text: $form.signOff)
                    .frame(minHeight: 60)
                    .accessibilityLabel("Sign-off")
            } header: {
                Text("Sign-off")
            } footer: {
                Text("How you close. When a mailbox signature is on, drafts leave your name to the signature.")
            }
            Section {
                Picker("Length", selection: $form.length) {
                    ForEach(VoiceProfile.Length.allCases) { length in
                        Text(length.label).tag(length)
                    }
                }
            } footer: {
                Text(profile.map { $0.typicalWords > 0 ? "Your sent mail runs about \($0.typicalWords) words." : "How long your replies usually are." }
                    ?? "How long your replies usually are.")
            }
            Section {
                TextField("Warm and direct, short sentences", text: $form.tone)
                    .accessibilityLabel("Tone")
            } header: {
                Text("Tone")
            } footer: {
                Text("A few words on how you sound.")
            }
            Section {
                TextEditor(text: $form.notes)
                    .frame(minHeight: 70)
                    .accessibilityLabel("Anything else")
            } header: {
                Text("Anything else")
            } footer: {
                Text("Albatross keeps this when it learns again.")
            }
            Section {
                Button(learnLabel) {
                    if profile?.edited == true, !confirmsReplace {
                        confirmsReplace = true
                        return
                    }
                    Task { await learn() }
                }
                .disabled(isLearning || waitUntil != nil || !didLoad)
                if let waitUntil {
                    Text("Next time on \(VoiceProfile.dayLabel(waitUntil)).")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } else if confirmsReplace {
                    Text("Learning again replaces your greeting, sign-off, length, and tone.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                if let notice {
                    Text(notice).font(.footnote).foregroundStyle(.secondary)
                }
            } footer: {
                Text("Albatross reads up to 50 of your recent sent emails, at most once a week, and keeps only this card. Drafts from Draft a reply and from the assistant use it.")
            }
            if let errorMessage {
                Section { Text(errorMessage).font(.footnote).foregroundStyle(.red) }
            }
        }
        .navigationTitle("How you write")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button(isSaving ? "Saving…" : "Save") { Task { await save() } }
                    .disabled(!dirty || isSaving || !didLoad)
            }
        }
        .task { await load() }
    }

    private var learnLabel: String {
        if isLearning { return "Reading your sent mail…" }
        if confirmsReplace { return "Replace my edits" }
        return profile?.learnedAt == nil ? "Learn from my sent mail" : "Learn again"
    }

    private func load() async {
        do {
            let state = try await client.load()
            profile = state.profile
            form = state.profile ?? VoiceProfile()
            nextLearnAt = state.nextLearnAt
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
        didLoad = true
    }

    private func save() async {
        isSaving = true
        defer { isSaving = false }
        do {
            if let saved = try await client.update(form) {
                profile = saved
                form = saved
            }
            notice = "Saved how you write."
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func learn() async {
        isLearning = true
        defer { isLearning = false }
        do {
            let result = try await client.learn(replaceEdited: confirmsReplace)
            confirmsReplace = false
            if let learned = result.profile {
                profile = learned
                form = learned
            }
            nextLearnAt = result.nextLearnAt ?? nextLearnAt
            notice = result.message
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription.nilIfBlank ?? "Could not learn from your sent mail."
        }
    }
}
