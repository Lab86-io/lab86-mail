// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "MobileAPI",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
    ],
    products: [
        .library(name: "MobileAPI", targets: ["MobileAPI"]),
    ],
    dependencies: [
        .package(
            url: "https://github.com/apple/swift-openapi-generator",
            exact: "1.13.0"
        ),
        .package(
            url: "https://github.com/apple/swift-openapi-runtime",
            exact: "1.12.0"
        ),
        .package(
            url: "https://github.com/apple/swift-openapi-urlsession",
            exact: "1.3.1"
        ),
        .package(
            url: "https://github.com/apple/swift-http-types",
            exact: "1.6.0"
        ),
    ],
    targets: [
        .target(
            name: "MobileAPI",
            dependencies: [
                .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
                .product(name: "OpenAPIURLSession", package: "swift-openapi-urlsession"),
                .product(name: "HTTPTypes", package: "swift-http-types"),
            ],
            plugins: [
                .plugin(name: "OpenAPIGenerator", package: "swift-openapi-generator"),
            ]
        ),
        .testTarget(
            name: "MobileAPITests",
            dependencies: [
                "MobileAPI",
                .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
                .product(name: "HTTPTypes", package: "swift-http-types"),
            ],
            resources: [.process("Fixtures")]
        ),
    ]
)
