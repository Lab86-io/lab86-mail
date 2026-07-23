import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  aasaIncludesApplication,
  clerkFrontendAPIHost,
  clerkFrontendAPIHostFromValues,
  iosApplicationIdentifier,
  parseEnv,
  xcconfigValue,
} from '../scripts/ios-config';

describe('native iOS authentication configuration', () => {
  test('derives Clerk associated-domain host from a publishable key', () => {
    const encoded = Buffer.from('native-example.clerk.accounts.dev$').toString('base64url');
    expect(clerkFrontendAPIHost(`pk_test_${encoded}`)).toBe('native-example.clerk.accounts.dev');
    expect(clerkFrontendAPIHost('not-a-publishable-key')).toBe('');
  });

  test('uses explicit and proxy Clerk hosts before the publishable-key host', () => {
    const encoded = Buffer.from('key-host.clerk.accounts.dev$').toString('base64url');
    expect(
      clerkFrontendAPIHostFromValues({
        explicitHost: 'explicit.clerk.accounts.dev',
        proxyURL: 'https://proxy.example.com/__clerk',
        publishableKey: `pk_test_${encoded}`,
      }),
    ).toBe('explicit.clerk.accounts.dev');
    expect(
      clerkFrontendAPIHostFromValues({
        proxyURL: 'https://proxy.example.com/__clerk',
        publishableKey: `pk_test_${encoded}`,
      }),
    ).toBe('proxy.example.com');
  });

  test('parses quoted local environment values without evaluating them', () => {
    const env = parseEnv('export FIRST="one"\nSECOND=two\\nlines\n# ignored');
    expect(env.get('FIRST')).toBe('one');
    expect(env.get('SECOND')).toBe('two\nlines');
  });

  test('matches the signed iOS application against Clerk web credentials', () => {
    const project = readFileSync(path.join(process.cwd(), 'apps/ios/project.yml'), 'utf8');
    const applicationIdentifier = iosApplicationIdentifier(project);
    expect(applicationIdentifier).toBe('5JZV7V6Y4Z.io.lab86.mail');
    expect(
      aasaIncludesApplication(
        JSON.stringify({ webcredentials: { apps: [applicationIdentifier] } }),
        applicationIdentifier,
      ),
    ).toBe(true);
    expect(aasaIncludesApplication('{}', applicationIdentifier)).toBe(false);
    expect(aasaIncludesApplication('not-json', applicationIdentifier)).toBe(false);
  });

  test('escapes URLs for xcconfig without changing their runtime value', () => {
    expect(xcconfigValue('https://mail.lab86.io')).toBe('https:/$()/mail.lab86.io');
  });

  test('registers Clerk default native callback scheme in the app bundle', () => {
    const info = readFileSync(path.join(process.cwd(), 'apps/ios/Lab86Mail/Resources/Info.plist'), 'utf8');
    expect(info).toContain('<string>io.lab86.mail</string>');
  });

  test('isolates signed bundle substitutions from Xcode Cloud input variables', () => {
    const info = readFileSync(path.join(process.cwd(), 'apps/ios/Lab86Mail/Resources/Info.plist'), 'utf8');
    const entitlements = readFileSync(
      path.join(process.cwd(), 'apps/ios/Lab86Mail/Resources/Lab86Mail.entitlements'),
      'utf8',
    );
    const baseConfig = readFileSync(path.join(process.cwd(), 'apps/ios/Config/Base.xcconfig'), 'utf8');
    const postClone = readFileSync(path.join(process.cwd(), 'apps/ios/ci_scripts/ci_post_clone.sh'), 'utf8');
    const project = readFileSync(path.join(process.cwd(), 'apps/ios/project.yml'), 'utf8');
    const builtVerifier = readFileSync(
      path.join(process.cwd(), 'apps/ios/ci_scripts/verify_built_configuration.sh'),
      'utf8',
    );
    const exportVerifier = readFileSync(
      path.join(process.cwd(), '.github/scripts/verify-ios-export.sh'),
      'utf8',
    );
    const cloudWaiter = readFileSync(
      path.join(process.cwd(), '.github/scripts/wait-for-xcode-cloud.mjs'),
      'utf8',
    );

    expect(info).toContain('<string>$(LAB86_INFO_API_BASE_URL)</string>');
    expect(info).toContain('<string>$(LAB86_INFO_CLERK_PUBLISHABLE_KEY)</string>');
    expect(info).toContain('<string>$(LAB86_INFO_CONVEX_DEPLOYMENT_URL)</string>');
    expect(info).not.toContain('<string>$(LAB86_API_BASE_URL)</string>');
    expect(entitlements).toContain('webcredentials:$(LAB86_INFO_CLERK_FRONTEND_API_HOST)');
    expect(baseConfig).toContain('LAB86_INFO_API_BASE_URL = https:/$()/mail.lab86.io');
    expect(postClone).toContain('api_input="https://mail-staging.lab86.io"');
    expect(postClone).toContain('LAB86_INFO_API_BASE_URL = $' + '{api_base_url}');
    expect(project).toContain('Verify embedded release configuration');
    expect(project).toContain('basedOnDependencyAnalysis: false');
    expect(project).toContain('$(SRCROOT)/ci_scripts/verify_built_configuration.sh');
    expect(project).toContain('$(TARGET_BUILD_DIR)/$(INFOPLIST_PATH)');
    expect(builtVerifier).toContain('[[ "$api_base_url" == "https://mail-staging.lab86.io" ]]');
    expect(builtVerifier).toContain('[[ "$api_base_url" == "https://mail.lab86.io" ]]');
    expect(exportVerifier).toContain('codesign -d --entitlements :- "$app_path"');
    expect(cloudWaiter).toContain(
      'Xcode Cloud distributed to TestFlight without a reviewable App Store export.',
    );
  });

  test('supports every iPad orientation required for adaptive multitasking', () => {
    const info = readFileSync(path.join(process.cwd(), 'apps/ios/Lab86Mail/Resources/Info.plist'), 'utf8');
    expect(info).toContain('<key>UISupportedInterfaceOrientations~ipad</key>');
    expect(info).toContain('<string>UIInterfaceOrientationPortraitUpsideDown</string>');
  });

  test('silently cancels the broken development passkey preflight without blocking other sign-ins', () => {
    const configuration = readFileSync(
      path.join(process.cwd(), 'apps/ios/Lab86Mail/Core/Authentication/ClerkConfiguration.swift'),
      'utf8',
    );
    const app = readFileSync(path.join(process.cwd(), 'apps/ios/Lab86Mail/App/Lab86MailApp.swift'), 'utf8');
    const settings = readFileSync(
      path.join(process.cwd(), 'apps/ios/Lab86Mail/Features/Settings/SettingsView.swift'),
      'utf8',
    );

    expect(configuration).toContain('publishableKey.hasPrefix("pk_test_")');
    expect(configuration).toContain('request.url?.path.hasSuffix("/v1/client/sign_ins")');
    expect(configuration).toContain('formValue(named: "strategy", in: form) == "passkey"');
    expect(configuration).toContain('throw CancellationError()');
    expect(app).toContain('options: ClerkConfiguration.options(for: key)');
    expect(settings).toContain('options: ClerkConfiguration.options(for: publishableKey)');
  });

  test('uses the provisioning profile team instead of the certificate person identifier', () => {
    const project = readFileSync(path.join(process.cwd(), 'apps/ios/project.yml'), 'utf8');
    expect(project).toContain('DEVELOPMENT_TEAM: 5JZV7V6Y4Z');
    expect(project).not.toContain('DEVELOPMENT_TEAM: Y52NVQBRL7');
  });

  test('keeps Xcode Cloud package resolution aligned with reproducible root requirements', () => {
    const resolved = JSON.parse(
      readFileSync(
        path.join(
          process.cwd(),
          'apps/ios/Lab86Mail.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved',
        ),
        'utf8',
      ),
    );
    const pins = new Map(
      resolved.pins.map((pin: { identity: string; state: Record<string, string> }) => [
        pin.identity,
        pin.state,
      ]),
    );

    expect(pins.get('swiftsoup')).toEqual({
      revision: '8d6ad267714cac3ae747cefdd21f7a6665006e1f',
    });
    expect(pins.get('swiftstreamingmarkdown')).toEqual({
      revision: 'a4187829013c4588556d82dbf1ab65ed768a0262',
    });
  });

  test('pins the upstream SwiftSoup workaround without weakening Release optimization', () => {
    const project = readFileSync(path.join(process.cwd(), 'apps/ios/project.yml'), 'utf8');

    expect(project).toContain('revision: 8d6ad267714cac3ae747cefdd21f7a6665006e1f');
    expect(project).not.toContain('SWIFT_OPTIMIZATION_LEVEL: -Onone');
  });

  test('keeps the toolbar within the SwiftUI API surface available in Xcode Cloud', () => {
    const shell = readFileSync(
      path.join(process.cwd(), 'apps/ios/Lab86Mail/Features/Shell/AppShellView.swift'),
      'utf8',
    );

    expect(shell).toContain('ToolbarOverflowMenu');
    expect(shell).toContain('.visibilityPriority(.high)');
    expect(shell).toContain('.topBarPinnedTrailing');
    expect(shell).not.toContain('toolbarMinimizeBehavior');
  });

  test('keeps Spotlight mail private, routable, and removable at sign-out', () => {
    const indexer = readFileSync(
      path.join(process.cwd(), 'apps/ios/Lab86Mail/Core/Spotlight/MailSpotlightIndexer.swift'),
      'utf8',
    );
    const app = readFileSync(path.join(process.cwd(), 'apps/ios/Lab86Mail/App/Lab86MailApp.swift'), 'utf8');
    const store = readFileSync(
      path.join(process.cwd(), 'apps/ios/Lab86Mail/Core/Models/ProductStore.swift'),
      'utf8',
    );

    expect(indexer).toContain('protectionClass: .complete');
    expect(indexer).toContain('MailEntityReference');
    expect(indexer).not.toContain('thread.snippet');
    expect(app).toContain('CSSearchableItemActivityIdentifier');
    expect(store).toContain('await spotlight.remove(owner: cacheOwner)');
  });
});
