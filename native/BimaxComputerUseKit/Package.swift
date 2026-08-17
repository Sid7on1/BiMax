// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "BimaxComputerUseKit",
    // Bimax for Mac's support floor, matching electron-builder's minimumSystemVersion. Below
    // macOS 13 the XPC service cannot install NSXPCConnection code-signing requirements and would
    // silently degrade to the PID-based Security check (see docs/BIMAX_CU_SECURITY_MODEL.md).
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "BimaxCuProtocol", targets: ["BimaxCuProtocol"]),
        .library(name: "BimaxComputerUseKit", targets: ["BimaxComputerUseKit"]),
        .executable(name: "bimax-cu-service", targets: ["BimaxCuService"]),
        .executable(name: "bimax-cu-bridge", targets: ["BimaxCuBridge"]),
        .executable(name: "bimax-cu-tests", targets: ["BimaxCuTests"]),
        .executable(name: "bimax-cu-fixture", targets: ["BimaxCuFixture"]),
    ],
    targets: [
        .target(name: "BimaxCuProtocol"),
        .target(
            name: "BimaxFocusBridge",
            linkerSettings: [.linkedFramework("ApplicationServices")]
        ),
        .target(
            name: "BimaxComputerUseKit",
            dependencies: ["BimaxCuProtocol", "BimaxFocusBridge"],
            linkerSettings: [
                .linkedFramework("ApplicationServices"),
                .linkedFramework("AppKit"),
                .linkedFramework("CoreGraphics"),
                .linkedFramework("CoreImage"),
                .linkedFramework("CoreText"),
                .linkedFramework("ImageIO"),
                .linkedFramework("CoreMedia"),
                .linkedFramework("CoreVideo"),
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("Security"),
                .linkedFramework("UniformTypeIdentifiers"),
                .linkedFramework("Vision"),
            ]
        ),
        .executableTarget(
            name: "BimaxCuService",
            // BimaxFocusBridge supplies ForegroundActivationHelper, which `--request-front-process`
            // invokes directly. It was reachable before only because the module's sources sat in
            // the kit; with them restored to their own target the dependency has to be declared.
            dependencies: ["BimaxCuProtocol", "BimaxComputerUseKit", "BimaxFocusBridge"]
        ),
        .executableTarget(
            name: "BimaxCuBridge",
            dependencies: ["BimaxCuProtocol", "BimaxComputerUseKit"]
        ),
        .executableTarget(
            name: "BimaxCuTests",
            dependencies: ["BimaxCuProtocol", "BimaxComputerUseKit"]
        ),
        .executableTarget(
            name: "BimaxCuFixture",
            linkerSettings: [.linkedFramework("AppKit")]
        ),
    ]
)
