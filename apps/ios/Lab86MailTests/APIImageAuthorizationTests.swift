import Foundation
import Testing
@testable import Lab86Mail

// Company logo avatars (M7): only requests to the app's own API origin carry
// the bearer token.
struct APIImageAuthorizationTests {
    private let api = URL(string: "https://mail.lab86.io")!

    @Test
    func aLogoOnTheAPIOriginIsAuthorized() {
        let logo = URL(string: "https://mail.lab86.io/api/logos/vendor.com")!
        #expect(APIImageAuthorization.shouldAuthorize(logo, apiBaseURL: api))
    }

    @Test
    func aProviderPhotoHostNeverSeesTheToken() {
        let photo = URL(string: "https://lh3.googleusercontent.com/a/photo")!
        #expect(!APIImageAuthorization.shouldAuthorize(photo, apiBaseURL: api))
        let lookalike = URL(string: "https://mail.lab86.io.evil.test/api/logos/vendor.com")!
        #expect(!APIImageAuthorization.shouldAuthorize(lookalike, apiBaseURL: api))
    }

    @Test
    func aSchemeOrPortMismatchIsNotTheAPIOrigin() {
        let plain = URL(string: "http://mail.lab86.io/api/logos/vendor.com")!
        #expect(!APIImageAuthorization.shouldAuthorize(plain, apiBaseURL: api))
        let otherPort = URL(string: "https://mail.lab86.io:8443/api/logos/vendor.com")!
        #expect(!APIImageAuthorization.shouldAuthorize(otherPort, apiBaseURL: api))
        // A development override on a local port matches itself.
        let dev = URL(string: "http://10.0.0.5:3000")!
        #expect(APIImageAuthorization.shouldAuthorize(URL(string: "http://10.0.0.5:3000/api/logos/x.com")!, apiBaseURL: dev))
    }

    @Test
    func noBaseURLOrNoURLMeansNoToken() {
        #expect(!APIImageAuthorization.shouldAuthorize(URL(string: "https://mail.lab86.io/api/logos/a.com")!, apiBaseURL: nil))
        #expect(!APIImageAuthorization.shouldAuthorize(nil, apiBaseURL: api))
    }

    @Test
    func theAuthorizedRequestCarriesABearerHeader() {
        let request = URLRequest(url: URL(string: "https://mail.lab86.io/api/logos/vendor.com")!)
        let authorized = APIImageAuthorization.authorized(request, token: "jwt-1")
        #expect(authorized.value(forHTTPHeaderField: "Authorization") == "Bearer jwt-1")
        #expect(authorized.url == request.url)
    }
}
