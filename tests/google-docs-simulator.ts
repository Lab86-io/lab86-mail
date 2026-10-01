/**
 * A small in-memory Google Docs body for tests. It applies the batchUpdate
 * requests that the semantic editor writer sends, with the documented rules
 * (https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/request):
 * - Indexes are UTF-16 code units; the body starts at 1 after the section break.
 * - A new paragraph copies the paragraph style, list and nesting level of the
 *   paragraph at the insert index. Inserted text takes the style of the
 *   character before it.
 * - Docs removes C0 controls (except tab, newline, line break) and private-use
 *   characters from inserted text.
 * - The last newline of the body, half of a surrogate pair, and an index
 *   outside the body are refused with an error, as Docs does.
 * - createParagraphBullets reads the nesting level from leading tabs, removes
 *   them, and joins the list of the paragraph before when its preset matches.
 * - deleteParagraphBullets keeps the visual indent of the item.
 * - Setting a link also sets the link color and underline, unless the same
 *   request sets them.
 */

type Style = Record<string, any>;

interface SimChar {
  ch: string;
  style: Style;
}

interface SimParagraph {
  chars: SimChar[]; // includes the closing newline
  paragraphStyle: Style;
  bullet?: { listId: string; nestingLevel?: number; textStyle?: Style };
}

const LINK_COLOR = { color: { rgbColor: { red: 17 / 255, green: 85 / 255, blue: 204 / 255 } } };

const PRESET_LEVELS: Record<
  string,
  Array<{ glyphSymbol?: string; glyphType?: string; glyphFormat: string }>
> = {
  BULLET_DISC_CIRCLE_SQUARE: ['●', '○', '■'].map((glyphSymbol, level) => ({
    glyphSymbol,
    glyphFormat: `%${level}`,
  })),
  BULLET_DIAMONDX_ARROW3D_SQUARE: ['❖', '➢', '■'].map((glyphSymbol, level) => ({
    glyphSymbol,
    glyphFormat: `%${level}`,
  })),
  NUMBERED_DECIMAL_ALPHA_ROMAN: ['DECIMAL', 'ALPHA', 'ROMAN'].map((glyphType, level) => ({
    glyphType,
    glyphFormat: `%${level}.`,
  })),
  NUMBERED_DECIMAL_NESTED: ['DECIMAL', 'DECIMAL', 'DECIMAL'].map((glyphType, level) => ({
    glyphType,
    glyphFormat: Array.from({ length: level + 1 }, (_, index) => `%${index}.`).join(''),
  })),
};

export function presetList(preset: string) {
  const base = PRESET_LEVELS[preset];
  if (!base) throw new Error(`Unknown preset ${preset}`);
  return {
    listProperties: {
      nestingLevels: Array.from({ length: 9 }, (_, level) => ({
        ...base[level % 3],
        bulletAlignment: 'START',
        indentFirstLine: { magnitude: 18 + 36 * level, unit: 'PT' },
        indentStart: { magnitude: 36 + 36 * level, unit: 'PT' },
        textStyle: { underline: false },
        startNumber: 1,
      })),
    },
  };
}

function presetOf(list: any) {
  for (const preset of Object.keys(PRESET_LEVELS)) {
    const levels = PRESET_LEVELS[preset];
    if (
      levels.every((level, index) => {
        const actual = list?.listProperties?.nestingLevels?.[index];
        return actual && actual.glyphSymbol === level.glyphSymbol && actual.glyphType === level.glyphType;
      })
    )
      return preset;
  }
  return null;
}

function stripped(codePoint: number) {
  return (
    codePoint <= 0x08 ||
    (codePoint >= 0x0c && codePoint <= 0x1f) ||
    (codePoint >= 0xe000 && codePoint <= 0xf8ff)
  );
}

function sameStyle(left: Style, right: Style) {
  return JSON.stringify(sortKeys(left)) === JSON.stringify(sortKeys(right));
}

function sortKeys(value: any): any {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys(value[key])]),
  );
}

export interface SimParagraphInput {
  text: string;
  /** Style of the whole text, or one style for each run of `runs`. */
  runs?: Array<{ text: string; style?: Style }>;
  paragraphStyle?: Style;
  bullet?: { listId: string; nestingLevel?: number };
}

export class GoogleDocsSimulator {
  paragraphs: SimParagraph[];
  lists: Record<string, any>;
  revision = 1;
  requestLog: any[][] = [];
  private listCounter = 0;
  /** Request types that the fake applies as no-ops, to test a save that Google does not keep. */
  ignore = new Set<string>();

