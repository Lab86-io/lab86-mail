#if DEBUG
    import SwiftUI

    /// Points a fast-lane build at a different copy of the web app.
    ///
    /// Only compiled into Debug builds. A distributed build has no way to reach
    /// this screen and no way to store the value it writes, so the guarantee
    /// that shipped apps talk to production is unaffected.
    struct DeveloperSettingsView: View {
        @Environment(AppEnvironment.self) private var environment
        @AppStorage(DevelopmentAPIOverride.defaultsKey) private var storedOverride = ""
        @State private var draft = ""
        @State private var invalidEntry = false

        private var activeTarget: String {
            environment.configuration.apiBaseURL?.absoluteString ?? "not configured"
        }

        private var pendingTarget: String {
            DevelopmentAPIOverride.normalized(storedOverride)?.absoluteString ?? "https://mail.lab86.io"
        }

        private var needsRelaunch: Bool { pendingTarget != activeTarget }

        var body: some View {
            Form {
                Section {
                    LabeledContent("Running against", value: activeTarget)
                    if needsRelaunch {
                        Text("Next launch: \(pendingTarget)")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                } footer: {
                    Text("The app server only. Your session and your data stay on production either way, so a change here swaps the code serving the screens without swapping the account behind them.")
                }

                Section("Server") {
                    Button("Production") { apply("") }
                        .disabled(storedOverride.isEmpty)
                    Button("Tailnet development server") {
                        apply(DevelopmentAPIOverride.tailnetDevelopmentURL)
                    }
                    .disabled(storedOverride == DevelopmentAPIOverride.tailnetDevelopmentURL)
                }

                Section {
                    TextField("https://…", text: $draft)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .onSubmit { applyDraft() }
                    Button("Use this address") { applyDraft() }
                        .disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty)
                    if invalidEntry {
                        Text("That is not an absolute http or https address.")
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                } header: {
                    Text("Another address")
                } footer: {
                    Text(needsRelaunch
                        ? "Quit and reopen Albatross Dev to pick this up. The app builds its clients once at launch."
                        : "Already running against this address.")
                }
            }
            .navigationTitle("Development")
            .navigationBarTitleDisplayMode(.inline)
            .onAppear { draft = storedOverride }
        }

        private func applyDraft() {
            guard let url = DevelopmentAPIOverride.normalized(draft) else {
                invalidEntry = true
                return
            }
            apply(url.absoluteString)
        }

        private func apply(_ value: String) {
            invalidEntry = false
            storedOverride = value
            draft = value
        }
    }
#endif
