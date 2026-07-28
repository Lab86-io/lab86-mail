import { hostedPublicUrl } from '@/lib/hosted/env';

export const CLOUD_FILE_PROVIDERS = ['google_drive', 'onedrive'] as const;

export type CloudFileProvider = (typeof CLOUD_FILE_PROVIDERS)[number];

export interface CloudFileProviderDefinition {
  id: CloudFileProvider;
  label: string;
  authorizationUrl: string;
  tokenUrl: string;
  scopes: string[];
}

export interface CloudFileItem {
  id: string;
  name: string;
  provider: CloudFileProvider | 'albatross' | 'icloud';
  connectionId?: string;
  mimeType?: string;
  size?: number;
  modifiedAt?: number;
  webUrl?: string;
  thumbnailUrl?: string;
  owner?: string;
  isFolder: boolean;
}

export interface CloudFilePage {
  items: CloudFileItem[];
  nextCursor?: string;
}

export const CLOUD_FILE_PROVIDER_DEFINITIONS: Record<CloudFileProvider, CloudFileProviderDefinition> = {
  google_drive: {
    id: 'google_drive',
    label: 'Google Drive',
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: [
      'openid',
      'email',
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/documents',
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/presentations',
    ],
  },
  onedrive: {
    id: 'onedrive',
    label: 'OneDrive',
    authorizationUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: ['openid', 'email', 'offline_access', 'User.Read', 'Files.ReadWrite'],
  },
};

export function isCloudFileProvider(value: unknown): value is CloudFileProvider {
  return typeof value === 'string' && (CLOUD_FILE_PROVIDERS as readonly string[]).includes(value);
}

export function cloudFileProviderDefinition(provider: string): CloudFileProviderDefinition | null {
  return isCloudFileProvider(provider) ? CLOUD_FILE_PROVIDER_DEFINITIONS[provider] : null;
}

export function cloudFileOAuthRedirectUri() {
  return process.env.CLOUD_FILES_REDIRECT_URI || `${hostedPublicUrl()}/api/files/oauth/callback`;
}

export function cloudFileProviderCredentials(provider: CloudFileProvider): {
  clientId: string;
  clientSecret: string;
} | null {
  const clientId =
    provider === 'google_drive' ? process.env.GOOGLE_DRIVE_CLIENT_ID : process.env.MICROSOFT_DRIVE_CLIENT_ID;
  const clientSecret =
    provider === 'google_drive'
      ? process.env.GOOGLE_DRIVE_CLIENT_SECRET
      : process.env.MICROSOFT_DRIVE_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export function cloudFileProviderIsConfigured(provider: CloudFileProvider) {
  return cloudFileProviderCredentials(provider) !== null;
}

export function buildCloudFileAuthorizationUrl(input: {
  provider: CloudFileProvider;
  state: string;
  clientId: string;
  codeChallenge?: string;
  redirectUri?: string;
}) {
  const definition = CLOUD_FILE_PROVIDER_DEFINITIONS[input.provider];
  const url = new URL(definition.authorizationUrl);
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri || cloudFileOAuthRedirectUri());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', input.state);
  url.searchParams.set('scope', definition.scopes.join(' '));
  if (input.codeChallenge) {
    url.searchParams.set('code_challenge', input.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  if (input.provider === 'google_drive') {
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
  } else {
    url.searchParams.set('response_mode', 'query');
  }
  return url.toString();
}

function timestamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function normalizeGoogleDrivePage(payload: any, connectionId: string): CloudFilePage {
  const items = Array.isArray(payload?.files) ? payload.files : [];
  return {
    items: items
      .filter((item: any) => item && typeof item.id === 'string' && item.name)
      .map((item: any) => ({
        id: item.id,
        name: String(item.name),
        provider: 'google_drive' as const,
        connectionId,
        mimeType: typeof item.mimeType === 'string' ? item.mimeType : undefined,
        size:
          typeof item.size === 'string' && Number.isFinite(Number(item.size)) ? Number(item.size) : undefined,
        modifiedAt: timestamp(item.modifiedTime),
        webUrl: typeof item.webViewLink === 'string' ? item.webViewLink : undefined,
        thumbnailUrl: typeof item.thumbnailLink === 'string' ? item.thumbnailLink : undefined,
        owner: typeof item.owners?.[0]?.displayName === 'string' ? item.owners[0].displayName : undefined,
        isFolder: item.mimeType === 'application/vnd.google-apps.folder',
      })),
    nextCursor: typeof payload?.nextPageToken === 'string' ? payload.nextPageToken : undefined,
  };
}

export function normalizeOneDrivePage(payload: any, connectionId: string): CloudFilePage {
  const items = Array.isArray(payload?.value) ? payload.value : [];
  return {
    items: items
      .filter((item: any) => item && typeof item.id === 'string' && item.name)
      .map((item: any) => ({
        id: item.id,
        name: String(item.name),
        provider: 'onedrive' as const,
        connectionId,
        mimeType:
          typeof item.file?.mimeType === 'string'
            ? item.file.mimeType
            : item.folder
              ? 'application/vnd.microsoft.folder'
              : undefined,
        size: typeof item.size === 'number' && Number.isFinite(item.size) ? item.size : undefined,
        modifiedAt: timestamp(item.lastModifiedDateTime),
        webUrl: typeof item.webUrl === 'string' ? item.webUrl : undefined,
        thumbnailUrl:
          typeof item.thumbnails?.[0]?.medium?.url === 'string' ? item.thumbnails[0].medium.url : undefined,
        owner:
          typeof item.createdBy?.user?.displayName === 'string' ? item.createdBy.user.displayName : undefined,
        isFolder: Boolean(item.folder),
      })),
    nextCursor: typeof payload?.['@odata.nextLink'] === 'string' ? payload['@odata.nextLink'] : undefined,
  };
}

export function escapeGoogleDriveQuery(value: string) {
  return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}