  constructor(input: SimParagraphInput[], lists: Record<string, any> = {}) {
    this.lists = structuredClone(lists);
    this.paragraphs = input.map((paragraph) => {
      const runs = paragraph.runs ?? [{ text: paragraph.text }];
      if (runs.map((run) => run.text).join('') !== paragraph.text) throw new Error('runs must match text');
      const chars: SimChar[] = [];
      for (const run of runs)
        for (const unit of run.text.split('')) chars.push({ ch: unit, style: { ...(run.style || {}) } });
      chars.push({ ch: '\n', style: {} });
      return {
        chars,
        paragraphStyle: {
          namedStyleType: 'NORMAL_TEXT',
          direction: 'LEFT_TO_RIGHT',
          ...(paragraph.paragraphStyle || {}),
        },
        ...(paragraph.bullet ? { bullet: { ...paragraph.bullet } } : {}),
      };
    });
    if (!this.paragraphs.length)
      this.paragraphs.push({
        chars: [{ ch: '\n', style: {} }],
        paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
      });
  }

  get revisionId() {
    return `rev-${this.revision}`;
  }

  /** Paragraph start indexes. */
  private starts() {
    const starts: number[] = [];
    let cursor = 1;
    for (const paragraph of this.paragraphs) {
      starts.push(cursor);
      cursor += paragraph.chars.length;
    }
    return { starts, end: cursor };
  }

  private locate(index: number) {
    const { starts, end } = this.starts();
    if (!Number.isInteger(index) || index < 1 || index >= end)
      throw new Error(`Index ${index} is outside the body.`);
    for (let paragraph = starts.length - 1; paragraph >= 0; paragraph -= 1) {
      if (index >= starts[paragraph]) return { paragraph, offset: index - starts[paragraph] };
    }
    throw new Error('unreachable');
  }

  private flat() {
    return this.paragraphs.flatMap((paragraph) => paragraph.chars);
  }

  private assertNotInPair(index: number) {
    const flat = this.flat();
    const at = flat[index - 1]?.ch.charCodeAt(0) ?? 0;
    const before = flat[index - 2]?.ch.charCodeAt(0) ?? 0;
    if (at >= 0xdc00 && at <= 0xdfff && before >= 0xd800 && before <= 0xdbff)
      throw new Error(`Index ${index} is inside a surrogate pair.`);
  }

  private paragraphsOverlapping(range: { startIndex: number; endIndex: number }) {
    if (range.endIndex <= range.startIndex) throw new Error('Empty range.');
    const { starts } = this.starts();
    const out: number[] = [];
    this.paragraphs.forEach((paragraph, index) => {
      const start = starts[index];
      const end = start + paragraph.chars.length;
      if (end > range.startIndex && start < range.endIndex) out.push(index);
    });
    return out;
  }

  insertText(index: number, text: string) {
    this.assertNotInPair(index);
    const { paragraph, offset } = this.locate(index);
    const source = this.paragraphs[paragraph];
    if (offset > source.chars.length - 1) throw new Error('Insert after a newline.');
    const flat = this.flat();
    const inherited = { ...(flat[index - 2]?.style || {}) };
    delete inherited.link;
    const inserted: SimChar[] = [];
    for (const ch of text) {
      if (stripped(ch.codePointAt(0) ?? 0)) continue;
      for (const unit of ch.split('')) inserted.push({ ch: unit, style: { ...inherited } });
    }
    const chars = [...source.chars.slice(0, offset), ...inserted, ...source.chars.slice(offset)];
    const split: SimParagraph[] = [];
    let current: SimChar[] = [];
    for (const char of chars) {
      current.push(char);
      if (char.ch === '\n') {
        split.push({
          chars: current,
          paragraphStyle: structuredClone(source.paragraphStyle),
          ...(source.bullet ? { bullet: structuredClone(source.bullet) } : {}),
        });
        current = [];
      }
    }
    this.paragraphs.splice(paragraph, 1, ...split);
  }

  deleteContentRange(range: { startIndex: number; endIndex: number }) {
    const { end } = this.starts();
    if (range.endIndex <= range.startIndex) throw new Error('Empty delete.');
    if (range.endIndex >= end) throw new Error('Cannot delete the last newline of the body.');
    this.assertNotInPair(range.startIndex);
    this.assertNotInPair(range.endIndex);
    const first = this.locate(range.startIndex);
    const last = this.locate(range.endIndex);
    const keepHead = this.paragraphs[first.paragraph].chars.slice(0, first.offset);
    const tail = this.paragraphs[last.paragraph];
    const merged: SimParagraph = { ...tail, chars: [...keepHead, ...tail.chars.slice(last.offset)] };
    this.paragraphs.splice(first.paragraph, last.paragraph - first.paragraph + 1, merged);
  }

