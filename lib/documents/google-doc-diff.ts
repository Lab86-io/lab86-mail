/**
 * The Google Docs writer of the semantic editor. It compares the live Doc
 * (read by `projectGoogleDoc`) with the editor model and returns the
 * smallest `documents.batchUpdate` requests that make the Doc match the
 * model. Paragraphs and characters that did not change get no request, so
 * their formatting, comment anchors and revision history stay as they are.
 *
 * Index rules (https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/request):
 * - Indexes are UTF-16 code units, the same unit as a JavaScript string index.
 *   A text edit never starts or ends inside a surrogate pair.
 * - Each paragraph ends with a newline that holds its paragraph style. The
 *   last newline of the body cannot be deleted, so the last paragraph is
 *   never removed: it always takes the last block of the model.
 * - Requests apply in order. Text edits go from the end of the Doc to the
 *   start, so each index refers to text that no earlier request moved. The
 *   paragraph and text styles that follow use the final indexes.
 * - A new paragraph copies the paragraph style, list and nesting level of
 *   the paragraph at the insert index. The writer then sets what differs.
 * - `createParagraphBullets` reads the nesting level from leading tabs and
 *   removes them, so the net index change of that step is zero.
 */
import {
  GOOGLE_CODE_FONT,
  GOOGLE_LINK_COLOR,
  GOOGLE_QUOTE_COLOR,
  GOOGLE_QUOTE_INDENT_PT,
  type GoogleCharStyle,
  type GoogleDocParagraph,
  type GoogleDocProjection,
  GoogleDocumentFidelityError,
  type GoogleListKind,
  googleListPreset,
  googleRgbColor,
  normalizeLink,
  sameCharStyle,
} from './google-fidelity';
import { type DocBlock, MAX_DOC_LIST_LEVEL } from './model';

export type GoogleDocRequest = Record<string, any>;

export interface GoogleDocTargetParagraph {
  type: DocBlock['type'];
  level?: 1 | 2 | 3;
  variant?: 'title' | 'subtitle';
  /** The nesting level of a list item; 0 for other blocks. */
  listLevel: number;
  /** The text, with `\n` for a line break inside the paragraph. */
  text: string;
  /** The style of each UTF-16 code unit of `text`. */
  styles: GoogleCharStyle[];
}

export const GOOGLE_DEFAULT_PRESETS: Record<GoogleListKind, string> = {
  bullet: 'BULLET_DISC_CIRCLE_SQUARE',
  numbered: 'NUMBERED_DECIMAL_ALPHA_ROMAN',
};

export const GOOGLE_LIST_TAB_MESSAGE =
  'A list item that starts with a tab cannot become a Google Docs list item. Remove the tab, then save again.';

