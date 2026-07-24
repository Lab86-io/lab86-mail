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

    @State private var attempt = 0

    private var sources: [String] { AreaImageSource.ordered(imageURL: imageURL, faviconURL: faviconURL) }

    private var currentSource: URL? {
        guard attempt < sources.count else { return nil }
        return URL(string: sources[attempt])
    }

    var body: some View {
        Group {
            if let url = currentSource {
                KFImage(url)
                    .onFailure { _ in
                        if attempt < sources.count { attempt += 1 }
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
