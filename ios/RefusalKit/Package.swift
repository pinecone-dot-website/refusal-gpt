// swift-tools-version: 6.0
import PackageDescription

// RefusalKit — the app's logic, in a package rather than the app target so it
// can be tested with `swift test` on the Mac, with no simulator and no Xcode
// project in the loop.
//
// TWO TARGETS, AND THE SPLIT IS DELIBERATE.
//
// `RefusalKit` is pure Swift with no dependency on llama.cpp. That is what lets
// `eval/check_guard.py` score the distress gate by compiling two source files
// with plain `swiftc` — no package resolution, no 835 MB binary framework, no
// Xcode. The gate has to be as cheap to test as the Python one or it will stop
// being tested, and a gate that stops being tested is this project's oldest
// documented failure.
//
// `RefusalLlama` is where the model lives. If it ever needs to import the gate
// that is fine; the dependency must never point the other way.
let package = Package(
    name: "RefusalKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "RefusalKit", targets: ["RefusalKit"]),
        .library(name: "RefusalLlama", targets: ["RefusalLlama"]),
    ],
    targets: [
        .target(name: "RefusalKit"),

        // Built from ~/Documents/dev/llama.cpp with ./build-xcframework.sh.
        // NOT vendored into git — 835 MB, and it is a build product.
        .binaryTarget(name: "llama", path: "../Frameworks/llama.xcframework"),

        .target(name: "RefusalLlama", dependencies: ["RefusalKit", "llama"]),

        // A CLI so the iOS inference path can be smoke-tested on the Mac with no
        // simulator, and — the real prize — so eval/run_model.py can one day
        // score the SAME code the app runs. This project's oldest rule is to
        // eval the shipping artifact; on iOS the shipping artifact is this
        // target, not the GGUF and not the MLX adapter.
        .executableTarget(name: "refusal-cli", dependencies: ["RefusalKit", "RefusalLlama"]),

        .testTarget(name: "RefusalKitTests", dependencies: ["RefusalKit"]),
    ]
)