/** Docs removes these characters from inserted text: C0 controls except tab, newline and line break, and private-use characters. */
function strippedByDocs(codePoint: number) {
  return (
    codePoint <= 0x08 ||
    (codePoint >= 0x0c && codePoint <= 0x1f) ||
    (codePoint >= 0xe000 && codePoint <= 0xf8ff)
  );
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

function charStyleOf(run: NonNullable<DocBlock['runs']>[number]): GoogleCharStyle {
  const style: GoogleCharStyle = {};
  if (run.bold) style.bold = true;
  if (run.italic) style.italic = true;
  if (run.underline) style.underline = true;
  if (run.strike) style.strike = true;
  if (run.code) style.code = true;
  if (run.link) style.link = run.link;
  return style;
}

/** The model blocks in the form the writer compares: one style for each code unit. */
export function googleDocTarget(blocks: readonly DocBlock[]): GoogleDocTargetParagraph[] {
  const target = blocks.map((block): GoogleDocTargetParagraph => {
    const quote = block.type === 'quote';
    const runs =
      !quote && block.runs && block.runs.map((run) => run.text).join('') === block.text
        ? block.runs
        : [{ text: block.text }];
    let text = '';
    const styles: GoogleCharStyle[] = [];
    for (const run of runs) {
      const style = quote ? {} : charStyleOf(run);
      for (const character of run.text) {
        const codePoint = character.codePointAt(0) ?? 0;
        if (strippedByDocs(codePoint)) continue;
        const written = codePoint === 0x0b ? '\n' : character;
        text += written;
        for (let unit = 0; unit < written.length; unit += 1) styles.push(style);
      }
    }
    // A style edge inside a surrogate pair cannot be written; the pair takes the style of its first unit.
    for (let index = 1; index < text.length; index += 1) {
      if (isLowSurrogate(text.charCodeAt(index)) && isHighSurrogate(text.charCodeAt(index - 1)))
        styles[index] = styles[index - 1];
    }
    const list = block.type === 'bullet' || block.type === 'numbered';
    const paragraph: GoogleDocTargetParagraph = {
      type: block.type,
      listLevel: list ? Math.max(0, Math.min(MAX_DOC_LIST_LEVEL, Math.trunc(block.listLevel ?? 0))) : 0,
      text,
      styles,
    };
    if (block.type === 'heading') {
      paragraph.level = block.level === 1 || block.level === 3 ? block.level : 2;
      if (block.variant) paragraph.variant = block.variant;
    }
    return paragraph;
  });
  return target.length ? target : [{ type: 'paragraph', listLevel: 0, text: '', styles: [] }];
}

function namedStyleFor(paragraph: Pick<GoogleDocTargetParagraph, 'type' | 'level' | 'variant'>) {
  if (paragraph.type !== 'heading') return 'NORMAL_TEXT';
  if (paragraph.variant === 'title') return 'TITLE';
  if (paragraph.variant === 'subtitle') return 'SUBTITLE';
  return `HEADING_${paragraph.level ?? 2}`;
}

function targetList(paragraph: GoogleDocTargetParagraph) {
  return paragraph.type === 'bullet' || paragraph.type === 'numbered'
    ? { kind: paragraph.type as GoogleListKind, level: paragraph.listLevel }
    : undefined;
}

function currentStyles(paragraph: GoogleDocParagraph) {
  const styles: GoogleCharStyle[] = [];
  const fonts: Array<string | undefined> = [];
  for (const span of paragraph.spans) {
    for (let unit = 0; unit < span.text.length; unit += 1) {
      styles.push(span.style);
      fonts.push(span.font);
    }
  }
  return { styles, fonts };
}

function styleKey(style: GoogleCharStyle) {
  return [
    style.bold ? 'b' : '',
    style.italic ? 'i' : '',
    style.underline || style.link ? 'u' : '',
    style.strike ? 's' : '',
    style.code ? 'c' : '',
    normalizeLink(style.link),
  ].join('|');
}

function stylesSignature(styles: readonly GoogleCharStyle[]) {
  const parts: string[] = [];
  let last = '';
  let count = 0;
  for (const style of styles) {
    const key = styleKey(style);
    if (key === last) count += 1;
    else {
      if (count) parts.push(`${count}:${last}`);
      last = key;
      count = 1;
    }
  }
  if (count) parts.push(`${count}:${last}`);
  return parts.join(',');
}

interface Side {
  named: string;
  list?: { kind: GoogleListKind; level: number };
  quote: boolean;
  text: string;
  signature: string;
}

function sideSignature(side: Omit<Side, 'signature'>, styles: readonly GoogleCharStyle[]) {
  return JSON.stringify([
    side.named,
    side.list ? `${side.list.kind}:${side.list.level}` : '',
    side.quote,
    side.text,
    stylesSignature(styles),
  ]);
}

function currentSide(paragraph: GoogleDocParagraph): Side {
  const side = {
    named: paragraph.namedStyleType,
    list: paragraph.list ? { kind: paragraph.list.kind, level: paragraph.list.level } : undefined,
    quote: paragraph.quote,
    text: paragraph.block.text,
  };
  return { ...side, signature: sideSignature(side, currentStyles(paragraph).styles) };
}

function targetSide(paragraph: GoogleDocTargetParagraph): Side {
  const side = {
    named: namedStyleFor(paragraph),
    list: targetList(paragraph),
    quote: paragraph.type === 'quote',
    text: paragraph.text,
  };
  return { ...side, signature: sideSignature(side, paragraph.styles) };
}

/** Code units at the start that are the same in both strings, never ending inside a surrogate pair. */
export function commonPrefixLength(left: string, right: string) {
  const limit = Math.min(left.length, right.length);
  let length = 0;
  while (length < limit && left.charCodeAt(length) === right.charCodeAt(length)) length += 1;
  if (length > 0 && isHighSurrogate(left.charCodeAt(length - 1))) length -= 1;
  return length;
}

/** Code units at the end that are the same, after `prefix`, never starting inside a surrogate pair. */
export function commonSuffixLength(left: string, right: string, prefix: number) {
  const limit = Math.min(left.length, right.length) - prefix;
  let length = 0;
  while (
    length < limit &&
    left.charCodeAt(left.length - 1 - length) === right.charCodeAt(right.length - 1 - length)
  )
    length += 1;
  if (length > 0 && isLowSurrogate(left.charCodeAt(left.length - length))) length -= 1;
  return length;
}

interface Unit {
  old?: number;
  new?: number;
}

/** Longest common subsequence of equal signatures, as index pairs. */
function commonParagraphs(olds: readonly Side[], news: readonly Side[]): Array<[number, number]> {
  const rows = olds.length;
  const columns = news.length;
  if (!rows || !columns || rows * columns > 1_000_000) return [];
  const table = new Uint32Array((rows + 1) * (columns + 1));
  const at = (row: number, column: number) => row * (columns + 1) + column;
  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      table[at(row, column)] =
        olds[row].signature === news[column].signature
          ? table[at(row + 1, column + 1)] + 1
          : Math.max(table[at(row + 1, column)], table[at(row, column + 1)]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let row = 0;
  let column = 0;
  while (row < rows && column < columns) {
    if (olds[row].signature === news[column].signature) {
      pairs.push([row, column]);
      row += 1;
      column += 1;
    } else if (table[at(row + 1, column)] >= table[at(row, column + 1)]) row += 1;
    else column += 1;
  }
  return pairs;
}

function similarity(left: Side, right: Side) {
  const prefix = commonPrefixLength(left.text, right.text);
  const suffix = commonSuffixLength(left.text, right.text, prefix);
  return 1 + prefix + suffix + (left.named === right.named ? 1 : 0) + (left.text === right.text ? 2 : 0);
}

/** Pairs the changed paragraphs of one gap so an edited paragraph keeps its place in the Doc. */
function pairGap(olds: number[], news: number[], current: Side[], target: Side[]): Unit[] {
  if (!olds.length) return news.map((index) => ({ new: index }));
  if (!news.length) return olds.map((index) => ({ old: index }));
  const rows = olds.length;
  const columns = news.length;
  if (rows * columns > 10_000) {
    const units: Unit[] = [];
    for (let index = 0; index < Math.max(rows, columns); index += 1) {
      if (index < rows && index < columns) units.push({ old: olds[index], new: news[index] });
      else if (index < rows) units.push({ old: olds[index] });
      else units.push({ new: news[index] });
    }
    return units;
  }
  const score = new Float64Array((rows + 1) * (columns + 1));
  const at = (row: number, column: number) => row * (columns + 1) + column;
  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      score[at(row, column)] = Math.max(
        score[at(row + 1, column)],
        score[at(row, column + 1)],
        score[at(row + 1, column + 1)] + similarity(current[olds[row]], target[news[column]]),
      );
    }
  }
  const units: Unit[] = [];
  let row = 0;
  let column = 0;
  while (row < rows || column < columns) {
    if (row === rows) units.push({ new: news[column++] });
    else if (column === columns) units.push({ old: olds[row++] });
    else {
      const here = score[at(row, column)];
      const paired = score[at(row + 1, column + 1)] + similarity(current[olds[row]], target[news[column]]);
      if (here === paired) units.push({ old: olds[row++], new: news[column++] });
      else if (here === score[at(row + 1, column)]) units.push({ old: olds[row++] });
      else units.push({ new: news[column++] });
    }
  }
  return units;
}

