// Embedded fonts for the Word templates. Each DOCX carries its own copy of the
// house type, so Word, Pages, and the document server show the same letters
// on a computer that does not have the fonts.
//
// Word stores an embedded font as an obfuscated part (`.odttf`, ECMA-376
// Part 1, 17.8.1): the first 32 bytes are XORed with a GUID key, and
// fontTable.xml holds that key. The docx library embeds only a regular face,
// so this module writes the font table itself (regular and bold faces).

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type JSZip from 'jszip';

export const TEMPLATE_FONT_DIR = path.join('lib', 'documents', 'templates', 'fonts');
const FONT_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/font';
const OBFUSCATED_FONT = 'application/vnd.openxmlformats-officedocument.obfuscatedFont';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

type Face = 'regular' | 'bold';

export interface TemplateFontFamily {
  name: string;
  /** w:family: `swiss` for sans serif, `roman` for serif. */
  kind: 'swiss' | 'roman';
  faces: Partial<Record<Face, string>>;
}

/** The families and the faces that the templates use. Only these weights are committed. */
export const TEMPLATE_FONTS: TemplateFontFamily[] = [
  { name: 'Geist', kind: 'swiss', faces: { regular: 'Geist-Regular.ttf', bold: 'Geist-Bold.ttf' } },
  { name: 'Fraunces Display', kind: 'roman', faces: { regular: 'FrauncesDisplay-Regular.ttf' } },
];

const cache = new Map<string, Promise<Uint8Array>>();
export function loadTemplateFont(file: string, root = process.cwd()): Promise<Uint8Array> {
  const key = path.join(root, TEMPLATE_FONT_DIR, file);
  let loaded = cache.get(key);
  if (!loaded) {
    loaded = readFile(key).then((bytes) => new Uint8Array(bytes));
    loaded.catch(() => cache.delete(key));
    cache.set(key, loaded);
  }
  return loaded;
}

/** The 16 key bytes of a font GUID, in the order the obfuscation uses (last hex pair first). */
function keyBytes(guid: string): number[] {
  const hex = guid.replace(/[{}-]/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error('A font key must be a GUID.');
  const bytes: number[] = [];
  for (let index = 30; index >= 0; index -= 2) bytes.push(Number.parseInt(hex.slice(index, index + 2), 16));
  return bytes;
}

/** XOR the first 32 bytes with the key. The same call reverses it. */
export function obfuscateFont(font: Uint8Array, guid: string): Uint8Array {
  const key = keyBytes(guid);
  const out = new Uint8Array(font);
  for (let index = 0; index < Math.min(32, out.length); index++) out[index] ^= key[index % 16];
  return out;
}

const escapeAttribute = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

/**
 * Adds the template fonts to a DOCX package: the obfuscated font parts, the
 * font table with their keys, and `w:embedTrueTypeFonts` in the settings so
 * Word and LibreOffice keep the fonts when they save the file again.
 */
export async function embedTemplateFonts(
  zip: JSZip,
  options: { families?: TemplateFontFamily[]; root?: string; newKey?: () => string } = {},
) {
  const families = options.families ?? TEMPLATE_FONTS;
  const newKey = options.newKey ?? (() => randomUUID().toUpperCase());
  const relationships: string[] = [];
  const fonts: string[] = [];
  let next = 1;
  for (const family of families) {
    const embeds: string[] = [];
    for (const face of ['regular', 'bold'] as const) {
      const file = family.faces[face];
      if (!file) continue;
      const key = newKey();
      const id = `rId${next++}`;
      const target = `fonts/${slug(family.name)}-${face}.odttf`;
      zip.file(`word/${target}`, obfuscateFont(await loadTemplateFont(file, options.root), key));
      relationships.push(`<Relationship Id="${id}" Type="${FONT_REL}" Target="${target}"/>`);
      const element = face === 'regular' ? 'w:embedRegular' : 'w:embedBold';
      embeds.push(`<${element} r:id="${id}" w:fontKey="{${key}}"/>`);
    }
    fonts.push(
      `<w:font w:name="${escapeAttribute(family.name)}"><w:charset w:val="00"/><w:family w:val="${family.kind}"/><w:pitch w:val="variable"/>${embeds.join('')}</w:font>`,
    );
  }
  zip.file(
    'word/fontTable.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:fonts xmlns:w="${W}" xmlns:r="${R}">${fonts.join('')}</w:fonts>`,
  );
  zip.file(
    'word/_rels/fontTable.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships.join('')}</Relationships>`,
  );
  await ensureFontContentType(zip);
  await ensureFontTableRelationship(zip);
  await ensureEmbedSetting(zip);
}

async function ensureFontContentType(zip: JSZip) {
  const types = (await zip.file('[Content_Types].xml')?.async('string')) ?? '';
  let next = types;
  if (!/Extension="odttf"/i.test(next))
    next = next.replace('</Types>', `<Default Extension="odttf" ContentType="${OBFUSCATED_FONT}"/></Types>`);
  if (!next.includes('PartName="/word/fontTable.xml"'))
    next = next.replace(
      '</Types>',
      '<Override PartName="/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/></Types>',
    );
  if (next !== types) zip.file('[Content_Types].xml', next);
}

async function ensureFontTableRelationship(zip: JSZip) {
  const path = 'word/_rels/document.xml.rels';
  const rels = (await zip.file(path)?.async('string')) ?? '';
  if (rels.includes('relationships/fontTable')) return;
  zip.file(
    path,
    rels.replace(
      '</Relationships>',
      `<Relationship Id="rIdFontTable" Type="${R}/fontTable" Target="fontTable.xml"/></Relationships>`,
    ),
  );
}

// CT_Settings elements that come before w:embedTrueTypeFonts.
const BEFORE_EMBED = [
  'writeProtection',
  'view',
  'zoom',
  'removePersonalInformation',
  'removeDateAndTime',
  'doNotDisplayPageBoundaries',
  'displayBackgroundShape',
  'printPostScriptOverText',
  'printFractionalCharacterWidth',
  'printFormsData',
];

async function ensureEmbedSetting(zip: JSZip) {
  const path = 'word/settings.xml';
  const settings = await zip.file(path)?.async('string');
  if (!settings || settings.includes('<w:embedTrueTypeFonts')) return;
  let at = -1;
  for (const name of BEFORE_EMBED) {
    const match = new RegExp(`<w:${name}(?:\\s[^>]*)?(?:/>|>[\\s\\S]*?</w:${name}>)`).exec(settings);
    if (match) at = Math.max(at, match.index + match[0].length);
  }
  if (at < 0) at = settings.indexOf('>', settings.indexOf('<w:settings')) + 1;
  zip.file(path, `${settings.slice(0, at)}<w:embedTrueTypeFonts/>${settings.slice(at)}`);
}
