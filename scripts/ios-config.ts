export function clerkFrontendAPIHost(publishableKey: string) {
  const match = publishableKey.trim().match(/^pk_(?:test|live)_(.+)$/);
  if (!match) return '';
  try {
    const decoded = Buffer.from(match[1], 'base64url').toString('utf8').replace(/\$$/, '').trim();
    const url = new URL(decoded.includes('://') ? decoded : `https://${decoded}`);
    return url.hostname;
  } catch {
    return '';
  }
}

export function clerkFrontendAPIHostFromValues({
  explicitHost = '',
  proxyURL = '',
  publishableKey = '',
}: {
  explicitHost?: string;
  proxyURL?: string;
  publishableKey?: string;
}) {
  if (explicitHost.trim()) return explicitHost.trim();
  if (proxyURL.trim()) {
    try {
      return new URL(proxyURL.trim()).hostname;
    } catch {}
  }
  return clerkFrontendAPIHost(publishableKey);
}

export function parseEnv(source: string) {
  const values = new Map<string, string>();
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values.set(match[1], value.replace(/\\n/g, '\n'));
  }
  return values;
}

export function iosApplicationIdentifier(projectSource: string) {
  const teamID = projectSource.match(/^\s*DEVELOPMENT_TEAM:\s*([A-Z0-9]+)\s*$/m)?.[1] || '';
  const bundleID = projectSource.match(/^\s*PRODUCT_BUNDLE_IDENTIFIER:\s*([A-Za-z0-9.-]+)\s*$/m)?.[1] || '';
  return teamID && bundleID ? `${teamID}.${bundleID}` : '';
}

export function aasaIncludesApplication(source: string, applicationIdentifier: string) {
  try {
    const document = JSON.parse(source) as {
      webcredentials?: { apps?: unknown };
    };
    return (
      Array.isArray(document.webcredentials?.apps) &&
      document.webcredentials.apps.includes(applicationIdentifier)
    );
  } catch {
    return false;
  }
}

export function xcconfigValue(value: string) {
  return value.replaceAll('://', ':/$()/').replaceAll('\n', '');
}