/** Document-order units: kept or changed pairs, removed paragraphs, and new blocks. */
function alignParagraphs(current: Side[], target: Side[]): Unit[] {
  let head = 0;
  while (head < current.length && head < target.length && current[head].signature === target[head].signature)
    head += 1;
  let tail = 0;
  while (
    tail < current.length - head &&
    tail < target.length - head &&
    current[current.length - 1 - tail].signature === target[target.length - 1 - tail].signature
  )
    tail += 1;
  const units: Unit[] = [];
  for (let index = 0; index < head; index += 1) units.push({ old: index, new: index });
  const oldMiddle = current.slice(head, current.length - tail);
  const newMiddle = target.slice(head, target.length - tail);
  const anchors = commonParagraphs(oldMiddle, newMiddle).map(
    ([oldIndex, newIndex]) => [oldIndex + head, newIndex + head] as const,
  );
  let oldCursor = head;
  let newCursor = head;
  const flushGap = (oldEnd: number, newEnd: number) => {
    const olds: number[] = [];
    const news: number[] = [];
    for (let index = oldCursor; index < oldEnd; index += 1) olds.push(index);
    for (let index = newCursor; index < newEnd; index += 1) news.push(index);
    units.push(...pairGap(olds, news, current, target));
  };
  for (const [oldIndex, newIndex] of anchors) {
    flushGap(oldIndex, newIndex);
    units.push({ old: oldIndex, new: newIndex });
    oldCursor = oldIndex + 1;
    newCursor = newIndex + 1;
  }
  flushGap(current.length - tail, target.length - tail);
  for (let index = tail; index > 0; index -= 1)
    units.push({ old: current.length - index, new: target.length - index });

  // The last paragraph of the body cannot be deleted: it takes the last block.
  const lastOld = current.length - 1;
  const removed = units.findIndex((unit) => unit.old === lastOld && unit.new === undefined);
  if (removed >= 0) {
    let last = units.length - 1;
    while (last >= 0 && units[last].new === undefined) last -= 1;
    const newIndex = units[last].new as number;
    let position = removed;
    if (units[last].old === undefined) {
      units.splice(last, 1);
      position -= 1;
    } else units[last] = { old: units[last].old };
    units[position] = { old: lastOld, new: newIndex };
  }
  return units;
}