  updateTextStyle(range: { startIndex: number; endIndex: number }, textStyle: Style, fields: string) {
    this.assertNotInPair(range.startIndex);
    this.assertNotInPair(range.endIndex);
    const flat = this.flat();
    const keys =
      fields === '*'
        ? [
            'bold',
            'italic',
            'underline',
            'strikethrough',
            'smallCaps',
            'backgroundColor',
            'foregroundColor',
            'fontSize',
            'weightedFontFamily',
            'baselineOffset',
            'link',
          ]
        : fields.split(',');
    for (let index = range.startIndex; index < range.endIndex; index += 1) {
      const char = flat[index - 1];
      if (!char) throw new Error(`Index ${index} is outside the body.`);
      if (char.ch === '\n') continue;
      const style = { ...char.style };
      for (const key of keys) {
        if (textStyle[key] === undefined || textStyle[key] === false) delete style[key];
        else style[key] = structuredClone(textStyle[key]);
      }
      if (keys.includes('link') && textStyle.link) {
        if (!keys.includes('underline')) style.underline = true;
        if (!keys.includes('foregroundColor')) style.foregroundColor = LINK_COLOR;
      }
      char.style = style;
    }
  }

  updateParagraphStyle(
    range: { startIndex: number; endIndex: number },
    paragraphStyle: Style,
    fields: string,
  ) {
    for (const index of this.paragraphsOverlapping(range)) {
      const style = this.paragraphs[index].paragraphStyle;
      for (const key of fields.split(',')) {
        if (paragraphStyle[key] === undefined) delete style[key];
        else style[key] = structuredClone(paragraphStyle[key]);
      }
      if (!style.namedStyleType) style.namedStyleType = 'NORMAL_TEXT';
    }
  }

  createParagraphBullets(range: { startIndex: number; endIndex: number }, preset: string) {
    const indexes = this.paragraphsOverlapping(range);
    const previous = this.paragraphs[indexes[0] - 1];
    const previousList = previous?.bullet ? this.lists[previous.bullet.listId] : null;
    let listId: string;
    if (previous?.bullet && presetOf(previousList) === preset) listId = previous.bullet.listId;
    else {
      this.listCounter += 1;
      listId = `kix.sim${this.listCounter}`;
      this.lists[listId] = presetList(preset);
    }
    for (const index of indexes) {
      const paragraph = this.paragraphs[index];
      let tabs = 0;
      while (paragraph.chars[tabs]?.ch === '\t') tabs += 1;
      paragraph.chars.splice(0, tabs);
      paragraph.bullet = { listId, ...(tabs ? { nestingLevel: tabs } : {}), textStyle: { underline: false } };
      paragraph.paragraphStyle.indentFirstLine = { magnitude: 18 + 36 * tabs, unit: 'PT' };
      paragraph.paragraphStyle.indentStart = { magnitude: 36 + 36 * tabs, unit: 'PT' };
    }
  }

  deleteParagraphBullets(range: { startIndex: number; endIndex: number }) {
    for (const index of this.paragraphsOverlapping(range)) {
      const paragraph = this.paragraphs[index];
      if (!paragraph.bullet) continue;
      const level = paragraph.bullet.nestingLevel || 0;
      delete paragraph.bullet;
      // The nesting level stays visible as an indent.
      paragraph.paragraphStyle.indentStart = { magnitude: 36 + 36 * level, unit: 'PT' };
      paragraph.paragraphStyle.indentFirstLine = { magnitude: 36 + 36 * level, unit: 'PT' };
    }
  }

  batchUpdate(body: { requests: any[]; writeControl?: { requiredRevisionId?: string } }) {
    const required = body.writeControl?.requiredRevisionId;
    if (required && required !== this.revisionId) {
      return {
        status: 400,
        body: {
          error: {
            code: 400,
            message: 'The required revision ID does not match the latest revision of the document.',
            status: 'FAILED_PRECONDITION',
          },
        },
      };
    }
    const backup = structuredClone({ paragraphs: this.paragraphs, lists: this.lists });
    try {
      for (const request of body.requests) {
        const [type, value] = Object.entries(request)[0] as [string, any];
        if (this.ignore.has(type)) continue;
        if (type === 'insertText') this.insertText(value.location.index, value.text);
        else if (type === 'deleteContentRange') this.deleteContentRange(value.range);
        else if (type === 'updateTextStyle') this.updateTextStyle(value.range, value.textStyle, value.fields);
        else if (type === 'updateParagraphStyle')
          this.updateParagraphStyle(value.range, value.paragraphStyle, value.fields);
        else if (type === 'createParagraphBullets')
          this.createParagraphBullets(value.range, value.bulletPreset);
        else if (type === 'deleteParagraphBullets') this.deleteParagraphBullets(value.range);
        else throw new Error(`Unsupported request ${type}`);
      }
    } catch (error) {
      // A batch is atomic.
      this.paragraphs = backup.paragraphs;
      this.lists = backup.lists;
      return { status: 400, body: { error: { code: 400, message: (error as Error).message } } };
    }
    this.requestLog.push(body.requests);
    this.revision += 1;
    return {
      status: 200,
      body: { documentId: 'doc-1', replies: [], writeControl: { requiredRevisionId: this.revisionId } },
    };
  }

