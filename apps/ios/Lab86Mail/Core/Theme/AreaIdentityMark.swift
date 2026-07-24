import Kingfisher
import SwiftUI

// Shared ordering logic for an area's identity mark: the area's own image
// first, then its favicon, dropping blank values. Extracted as a pure,
// stateless helper so the fallback chain is unit-testable without SwiftUI.
enum AreaImageSource {
    static func ordered(imageURL: String?, faviconURL: String?) -> [String] {
        [imageURL, faviconURL].compactMap { value in
            guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
                return nil
            }
            return trimmed
        }
    }
}

// Ordered image-source cursor shared by every surface that walks a fallback
// chain on load failure (identity marks and both mastheads): a pure value the
// views hold in @State, so the walk itself is unit-testable without SwiftUI.
struct ImageSourceWalk: Equatable {
    private(set) var attempt = 0

    func current(in sources: [URL]) -> URL? {
        guard attempt < sources.count else { return nil }
        return sources[attempt]
    }

    mutating func advance(in sources: [URL]) {
        if attempt < sources.count { attempt += 1 }
    }

    // A terminal cursor must start over when the source list itself changes
    // (fresh artwork/identity after a refresh) — otherwise one dead URL parks
    // the surface on its fallback forever. Views call this from onChange(of:
    // sources).
    mutating func resetIfSourcesChanged(from old: [URL], to new: [URL]) {
        if old != new { attempt = 0 }
    }
}

// A shared area icon mark used everywhere an area renders an identity image:
// sidebar rows, the Areas list, and area detail surfaces. Fallback chain is
// imageURL → (on load failure) faviconURL → a deterministic monogram, reusing
// the same FNV-1a palette every other identity mark in the app draws from.
struct AreaIdentityMark: View {
    enum CornerStyle {
        case circle
        case rounded(CGFloat)
    }

    let name: String
    let seed: String
    let imageURL: String?
    let faviconURL: String?
    var size: CGFloat = 30
    var cornerStyle: CornerStyle = .circle

    @State private var walk = ImageSourceWalk()

    private var sources: [URL] {
        AreaImageSource.ordered(imageURL: imageURL, faviconURL: faviconURL).compactMap(URL.init(string:))
    }

    var body: some View {
        Group {
            if let url = walk.current(in: sources) {
                KFImage(url)
                    .onFailure { _ in
                        walk.advance(in: sources)
                    }
                    .placeholder { monogram }
                    .fade(duration: 0.15)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .frame(width: size, height: size)
                    .clipped()
                    .clipShape(clipShape)
            } else {
                monogram
            }
        }
        .frame(width: size, height: size)
        .onChange(of: sources) { old, new in
            walk.resetIfSourcesChanged(from: old, to: new)
        }
        .accessibilityHidden(true)
    }

    private var monogram: some View {
        InitialsAvatar(name: name, seed: seed, size: size)
    }

    private var clipShape: AnyShape {
        switch cornerStyle {
        case .circle:
            return AnyShape(Circle())
        case .rounded(let radius):
            return AnyShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
        }
    }
}
