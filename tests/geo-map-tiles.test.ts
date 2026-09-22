import { expect, test } from 'bun:test';
import { geoMapTileSource } from '../components/tool-ui/geo-map/tile-source';

test('the browser map uses the public OSM tile contract without a credential and retains attribution', () => {
  const request = new URL(geoMapTileSource.url.replace('{z}', '6').replace('{x}', '18').replace('{y}', '23'));
  expect(request.origin).toBe('https://tile.openstreetmap.org');
  expect(request.pathname).toBe('/6/18/23.png');
  expect(request.search).toBe('');
  expect(geoMapTileSource.attribution).toContain('https://www.openstreetmap.org/copyright');
  expect(geoMapTileSource.attribution).toContain('contributors');
  expect(geoMapTileSource.attribution).not.toContain('CARTO');
});

test('close views reuse native tiles rather than requesting unsupported OSM zoom levels', () => {
  expect(geoMapTileSource.maxNativeZoom).toBe(19);
  expect(geoMapTileSource.maxZoom).toBe(22);
  expect(geoMapTileSource.maxZoom).toBeGreaterThan(geoMapTileSource.maxNativeZoom);
});
