import { describe, expect, test } from 'bun:test';
import { GET } from '../app/api/mobile/v1/openapi/route';

describe('mobile OpenAPI route', () => {
  test('returns the generated immutable public contract', async () => {
    const response = GET();
    const document = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600, immutable');
    expect(document.openapi).toBe('3.1.0');
    expect(document.paths['/api/mobile/v1/commands'].post.operationId).toBe('postMobileCommand');
  });
});
