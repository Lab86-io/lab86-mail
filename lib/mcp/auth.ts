import { Buffer } from 'node:buffer';

export type McpAuthMode = 'bearer' | 'basic-or-bearer';

function compactCredential(value: string): string {
  return value.replace(/\s+/g, '');
}

function bearerCredential(raw: string): string {
  let token = String(raw ?? '').trim();
  token = token.replace(/^(?:Bearer|token)\s+/i, '').trim();
  token = compactCredential(token);
  if (!token) {
    throw new Error('MCP connection failed: the access token is empty after sanitizing.');
  }
  return token;
}

export function buildAuthorizationHeader(raw: string, mode: McpAuthMode = 'bearer'): string {
  const token = String(raw ?? '').trim();
  if (!token) {
    throw new Error('MCP connection failed: the access token is empty after sanitizing.');
  }

  const explicitBasic = /^Basic\s+(.+)$/i.exec(token);
  if (mode === 'basic-or-bearer' && explicitBasic)
    return `Basic ${compactCredential(explicitBasic[1] || '')}`;

  if (mode === 'basic-or-bearer' && token.includes(':') && !/^Bearer\s+/i.test(token)) {
    return `Basic ${Buffer.from(token, 'utf8').toString('base64')}`;
  }

  return `Bearer ${bearerCredential(token)}`;
}
