// swift-tools-version: 6.0
import PackageDescription

// RefusalKit — the app's logic, in a package rather than the app target so it
// can be tested with `swift test` on the Mac, with no simulator and no Xcode
// project in the loop.
//
// The distress gate lives here and it is the reason this package exists at all.
// On-device there is NO PROXY in front of the model: `api/src/safety.ts` runs on
// the droplet and cannot help an offline app. This package IS the safety layer
// for iOS, so it has to be as testable as the Python one — `eval/check_guard.py`
// scores it directly, the same way it scores the deployed TypeScript.
let package = Package(
    name: "RefusalKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "RefusalKit", targets: ["RefusalKit"]),
    ],
    targets: [
        .target(name: "RefusalKit"),
        .testTarget(name: "RefusalKitTests", dependencies: ["RefusalKit"]),
    ]
)
