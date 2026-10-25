import Foundation
import Testing
@testable import Lab86Mail

struct ErrorCancellationTests {
    @Test
    func aCancelledTaskAndACancelledRequestAreBothCancellations() {
        #expect(CancellationError().isCancellation)
        #expect(URLError(.cancelled).isCancellation)
        #expect(NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled).isCancellation)
    }

    @Test
    func realFailuresAreNotCancellations() {
        #expect(!URLError(.networkConnectionLost).isCancellation)
        #expect(!URLError(.timedOut).isCancellation)
        #expect(!NSError(domain: NSURLErrorDomain, code: NSURLErrorNotConnectedToInternet).isCancellation)
        #expect(!NSError(domain: "lab86", code: 1).isCancellation)
    }
}
