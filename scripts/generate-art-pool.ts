/**
 * Regenerates lib/mail/daily-art-pool.ts from keyless, public-domain
 * open-access museum APIs:
 *   - The Metropolitan Museum of Art (collectionapi.metmuseum.org)
 *   - Cleveland Museum of Art (openaccess-api.clevelandart.org, CC0)
 *   - Statens Museum for Kunst, Copenhagen (api.smk.dk, public domain)
 *   - National Gallery of Art, Washington (official open-data export, CC0)
 *
 * Each entry carries a fully-resolved, directly-loadable image URL, its
 * source, the year and origin the museum recorded (the masthead reads a
 * period style from them), and a palette read from the image itself with an
 * accent for the title text. The Art Institute of Chicago blocks hotlinked
 * images in the brief, so it is not fetched.
 *
 *   bun run scripts/generate-art-pool.ts
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { hex, paletteFromPixels, pickAccent } from '../lib/mail/art-palette';
import { artStyleFor } from '../lib/mail/art-style';
import type { ArtPiece } from '../lib/mail/art-types';
import { csvRecords } from './art-pool-csv';

const PER_QUERY = 12;
const MAX_PER_SOURCE = 120;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const cacheDir = join(tmpdir(), 'albatross-art-cache');
mkdirSync(cacheDir, { recursive: true });
async function cachedFetch(url: string): Promise<Response> {
  const path = join(cacheDir, createHash('sha256').update(url).digest('hex'));
  if (!process.env.ART_POOL_REFRESH && existsSync(path)) return new Response(readFileSync(path));
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) return res;
  const data = Buffer.from(await res.arrayBuffer());
  writeFileSync(path, data);
  return new Response(data);
}

function clean(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

const SCENE_QUERIES = [
  'abstract',
  'still life',
  'flowers',
  'interior',
  'portrait',
  'landscape',
  'seascape',
  'harbor',
  'river',
  'mountains',
  'garden',
  'sunset',
  'winter',
  'forest',
  'coast',
  'city',
  'valley',
];

async function fetchMet(): Promise<ArtPiece[]> {
  const out: ArtPiece[] = [];
  const seen = new Set<number>();
  const searches: Array<{ q: string; extra: string }> = [
    ...SCENE_QUERIES.map((q) => ({ q, extra: '&medium=Paintings' })),
    { q: 'landscape', extra: '&departmentId=6' },
    { q: 'river', extra: '&departmentId=6' },
  ];
  for (const search of searches) {
    if (out.length >= MAX_PER_SOURCE) break;
    console.error(`query: ${out.length} collected`);
    const searchUrl =
      'https://collectionapi.metmuseum.org/public/collection/v1/search' +
      `?hasImages=true&isPublicDomain=true${search.extra}&q=${encodeURIComponent(search.q)}`;
    const searchRes = await cachedFetch(searchUrl);
    if (!searchRes.ok) continue;
    const ids: number[] = ((await searchRes.json()) as any).objectIDs ?? [];
    let taken = 0;
    for (const id of ids.slice(0, 48)) {
      if (taken >= PER_QUERY || out.length >= MAX_PER_SOURCE) break;
      if (seen.has(id)) continue;
      seen.add(id);
      try {
        const res = await cachedFetch(
          `https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`,
        );
        // The Met throttles aggressive bursts (Incapsula) with 403/429; back off
        // and skip rather than JSON-parsing an error page into a crash.
        if (!res.ok) {
          await delay(500);
          continue;
        }
        const obj: any = await res.json();
        const image = obj.primaryImage || obj.primaryImageSmall;
        if (!obj.isPublicDomain || !image) continue;
        if (!/painting|scroll|screen|print|drawing/i.test(String(obj.classification || ''))) continue;
        const overall = (obj.measurements || []).find((m: any) => m.elementName === 'Overall');
        const width = overall?.elementMeasurements?.Width;
        const height = overall?.elementMeasurements?.Height;
        if (typeof width === 'number' && typeof height === 'number' && width < height * 0.85) continue;
        const piece = await withPalette({
          source: 'met',
          sourceName: 'The Met',
          title: clean(obj.title) || 'Untitled',
          artist: clean(obj.artistDisplayName),
          date: clean(obj.objectDate),
          year: typeof obj.objectBeginDate === 'number' ? obj.objectBeginDate : null,
          region: clean([obj.artistNationality, obj.culture, obj.department].filter(Boolean).join(', ')),
          medium: clean(obj.medium),
          movement: clean(obj.period),
          sourceUrl: obj.objectURL,
          license: 'Public domain',
          imageUrl: image,
          paletteSource: obj.primaryImageSmall || image,
        });
        if (piece) {
          out.push(piece);
          taken += 1;
        }
        await delay(80);
      } catch {
        // skip transient object fetch failures
      }
    }
  }
  return out;
}

async function fetchCleveland(): Promise<ArtPiece[]> {
  const out: ArtPiece[] = [];
  const seen = new Set<string>();
  let archive: any[] | null = null;
  for (const q of SCENE_QUERIES) {
    if (out.length >= MAX_PER_SOURCE) break;
    console.error(`query: ${out.length} collected`);
    const url =
      'https://openaccess-api.clevelandart.org/api/artworks/?cc0=1&has_image=1' +
      `&type=Painting&q=${encodeURIComponent(q)}` +
      '&fields=title,creators,creation_date_earliest,creation_date,images,culture,technique,department,style,url' +
      `&limit=${PER_QUERY * 2}`;
    const response = archive ? null : await cachedFetch(url);
    if (response && !response.ok && !archive) {
      const mirror = await cachedFetch(
        'https://media.githubusercontent.com/media/ClevelandMuseumArt/openaccess/master/data.json',
      );
      if (!mirror.ok) throw new Error(`Cleveland archive: ${mirror.status}`);
      archive = (await mirror.json()) as any[];
    }
    const json: any = response?.ok
      ? await response.json()
      : {
          data: archive
            ?.filter(
              (row) =>
                row.share_license_status === 'CC0' &&
                /Painting|Print|Drawing/i.test(row.type) &&
                JSON.stringify([row.title, row.style, row.technique]).toLowerCase().includes(q.toLowerCase()),
            )
            .slice(0, 80),
        };
    let taken = 0;
    for (const row of json.data ?? []) {
      if (taken >= PER_QUERY || out.length >= MAX_PER_SOURCE) break;
      const web = row?.images?.web;
      const webUrl = web?.url;
      if (!webUrl || seen.has(webUrl)) continue;
      const width = Number(web.width);
      const height = Number(web.height);
      if (width && height && width < height * 0.85) continue;
      seen.add(webUrl);
      const piece = await withPalette({
        source: 'cleveland',
        sourceName: 'Cleveland Museum of Art',
        title: clean(row.title) || 'Untitled',
        artist: clean(row.creators?.[0]?.description?.split('(')[0] ?? row.creators?.[0]?.description),
        date: clean(row.creation_date),
        year: typeof row.creation_date_earliest === 'number' ? row.creation_date_earliest : null,
        region: clean([...(row.culture ?? []), row.department].filter(Boolean).join(', ')),
        medium: clean(row.technique),
        movement: clean(row.style),
        sourceUrl: row.url,
        license: 'CC0',
        imageUrl: webUrl,
        paletteSource: webUrl,
      });
      if (piece) {
        out.push(piece);
        taken += 1;
      }
    }
  }
  return out;
}

async function fetchSmk(): Promise<ArtPiece[]> {
  const out: ArtPiece[] = [];
  const seen = new Set<string>();
  const keys = [
    'Vilhelm Lundstrøm',
    'Harald Giersing',
    'modernisme',
    'opstilling',
    'interiør',
    'portræt',
    'landskab',
    'marine',
    'skov',
    'kyst',
    'udsigt',
    'have',
    'aften',
  ];
  for (const key of keys) {
    if (out.length >= MAX_PER_SOURCE) break;
    console.error(`query: ${out.length} collected`);
    const url =
      `https://api.smk.dk/api/v1/art/search?keys=${encodeURIComponent(key)}` +
      '&filters=%5Bpublic_domain%3Atrue%5D%2C%5Bhas_image%3Atrue%5D%2C%5Bobject_names%3Amaleri%5D' +
      `&offset=0&rows=${PER_QUERY * 2}`;
    const response = await cachedFetch(url);
    if (!response.ok) continue;
    const json: any = await response.json();
    let taken = 0;
    for (const row of json.items ?? []) {
      if (taken >= PER_QUERY || out.length >= MAX_PER_SOURCE) break;
      const image = row.image_iiif_id
        ? `${row.image_iiif_id}/full/!1600,1000/0/default.jpg`
        : row.image_thumbnail;
      if (!image || seen.has(image)) continue;
      if (row.image_width && row.image_height && row.image_width < row.image_height * 0.85) continue;
      seen.add(image);
      const production = row.production?.[0] ?? {};
      const title = row.titles?.find((t: any) => t.language === 'engelsk')?.title || row.titles?.[0]?.title;
      const start = row.production_date?.[0]?.start;
      const piece = await withPalette({
        source: 'smk',
        sourceName: 'SMK, Copenhagen',
        title: clean(title) || 'Untitled',
        artist: clean(
          production.creator_forename && production.creator_surname
            ? `${production.creator_forename} ${production.creator_surname}`
            : production.creator,
        ),
        date: clean(row.production_date?.[0]?.period),
        year: start ? Number(String(start).slice(0, 4)) : null,
        region: clean(production.creator_nationality),
        medium: clean(row.techniques?.join(', ')),
        movement: '',
        sourceUrl: `https://open.smk.dk/en/artwork/image/${row.object_number}`,
        license: 'Public domain',
        imageUrl: image,
        paletteSource: row.image_thumbnail || image,
      });
      if (piece) {
        out.push(piece);
        taken += 1;
      }
    }
  }
  return out;
}

async function fetchNga(): Promise<ArtPiece[]> {
  const base = 'https://raw.githubusercontent.com/NationalGalleryOfArt/opendata/main/data/';
  const [objects, images] = await Promise.all(
    ['objects.csv', 'published_images.csv'].map(async (name) => {
      const response = await cachedFetch(base + name);
      if (!response.ok) throw new Error(`NGA ${name}: ${response.status}`);
      return csvRecords(await response.text());
    }),
  );
  const pictures = new Map(
    images
      .filter(
        (row) =>
          row.openaccess === '1' &&
          row.viewtype === 'primary' &&
          Number(row.width) >= Number(row.height) * 0.85,
      )
      .map((row) => [row.depictstmsobjectid, row]),
  );
  const out: ArtPiece[] = [];
  const seen = new Set<string>();
  // Spread periods and subjects before filling from popular landscape results.
  const queries = [
    /saint|madonna|virgin/i,
    /still life|flowers/i,
    /composition|abstract/i,
    /interior|room/i,
    /portrait/i,
    /landscape/i,
    /sea|coast|harbor/i,
    /river|lake/i,
    /garden|forest/i,
    /city|street|venice/i,
  ];
  const candidates = objects.filter(
    (row) => /Painting|Print|Drawing/i.test(row.classification) && pictures.has(row.objectid),
  );
  for (const query of queries) {
    let taken = 0;
    for (const row of candidates
      .filter(
        (row) =>
          query.test(row.title) && (query.source !== 'saint|madonna|virgin' || Number(row.beginyear) < 1450),
      )
      .sort((a, b) => Number(b.beginyear) - Number(a.beginyear))
      .slice(0, 40)) {
      if (taken >= 12 || seen.has(row.objectid)) continue;
      seen.add(row.objectid);
      const picture = pictures.get(row.objectid)!;
      const piece = await withPalette({
        source: 'nga',
        sourceName: 'National Gallery of Art',
        sourceUrl: `https://www.nga.gov/artworks/${row.objectid}`,
        license: 'CC0',
        title: clean(row.title),
        artist: clean(row.attribution),
        date: clean(row.displaydate),
        year: row.beginyear ? Number(row.beginyear) : null,
        region: '',
        medium: clean(row.medium),
        movement: '',
        imageUrl: `${picture.iiifurl}/full/!1600,1000/0/default.jpg`,
        paletteSource: picture.iiifthumburl,
      });
      if (piece) {
        out.push(piece);
        taken += 1;
      }
    }
    console.error(`NGA: ${out.length}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

async function withPalette(
  piece: Omit<ArtPiece, 'palette' | 'accentHue' | 'accentChroma' | 'style'> & { paletteSource: string },
): Promise<ArtPiece | null> {
  const { paletteSource, ...rest } = piece;
  try {
    const res = await cachedFetch(paletteSource);
    if (!res.ok) return null;
    const input = Buffer.from(await res.arrayBuffer());
    const { data, info } = await sharp(input)
      .resize(96, 96, { fit: 'inside' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const pixels: Array<[number, number, number]> = [];
    for (let i = 0; i < data.length; i += info.channels) pixels.push([data[i], data[i + 1], data[i + 2]]);
    const palette = paletteFromPixels(pixels, 6);
    const accent = pickAccent(palette);
    return {
      ...rest,
      style: artStyleFor(rest),
      palette: palette.map((c) => hex(c.rgb)),
      accentHue: Math.round(accent.hue),
      accentChroma: Number(accent.chroma.toFixed(3)),
    };
  } catch (error) {
    console.error(`palette failed for ${piece.imageUrl}`, error);
    return null;
  }
}

// ---------------------------------------------------------------------------

// Interleave sources so the deterministic daily pick naturally rotates museums.
function interleave(groups: ArtPiece[][]): ArtPiece[] {
  const out: ArtPiece[] = [];
  const max = Math.max(...groups.map((g) => g.length));
  for (let i = 0; i < max; i += 1) {
    for (const g of groups) if (g[i]) out.push(g[i]);
  }
  return out;
}

function onFailure(source: string): (e: unknown) => ArtPiece[] {
  return (e) => {
    console.error(`${source} failed`, e);
    return [];
  };
}

async function main() {
  const [met, cleveland, smk, nga] = await Promise.all([
    fetchMet().catch(onFailure('met')),
    fetchCleveland().catch(onFailure('cleveland')),
    fetchSmk().catch(onFailure('smk')),
    fetchNga().catch(onFailure('nga')),
  ]);
  console.error(
    `fetched met=${met.length} cleveland=${cleveland.length} smk=${smk.length} nga=${nga.length}`,
  );
  const pool = interleave([met, cleveland, smk, nga]);
  if (pool.length < 300 || [met, cleveland, smk, nga].some((group) => group.length < 10))
    throw new Error(`Incomplete museum refresh (${pool.length}); preserving the checked-in catalog`);
  if (new Set(pool.map((piece) => piece.imageUrl)).size !== pool.length)
    throw new Error('Duplicate artwork URLs');

  const localPalettes: string[][] = [];
  for (let index = 1; index <= 3; index += 1) {
    const { data, info } = await sharp(`public/art/fallback-${index}.jpg`)
      .resize(96, 96, { fit: 'inside' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const pixels: Array<[number, number, number]> = [];
    for (let i = 0; i < data.length; i += info.channels) pixels.push([data[i], data[i + 1], data[i + 2]]);
    localPalettes.push(paletteFromPixels(pixels, 6).map((swatch) => hex(swatch.rgb)));
  }
  writeFileSync(
    'lib/mail/local-art-palettes.ts',
    `// Sampled from bundled fallback artwork by scripts/generate-art-pool.ts.\nexport const LOCAL_ART_PALETTES: readonly string[][] = ${JSON.stringify(localPalettes, null, 2)};\n`,
  );
  const header = `// Generated from public-domain museum collections. See docs/research/art-frames-2026-09-11.md.
// Regenerate: bun scripts/generate-art-pool.ts
import type { ArtPiece } from './art-types';
export type { ArtPiece, ArtSource } from './art-types';
export const ART_POOL: ArtPiece[] = ${JSON.stringify(pool, null, 2)};
`;
  writeFileSync('lib/mail/daily-art-pool.ts', header);
  console.error(`wrote lib/mail/daily-art-pool.ts with ${pool.length} pieces`);
}

main();
