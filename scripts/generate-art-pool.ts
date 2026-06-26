/**
 * Regenerates lib/mail/daily-art-pool.ts from three keyless, public-domain
 * open-access museum APIs:
 *   - Art Institute of Chicago (api.artic.edu, IIIF images)
 *   - The Metropolitan Museum of Art (collectionapi.metmuseum.org)
 *   - Cleveland Museum of Art (openaccess-api.clevelandart.org, CC0)
 *
 * Each entry carries a fully-resolved, directly-loadable image URL plus its
 * source, so the daily picker can spread across museums (different CDNs = real
 * redundancy) and fall back across them when one is down.
 *
 *   bun run scripts/generate-art-pool.ts
 */

import { writeFileSync } from 'node:fs';

// Contact in the User-Agent is sourced from env so it can be rotated without a
// code change; falls back to a project alias, never a personal address.
const AIC_CONTACT = process.env.ART_POOL_CONTACT || 'art-pool@lab86.io';
const AIC_UA = `lab86-mail (${AIC_CONTACT})`;
const PER_SOURCE = 36;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface ArtPiece {
  source: 'aic' | 'met' | 'cleveland';
  sourceName: string;
  title: string;
  artist: string;
  date: string;
  imageUrl: string;
}

function clean(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchAic(): Promise<ArtPiece[]> {
  const url =
    'https://api.artic.edu/api/v1/artworks/search?q=landscape' +
    '&query[term][is_public_domain]=true' +
    '&fields=id,title,image_id,artist_title,date_display' +
    `&limit=${PER_SOURCE * 2}`;
  const res = await fetch(url, { headers: { 'AIC-User-Agent': AIC_UA } });
  const json: any = await res.json();
  const out: ArtPiece[] = [];
  for (const row of json.data ?? []) {
    if (!row.image_id) continue;
    out.push({
      source: 'aic',
      sourceName: 'Art Institute of Chicago',
      title: clean(row.title) || 'Untitled',
      artist: clean(row.artist_title),
      date: clean(row.date_display),
      // IIIF: 1686px wide render, ample for a full-bleed masthead.
      imageUrl: `https://www.artic.edu/iiif/2/${row.image_id}/full/1686,/0/default.jpg`,
    });
    if (out.length >= PER_SOURCE) break;
  }
  return out;
}

async function fetchMet(): Promise<ArtPiece[]> {
  const searchUrl =
    'https://collectionapi.metmuseum.org/public/collection/v1/search' + '?hasImages=true&q=landscape';
  const searchRes = await fetch(searchUrl);
  if (!searchRes.ok) return [];
  const ids: number[] = ((await searchRes.json()) as any).objectIDs ?? [];
  const out: ArtPiece[] = [];
  for (const id of ids) {
    if (out.length >= PER_SOURCE) break;
    try {
      const res = await fetch(`https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`);
      // The Met throttles aggressive bursts (Incapsula) with 403/429; back off
      // and skip rather than JSON-parsing an error page into a crash.
      if (!res.ok) {
        await delay(500);
        continue;
      }
      const obj: any = await res.json();
      const image = obj.primaryImage || obj.primaryImageSmall;
      if (!obj.isPublicDomain || !image) continue;
      out.push({
        source: 'met',
        sourceName: 'The Met',
        title: clean(obj.title) || 'Untitled',
        artist: clean(obj.artistDisplayName),
        date: clean(obj.objectDate),
        // Prefer the full-resolution image for the masthead; fall back to the
        // thumbnail only when that's all the object has.
        imageUrl: image,
      });
      // Polite spacing between sequential object fetches.
      await delay(60);
    } catch {
      // skip transient object fetch failures
    }
  }
  return out;
}

async function fetchCleveland(): Promise<ArtPiece[]> {
  const url =
    'https://openaccess-api.clevelandart.org/api/artworks/?cc0&has_image=1' +
    '&type=Painting&q=landscape' +
    '&fields=title,creators,creation_date_earliest,creation_date,images' +
    `&limit=${PER_SOURCE * 2}`;
  const json: any = await (await fetch(url)).json();
  const out: ArtPiece[] = [];
  for (const row of json.data ?? []) {
    const webUrl = row?.images?.web?.url;
    if (!webUrl) continue;
    out.push({
      source: 'cleveland',
      sourceName: 'Cleveland Museum of Art',
      title: clean(row.title) || 'Untitled',
      artist: clean(row.creators?.[0]?.description?.split('(')[0] ?? row.creators?.[0]?.description),
      date: clean(row.creation_date),
      imageUrl: webUrl,
    });
    if (out.length >= PER_SOURCE) break;
  }
  return out;
}

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
  const [aic, met, cleveland] = await Promise.all([
    fetchAic().catch(onFailure('aic')),
    fetchMet().catch(onFailure('met')),
    fetchCleveland().catch(onFailure('cleveland')),
  ]);
  console.error(`fetched aic=${aic.length} met=${met.length} cleveland=${cleveland.length}`);
  const pool = interleave([aic, met, cleveland]);
  if (pool.length < 30) throw new Error(`pool too small (${pool.length}); aborting regeneration`);

  const header = `// Auto-generated by scripts/generate-art-pool.ts from three keyless
// public-domain open-access museum APIs (Art Institute of Chicago, The Met,
// Cleveland Museum of Art). Each entry carries a fully-resolved image URL and
// its source so the daily picker can spread across museums and fall back across
// them. Regenerate with: bun run scripts/generate-art-pool.ts

export type ArtSource = 'aic' | 'met' | 'cleveland';

export interface ArtPiece {
  source: ArtSource;
  sourceName: string;
  title: string;
  artist: string;
  date: string;
  imageUrl: string;
}

export const ART_POOL: ArtPiece[] = ${JSON.stringify(pool, null, 2)};
`;
  writeFileSync('lib/mail/daily-art-pool.ts', header);
  console.error(`wrote lib/mail/daily-art-pool.ts with ${pool.length} pieces`);
}

main();
