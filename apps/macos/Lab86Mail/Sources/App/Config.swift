import Foundation

// Public client configuration only — publishable key and deployment URLs are
// not secrets. Anything secret stays server-side.
enum Config {
    static let clerkPublishableKey = "pk_live_Y2xlcmsubWFpbC5sYWI4Ni5pbyQ"
    static let convexDeploymentUrl = "https://proficient-viper-594.convex.cloud"
    static let apiBase = URL(string: "https://mail.lab86.io")!
}
