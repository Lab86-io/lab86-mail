import Foundation

/// One definition of "this string says nothing".
///
/// Decoders across the app use it to turn `""` and `"   "` into `nil`, so an
/// empty server field never reaches a view as a blank line. It used to be
/// declared `private` in two separate files, which meant every new decoder
/// either could not see it or had to declare a third copy.
extension String {
    var nilIfBlank: String? {
        let value = trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }
}
