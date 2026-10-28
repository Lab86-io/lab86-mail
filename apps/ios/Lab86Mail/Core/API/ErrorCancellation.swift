import Foundation

// A request that a view gave up on is not a failure. When SwiftUI cancels a
// `.task` (the view left, a search changed, a sheet closed), URLSession throws
// `URLError(.cancelled)`, not `CancellationError`, so a check for only the
// second one lets "cancelled" reach the person as an error. Every catch that
// shows or records an error checks this first.
extension Error {
    var isCancellation: Bool {
        if self is CancellationError { return true }
        if let url = self as? URLError, url.code == .cancelled { return true }
        let ns = self as NSError
        return ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled
    }
}