function docText(text: string) {
  return text.replace(/\n/gu, '\u000b');
}

interface Predicted {
  source: GoogleDocParagraph;
  /** For a kept or changed paragraph: the old character of each new character, or -1 for new text. */
  oldIndexOf?: (index: number) => number;
  named: string;
  list?: { listId: string; kind: GoogleListKind; level: number };
  quote: boolean;
  redundantKeys: string[];
}

function textStyleRequest(
  range: { startIndex: number; endIndex: number },
  style: GoogleCharStyle,
  quote: boolean,
  font: string | undefined,
) {
  const textStyle: Record<string, any> = {};
  if (style.bold) textStyle.bold = true;
  if (style.italic || quote) textStyle.italic = true;
  if (style.underline || style.link) textStyle.underline = true;
  if (style.strike) textStyle.strikethrough = true;
  if (style.link) {
    textStyle.link = { url: style.link };
    textStyle.foregroundColor = googleRgbColor(GOOGLE_LINK_COLOR);
  } else if (quote) textStyle.foregroundColor = googleRgbColor(GOOGLE_QUOTE_COLOR);
  if (style.code) textStyle.weightedFontFamily = { fontFamily: font || GOOGLE_CODE_FONT, weight: 400 };
  // "*" sets every field: the ones above, and the default for each other one.
  return { updateTextStyle: { range, textStyle, fields: '*' } };
}

/**
 * The requests that change the Doc of `projection` into `blocks`. An empty
 * list means the Doc already matches; the writer also uses this to check a save.
 */
