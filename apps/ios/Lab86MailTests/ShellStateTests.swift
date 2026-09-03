import Testing
@testable import Lab86Mail

// The Areas list placeholder shared by both shells: a failed first load must
// expose its retry instead of sitting behind "Loading areas…" forever.
struct ShellStateTests {
    @Test
    func areaListStatePrefersLoadingThenFailureThenEmptiness() {
        #expect(AreaListState.resolve(isLoading: true, didLoad: false, hasError: false) == .loading)
        #expect(AreaListState.resolve(isLoading: true, didLoad: true, hasError: true) == .loading)
        // The initial failure: nothing loaded, not loading, an error recorded.
        #expect(AreaListState.resolve(isLoading: false, didLoad: false, hasError: true) == .failed)
        #expect(AreaListState.resolve(isLoading: false, didLoad: true, hasError: true) == .failed)
        #expect(AreaListState.resolve(isLoading: false, didLoad: true, hasError: false) == .empty)
        // Before the first fetch even starts there is nothing to say but loading.
        #expect(AreaListState.resolve(isLoading: false, didLoad: false, hasError: false) == .loading)
    }
}
