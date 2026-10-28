import Kingfisher
import SwiftUI

/// Settings, What's new: the product notes the web ships, read from the
/// server. Each batch is a dated section: its title in the display face,
/// its summary, and its changes with a quiet kind word. Pictures load from
/// the web app; HTML demos stay there, behind one link.
struct WhatsNewView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.openURL) private var openURL
    /// A release given by the caller, for the tour and previews. Nil reads
    /// the shared store.
    var preloaded: ProductRelease?

    private var store: ProductReleaseStore { ProductReleaseStore.shared }
    private var release: ProductRelease? { preloaded ?? store.release }

    var body: some View {
        Group {
            if let release {
                notes(release)
            } else if store.isLoading {
                ProgressView("Checking for updates…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let errorMessage = store.errorMessage {
                ContentUnavailableView {
                    Text("Could not check for updates")
                } description: {
                    Text(errorMessage)
                } actions: {
                    Button("Try again") { Task { await store.load(backend: environment.backend) } }
                        .buttonStyle(.bordered)
                }
            } else {
                ContentUnavailableView {
                    Text("No notes yet")
                } description: {
                    Text("Updates show here when the app changes.")
                }
            }
        }
        .navigationTitle("What’s new")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if preloaded == nil, store.release == nil {
                await store.load(backend: environment.backend)
            }
        }
        .onDisappear {
            if preloaded == nil { store.markSeen() }
        }
    }

    private func notes(_ release: ProductRelease) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 28) {
                ForEach(release.updates) { update in
                    WhatsNewUpdateSection(
                        update: update,
                        isNew: preloaded == nil && store.newUpdateIDs.contains(update.id),
                        imageBase: environment.configuration.apiBaseURL
                    )
                }
                webLink
            }
            .frame(maxWidth: 680)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 20)
            .padding(.vertical, 20)
        }
        .background(environment.theme.paperColor)
    }

    /// The Settings row already shows the version; this page adds only the
    /// way to the web notes and their demos.
    @ViewBuilder private var webLink: some View {
        if let url = updatesURL {
            Button("Open the notes on the web") { openURL(url) }
                .font(.footnote.weight(.medium))
        }
    }

    private var updatesURL: URL? {
        guard let base = environment.configuration.apiBaseURL else { return nil }
        return URL(string: "/updates", relativeTo: base)?.absoluteURL
    }
}

/// One batch of notes.
private struct WhatsNewUpdateSection: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.openURL) private var openURL
    let update: ProductUpdate
    let isNew: Bool
    let imageBase: URL?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            if let summary = update.summary {
                Text(summary)
                    .font(.body)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let screenshot = update.screenshot, let url = imageURL(screenshot) {
                picture(screenshot, url: url)
            }
            VStack(alignment: .leading, spacing: 0) {
                ForEach(update.changes) { change in
                    WhatsNewChangeRow(change: change)
                    if change.id != update.changes.last?.id {
                        Divider()
                    }
                }
            }
            .padding(.horizontal, 14)
            .insetPanel(cornerRadius: 12)
            if update.hasWebDemo, let url = demoURL {
                Button("See the demo on the web") { openURL(url) }
                    .font(.footnote.weight(.medium))
            }
        }
        .accessibilityElement(children: .contain)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(ProductReleaseNotice.dateLabel(update.publishedAt))
                    .font(environment.theme.displayType.displayItalicFont(size: 15))
                    .foregroundStyle(.secondary)
                if isNew {
                    Text("New to you")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(environment.theme.accentColor)
                }
            }
            Text(update.title)
                .font(environment.theme.displayType.displayFont(size: 24))
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
        }
    }

    private func picture(_ screenshot: ProductUpdateScreenshot, url: URL) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            KFImage(url)
                .placeholder {
                    Rectangle().fill(environment.theme.subtleColor)
                }
                .fade(duration: 0.15)
                .resizable()
                .aspectRatio(screenshot.aspectRatio, contentMode: .fit)
                .clipShape(.rect(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(environment.theme.hairlineColor))
                .accessibilityLabel(screenshot.alt)
            if !screenshot.caption.isEmpty {
                Text(screenshot.caption)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func imageURL(_ screenshot: ProductUpdateScreenshot) -> URL? {
        guard let imageBase else { return nil }
        return URL(string: screenshot.imagePath, relativeTo: imageBase)?.absoluteURL
    }

    private var demoURL: URL? {
        guard let imageBase else { return nil }
        return URL(string: "/updates#\(update.id)", relativeTo: imageBase)?.absoluteURL
    }
}

/// One change: the title with its kind word on the same baseline, then the
/// description.
private struct WhatsNewChangeRow: View {
    let change: ProductUpdateChange

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(change.title)
                    .font(.body.weight(.medium))
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                Text(change.kind.label)
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .fixedSize()
            }
            if !change.description.isEmpty {
                Text(change.description)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 12)
        .accessibilityElement(children: .combine)
    }
}

/// The row in Settings, Build: "What's new" with the version, and a dot
/// while a release waits to be seen.
struct WhatsNewSettingsRow: View {
    @Environment(AppEnvironment.self) private var environment

    private var store: ProductReleaseStore { ProductReleaseStore.shared }

    var body: some View {
        HStack(spacing: 8) {
            Text("What’s new")
            if store.hasUnseenRelease {
                Circle()
                    .fill(environment.theme.accentColor)
                    .frame(width: 7, height: 7)
                    .accessibilityLabel("Unseen")
            }
            Spacer()
            if let version = store.release?.version {
                Text(version)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

