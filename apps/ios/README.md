# Albatross for iOS

The native client targets iOS 27 and is generated with XcodeGen so the Xcode project remains reproducible.

`MobileContractV1` is generated at build time by Apple's Swift OpenAPI Generator
from `Packages/MobileAPI/Sources/MobileAPI/openapi.yaml`. Refresh the checked-in
artifact from the Zod source before native builds with `bun run mobile:openapi`.

## Configure

1. Copy `Config/Local.xcconfig.example` to `Config/Local.xcconfig`.
2. Set the Lab86 API URL, Clerk publishable key, Convex deployment URL, and Clerk frontend API host.
3. Enable Clerk's Native API and register bundle identifier `io.lab86.mail` in Clerk.
4. Generate the project with XcodeGen 2.45.4 or newer:

   ```sh
   xcodegen generate --spec project.yml
   ```

5. Open `Lab86Mail.xcodeproj` in Xcode 27.

From the repository root, `bun run ios:configure` generates the ignored local
xcconfig from `.env.local` without printing credentials.

The default-mail managed entitlement is deliberately not included until Apple grants it. The app already handles `mailto:` and implements the functional mail replacement surface needed before that request.
