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
      revision: 'ead56133a693d0184d8c2db1a6d6394410cacfd6',
      version: '2.13.6',
    });
    expect(pins.get('swiftstreamingmarkdown')).toEqual({
      revision: 'a4187829013c4588556d82dbf1ab65ed768a0262',
    });
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