export function googleDocUpdateRequests(
  projection: Pick<GoogleDocProjection, 'paragraphs' | 'lists'>,
  target: readonly GoogleDocTargetParagraph[],
): GoogleDocRequest[] {
  const paragraphs = projection.paragraphs;
  if (!paragraphs.length) throw new GoogleDocumentFidelityError();
  const currentSides = paragraphs.map(currentSide);
  const targetSides = target.map(targetSide);
  const units = alignParagraphs(currentSides, targetSides);
  const requests: GoogleDocRequest[] = [];
  const predicted: Predicted[] = new Array(target.length);

  // 1. Text, from the end of the Doc to the start.
  const survivors = units.filter((unit) => unit.old !== undefined && unit.new !== undefined);
  const gaps: Array<{ olds: number[]; news: number[] }> = Array.from(
    { length: survivors.length + 1 },
    () => ({
      olds: [],
      news: [],
    }),
  );
  let gapIndex = 0;
  for (const unit of units) {
    if (unit.old !== undefined && unit.new !== undefined) gapIndex += 1;
    else if (unit.old !== undefined) gaps[gapIndex].olds.push(unit.old);
    else if (unit.new !== undefined) gaps[gapIndex].news.push(unit.new);
  }
  const inheritScore = (source: GoogleDocParagraph, paragraph: GoogleDocTargetParagraph) => {
    const list = targetList(paragraph);
    let score = 0;
    if (
      (!source.list && !list) ||
      (source.list && list && source.list.kind === list.kind && source.list.level === list.level)
    )
      score += 2;
    if (source.namedStyleType === namedStyleFor(paragraph)) score += 1;
    if (source.quote === (paragraph.type === 'quote')) score += 1;
    return score;
  };
  const deleteParagraphs = (olds: number[]) => {
    for (const index of [...olds].reverse()) {
      const paragraph = paragraphs[index];
      requests.push({
        deleteContentRange: { range: { startIndex: paragraph.startIndex, endIndex: paragraph.endIndex } },
      });
    }
  };
  for (let index = survivors.length; index >= 0; index -= 1) {
    const gap = gaps[index];
    const before = index > 0 ? paragraphs[survivors[index - 1].old as number] : undefined;
    const after = index < survivors.length ? paragraphs[survivors[index].old as number] : undefined;
    if (gap.news.length) {
      const first = target[gap.news[0]];
      const last = target[gap.news.at(-1) as number];
      const useBefore =
        Boolean(before) && (!after || inheritScore(before!, first) >= inheritScore(after, last));
      const text = gap.news.map((newIndex) => docText(target[newIndex].text)).join('\n');
      const source = (useBefore ? before : after) as GoogleDocParagraph;
      for (const newIndex of gap.news) {
        predicted[newIndex] = {
          source,
          named: source.namedStyleType,
          ...(source.list ? { list: { ...source.list } } : {}),
          quote: source.quote,
          redundantKeys: source.redundantKeys,
        };
      }
      if (useBefore) {
        deleteParagraphs(gap.olds);
        // Before the closing newline of the previous paragraph: each new paragraph copies its style.
        requests.push({ insertText: { location: { index: before!.endIndex - 1 }, text: `\n${text}` } });
      } else {
        requests.push({ insertText: { location: { index: after!.startIndex }, text: `${text}\n` } });
        deleteParagraphs(gap.olds);
      }
    } else deleteParagraphs(gap.olds);
    if (index === 0) break;
    const unit = survivors[index - 1];
    const paragraph = paragraphs[unit.old as number];
    const next = target[unit.new as number];
    const oldText = paragraph.block.text;
    const prefix = commonPrefixLength(oldText, next.text);
    const suffix = commonSuffixLength(oldText, next.text, prefix);
    const removedEnd = oldText.length - suffix;
    const insertedEnd = next.text.length - suffix;
    if (removedEnd > prefix) {
      requests.push({
        deleteContentRange: {
          range: { startIndex: paragraph.startIndex + prefix, endIndex: paragraph.startIndex + removedEnd },
        },
      });
    }
    if (insertedEnd > prefix) {
      requests.push({
        insertText: {
          location: { index: paragraph.startIndex + prefix },
          text: docText(next.text.slice(prefix, insertedEnd)),
        },
      });
    }
    predicted[unit.new as number] = {
      source: paragraph,
      oldIndexOf: (position) =>
        position < prefix ? position : position >= insertedEnd ? position - insertedEnd + removedEnd : -1,
      named: paragraph.namedStyleType,
      ...(paragraph.list ? { list: { ...paragraph.list } } : {}),
      quote: paragraph.quote,
      redundantKeys: paragraph.redundantKeys,
    };
  }

  // Final ranges: every paragraph now has the text of its block.
  const starts: number[] = [];
  let cursor = paragraphs[0].startIndex;
  for (const paragraph of target) {
    starts.push(cursor);
    cursor += paragraph.text.length + 1;
  }
  const rangeOf = (index: number) => ({
    startIndex: starts[index],
    endIndex: starts[index] + target[index].text.length + 1,
  });
  const rewrite = new Array<boolean>(target.length).fill(false);

  // 2. Lists that end or change: remove the bullet and the indent that Docs leaves for it.
  for (let index = 0; index < target.length; index += 1) {
    const state = predicted[index];
    const list = targetList(target[index]);
    if (!state.list || (list && list.kind === state.list.kind && list.level === state.list.level)) continue;
    let end = index;
    while (end + 1 < target.length) {
      const nextState = predicted[end + 1];
      const nextList = targetList(target[end + 1]);
      if (
        !nextState.list ||
        (nextList && nextList.kind === nextState.list.kind && nextList.level === nextState.list.level)
      )
        break;
      end += 1;
    }
    const range = { startIndex: starts[index], endIndex: rangeOf(end).endIndex };
    requests.push({ deleteParagraphBullets: { range } });
    requests.push({
      updateParagraphStyle: { range, paragraphStyle: {}, fields: 'indentStart,indentFirstLine' },
    });
    for (let cleared = index; cleared <= end; cleared += 1) {
      predicted[cleared].list = undefined;
      predicted[cleared].quote = false;
    }
    index = end;
  }

  // 3. Named styles and the quote indent.
  for (let index = 0; index < target.length; index += 1) {
    const state = predicted[index];
    const paragraph = target[index];
    const named = namedStyleFor(paragraph);
    if (state.named !== named) {
      requests.push({
        updateParagraphStyle: {
          range: rangeOf(index),
          paragraphStyle: { namedStyleType: named },
          // Properties that repeated the old named style go back to the new one.
          fields: ['namedStyleType', ...state.redundantKeys].join(','),
        },
      });
      rewrite[index] = true;
    }
    const quote = paragraph.type === 'quote';
    if (quote && !state.quote) {
      requests.push({
        updateParagraphStyle: {
          range: rangeOf(index),
          paragraphStyle: { indentStart: { magnitude: GOOGLE_QUOTE_INDENT_PT, unit: 'PT' } },
          fields: 'indentStart',
        },
      });
      rewrite[index] = true;
    } else if (!quote && state.quote) {
      requests.push({
        updateParagraphStyle: { range: rangeOf(index), paragraphStyle: {}, fields: 'indentStart' },
      });
      rewrite[index] = true;
    }
  }

  // 4. New list items, one group of the same kind at a time. A group after an
  // item of a list with the same glyphs joins that list.
  const createdPreset = new Map<number, string>();
  for (let index = 0; index < target.length; index += 1) {
    const list = targetList(target[index]);
    if (!list || predicted[index].list) continue;
    let end = index;
    while (end + 1 < target.length) {
      const nextList = targetList(target[end + 1]);
      if (!nextList || nextList.kind !== list.kind || predicted[end + 1].list) break;
      end += 1;
    }
    let preset = GOOGLE_DEFAULT_PRESETS[list.kind];
    const previous = index - 1;
    const previousList = previous >= 0 ? targetList(target[previous]) : undefined;
    if (previousList?.kind === list.kind) {
      const kept = predicted[previous].list;
      preset =
        createdPreset.get(previous) ??
        (kept ? googleListPreset(projection.lists?.[kept.listId], list.kind) : null) ??
        preset;
    }
    let tabs = 0;
    for (let item = end; item >= index; item -= 1) {
      if (target[item].text.startsWith('\t')) throw new GoogleDocumentFidelityError(GOOGLE_LIST_TAB_MESSAGE);
      const level = target[item].listLevel;
      if (level > 0) {
        requests.push({ insertText: { location: { index: starts[item] }, text: '\t'.repeat(level) } });
        tabs += level;
      }
    }
    requests.push({
      createParagraphBullets: {
        range: { startIndex: starts[index], endIndex: rangeOf(end).endIndex + tabs },
        bulletPreset: preset,
      },
    });
    for (let item = index; item <= end; item += 1) createdPreset.set(item, preset);
    index = end;
  }

  // 5. Text styles of new text, and of kept text whose style changed.
  for (let index = 0; index < target.length; index += 1) {
    const paragraph = target[index];
    const state = predicted[index];
    const quote = paragraph.type === 'quote';
    const old = currentStyles(state.source);
    const paragraphFont = old.fonts.find(Boolean);
    let open: { start: number; key: string; style: GoogleCharStyle; font?: string } | null = null;
    const close = (end: number) => {
      if (!open) return;
      requests.push(
        textStyleRequest(
          { startIndex: starts[index] + open.start, endIndex: starts[index] + end },
          open.style,
          quote,
          open.font,
        ),
      );
      open = null;
    };
    for (let position = 0; position < paragraph.text.length; position += 1) {
      const style = paragraph.styles[position];
      const oldIndex = state.oldIndexOf && !rewrite[index] ? state.oldIndexOf(position) : -1;
      const kept = oldIndex >= 0 && sameCharStyle(old.styles[oldIndex] || {}, style);
      if (kept) {
        close(position);
        continue;
      }
      const font = style.code
        ? (oldIndex >= 0 && old.styles[oldIndex]?.code ? old.fonts[oldIndex] : undefined) || paragraphFont
        : undefined;
      const key = `${styleKey(style)}|${font || ''}`;
      if (open && (open as { key: string }).key === key) continue;
      close(position);
      open = { start: position, key, style, ...(font ? { font } : {}) };
    }
    close(paragraph.text.length);
  }
  return requests;
}