  /** The `documents.get` JSON, in the `includeTabsContent=true` shape unless `legacy`. */
  toJson(options: { legacy?: boolean; extra?: Record<string, any> } = {}) {
    const content: any[] = [{ endIndex: 1, sectionBreak: { sectionStyle: {} } }];
    let cursor = 1;
    for (const paragraph of this.paragraphs) {
      const start = cursor;
      const elements: any[] = [];
      let run: { start: number; text: string; style: Style } | null = null;
      paragraph.chars.forEach((char, offset) => {
        const at = start + offset;
        if (run && sameStyle(run.style, char.style)) run.text += char.ch;
        else {
          if (run)
            elements.push({
              startIndex: run.start,
              endIndex: run.start + run.text.length,
              textRun: { content: run.text, textStyle: run.style },
            });
          run = { start: at, text: char.ch, style: char.style };
        }
      });
      if (run) {
        const last = run as { start: number; text: string; style: Style };
        elements.push({
          startIndex: last.start,
          endIndex: last.start + last.text.length,
          textRun: { content: last.text, textStyle: last.style },
        });
      }
      cursor += paragraph.chars.length;
      content.push({
        startIndex: start,
        endIndex: cursor,
        paragraph: {
          elements,
          paragraphStyle: structuredClone(paragraph.paragraphStyle),
          ...(paragraph.bullet ? { bullet: structuredClone(paragraph.bullet) } : {}),
        },
      });
    }
    const documentTab = { body: { content }, lists: structuredClone(this.lists), ...(options.extra || {}) };
    if (options.legacy)
      return { documentId: 'doc-1', title: 'Doc', revisionId: this.revisionId, ...documentTab };
    return {
      documentId: 'doc-1',
      title: 'Doc',
      revisionId: this.revisionId,
      tabs: [{ tabProperties: { tabId: 't.0', title: 'Tab 1', index: 0 }, documentTab }],
    };
  }

  /** Plain text of the body, one line for each paragraph. */
  text() {
    return this.paragraphs.map((paragraph) =>
      paragraph.chars
        .map((char) => char.ch)
        .join('')
        .replace(/\n$/u, ''),
    );
  }
}

/** A `fetch` that serves the simulator, Drive metadata and Drive comments. */
export function simulatorFetch(
  doc: GoogleDocsSimulator,
  options: { name?: string; comments?: any[]; commentsStatus?: number; legacy?: boolean } = {},
) {
  const calls: Array<{ method: string; url: string; body?: any }> = [];
  let version = 9;
  const fetch = (async (url: unknown, init?: RequestInit) => {
    const endpoint = String(url);
    const method = init?.method || 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url: endpoint, body });
    if (endpoint.includes('/comments?')) {
      if (options.commentsStatus)
        return Response.json({ error: { code: options.commentsStatus } }, { status: options.commentsStatus });
      return Response.json({ comments: options.comments ?? [] });
    }
    if (endpoint.includes('/drive/v3/files/') && method === 'PATCH') return Response.json({ id: 'doc-1' });
    if (endpoint.includes('/drive/v3/files/')) {
      return Response.json({
        id: 'doc-1',
        name: options.name ?? 'Project brief',
        webViewLink: 'https://docs.google.com/document/d/doc-1/edit',
        version: String(version),
      });
    }
    if (endpoint.endsWith(':batchUpdate')) {
      const result = doc.batchUpdate(body);
      if (result.status === 200) version += 1;
      return Response.json(result.body, { status: result.status });
    }
    if (endpoint.includes('docs.googleapis.com/v1/documents/'))
      return Response.json(doc.toJson({ legacy: options.legacy }));
    return new Response('unexpected', { status: 500 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls, version: () => String(version) };
}
