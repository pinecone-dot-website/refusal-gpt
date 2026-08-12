import Foundation

/// Where the model lives on device.
///
/// NOT IN THE APP BUNDLE. The Q6 build is 1.2 GB; bundling it would push the app
/// past the App Store's cellular download limit and make every install a
/// hostage situation. It is fetched once into Application Support and excluded
/// from iCloud backup — a 1.2 GB file that can be re-downloaded has no business
/// in someone's backup quota.
///
/// The download itself is not written yet. What IS written is the part that
/// matters for correctness: a single place that answers "where is the model,
/// and is it actually there", so no other code invents its own path.
enum ModelStore {

    /// Matches deploy/Modelfile-1.5b — adapters-17-1.5b checkpoint 1700, fused
    /// at fp16, GGUF, quantized Q6_K. Q6 and not Q4 because at 303 eval rows Q6
    /// scored best of the quant ladder, and 1.2 GB is affordable when the KV
    /// cache at 8192 is only another 224 MiB.
    static let filename = "refusal-1.5b-q6.gguf"

    static var directory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory,
                                            in: .userDomainMask)[0]
        return base.appendingPathComponent("Models", isDirectory: true)
    }

    static var url: URL { directory.appendingPathComponent(filename) }

    static var isPresent: Bool {
        FileManager.default.fileExists(atPath: url.path)
    }

    /// Size on disk, for the UI to show rather than claim.
    static var sizeBytes: Int64? {
        guard let a = try? FileManager.default.attributesOfItem(atPath: url.path) else { return nil }
        return a[.size] as? Int64
    }

    static func prepareDirectory() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var dir = directory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? dir.setResourceValues(values)
    }

    /// What to tell someone when it is missing. Says where it looked, because
    /// "model not found" with no path is the least useful error in software.
    static var missingMessage: String {
        """
        No model installed.

        Expected: \(filename)
        In: \(directory.path)
        """
    }
}
