/**
 * Pure conversion between the versioned doc model (`DocBlock[]`, plain text
 * canonical, optional inline `runs`) and the ProseMirror/Tiptap JSON the rich
 * text editor edits. No React, no DOM: safe for tests and for tools.
 *
 * Faithfulness rules
 * - Every paragraph/heading carries a stable `blockId` attribute.
 * - Consecutive bullet/numbered/quote blocks group into one list/blockquote;
 *   splitting them back yields the same blocks in the same order.
 * - `text` is the concatenation of runs; hard breaks are `\n` characters.
 * - Blocks with no formatting omit `runs` entirely.
 */
import type { AlbatrossDocumentModel, DocBlock, DocRun } from '@/lib/documents/model';

export type DocModel = Extract<AlbatrossDocumentModel, { kind: 'doc' }>;
export type BlockStyle = 'paragraph' | 'heading1' | 'heading2' | 'heading3' | 'bullet' | 'numbered' | 'quote';

export const RUN_MARKS = ['bold', 'italic', 'underline', 'strike', 'code'] as const;
export type RunMark = (typeof RUN_MARKS)[number];

export interface EditorMark {
  type: string;
  attrs?: Record<string, unknown>;
}
export interface EditorNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: EditorNode[];
  marks?: EditorMark[];
  text?: string;
}

const TEXT_BLOCK_TYPES = new Set(['paragraph', 'heading']);

export function createBlockId() {
  return crypto.randomUUID();
}

function runFormatKey(run: Omit<DocRun, 'text'>) {
  return RUN_MARKS.map((mark) => (run[mark] ? '1' : '0')).join('');
}

function hasFormatting(run: Omit<DocRun, 'text'>) {
  return RUN_MARKS.some((mark) => run[mark]);
}

function stripFormat(run: DocRun): DocRun {
  const next: DocRun = { text: run.text };
  for (const mark of RUN_MARKS) if (run[mark]) next[mark] = true;
  return next;
}

/** Merge adjacent runs with identical formatting, drop empties, strip false flags. */
export function normalizeRuns(runs: DocRun[]): DocRun[] {
  const out: DocRun[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const clean = stripFormat(run);
    const last = out[out.length - 1];
    if (last && runFormatKey(last) === runFormatKey(clean)) last.text += clean.text;
    else out.push(clean);
  }
  return out;
}

export function runsText(runs: DocRun[]) {
  return runs.map((run) => run.text).join('');
}

/**
 * The runs a block should carry: `undefined` when nothing is formatted or
 * when the runs no longer match the canonical text (never trust stale runs).
 */
export function effectiveRuns(block: Pick<DocBlock, 'text' | 'runs'>): DocRun[] | undefined {
  if (!block.runs) return undefined;
  const runs = normalizeRuns(block.runs);
  if (runsText(runs) !== block.text) return undefined;
  if (!runs.some(hasFormatting)) return undefined;
  return runs;
}

function marksForRun(run: DocRun): EditorMark[] {
  return RUN_MARKS.filter((mark) => run[mark]).map((mark) => ({ type: mark }));
}

function inlineContent(block: DocBlock): EditorNode[] {
  const runs = effectiveRuns(block) ?? (block.text ? [{ text: block.text }] : []);
  const content: EditorNode[] = [];
  for (const run of runs) {
    const marks = marksForRun(run);
    const pieces = run.text.split('\n');
    pieces.forEach((piece, index) => {
      if (index > 0) content.push(marks.length ? { type: 'hardBreak', marks } : { type: 'hardBreak' });
      if (piece)
        content.push(marks.length ? { type: 'text', text: piece, marks } : { type: 'text', text: piece });
    });
  }
  return content;
}

function textBlockNode(block: DocBlock): EditorNode {
  const content = inlineContent(block);
  if (block.type === 'heading') {
    const node: EditorNode = { type: 'heading', attrs: { level: block.level ?? 2, blockId: block.id } };
    if (content.length) node.content = content;
    return node;
  }
  const node: EditorNode = { type: 'paragraph', attrs: { blockId: block.id } };
  if (content.length) node.content = content;
  return node;
}

/** Editor JSON for a doc model. An empty model still yields one paragraph so the editor has a caret. */
export function docModelToEditorJson(model: DocModel, createId: () => string = createBlockId): EditorNode {
  const content: EditorNode[] = [];
  let group: { type: 'bulletList' | 'orderedList' | 'blockquote'; node: EditorNode } | null = null;
  const closeGroup = () => {
    group = null;
  };
  for (const block of model.blocks) {
    if (block.type === 'bullet' || block.type === 'numbered') {
      const listType = block.type === 'bullet' ? 'bulletList' : 'orderedList';
      if (!group || group.type !== listType) {
        const node: EditorNode =
          listType === 'orderedList'
            ? { type: listType, attrs: { start: 1, type: null }, content: [] }
            : { type: listType, content: [] };
        content.push(node);
        group = { type: listType, node };
      }
      group.node.content!.push({
        type: 'listItem',
        content: [textBlockNode({ ...block, type: 'paragraph' })],
      });
      continue;
    }
    if (block.type === 'quote') {
      if (!group || group.type !== 'blockquote') {
        const node: EditorNode = { type: 'blockquote', content: [] };
        content.push(node);
        group = { type: 'blockquote', node };
      }
      group.node.content!.push(textBlockNode({ ...block, type: 'paragraph' }));
      continue;
    }
    closeGroup();
    content.push(textBlockNode(block));
  }
  if (!content.length) content.push({ type: 'paragraph', attrs: { blockId: createId() } });
  return { type: 'doc', content };
}

function runFromMarks(text: string, marks: EditorMark[] | undefined): DocRun {
  const run: DocRun = { text };
  for (const mark of marks || []) {
    if ((RUN_MARKS as readonly string[]).includes(mark.type)) run[mark.type as RunMark] = true;
  }
  return run;
}

function readInline(node: EditorNode): DocRun[] {
  const runs: DocRun[] = [];
  for (const child of node.content || []) {
    if (child.type === 'text') runs.push(runFromMarks(child.text || '', child.marks));
    else if (child.type === 'hardBreak') runs.push(runFromMarks('\n', child.marks));
    else if (child.content) runs.push(...readInline(child));
  }
  return normalizeRuns(runs);
}

function readTextBlock(
  node: EditorNode,
  type: DocBlock['type'],
  createId: () => string,
  seen: Set<string>,
): DocBlock {
  const runs = readInline(node);
  const text = runsText(runs);
  let id = typeof node.attrs?.blockId === 'string' && node.attrs.blockId ? node.attrs.blockId : createId();
  while (seen.has(id)) id = createId();
  seen.add(id);
  const block: DocBlock = { id, type, text };
  if (type === 'heading') {
    const level = Number(node.attrs?.level);
    block.level = level === 1 || level === 3 ? level : 2;
  }
  if (runs.some(hasFormatting)) block.runs = runs;
  return block;
}

/**
 * Read the editor JSON back into blocks. Unknown wrappers are flattened to
 * their text blocks so nothing silently disappears; nested lists become flat
 * items of the outer list type.
 */
export function editorJsonToDocBlocks(doc: EditorNode, createId: () => string = createBlockId): DocBlock[] {
  const blocks: DocBlock[] = [];
  const seen = new Set<string>();
  const visit = (node: EditorNode, context: DocBlock['type']) => {
    if (node.type === 'heading') {
      blocks.push(readTextBlock(node, context === 'paragraph' ? 'heading' : context, createId, seen));
      return;
    }
    if (TEXT_BLOCK_TYPES.has(node.type)) {
      blocks.push(readTextBlock(node, context, createId, seen));
      return;
    }
    const nextContext =
      node.type === 'bulletList'
        ? 'bullet'
        : node.type === 'orderedList'
          ? 'numbered'
          : node.type === 'blockquote'
            ? 'quote'
            : context;
    for (const child of node.content || []) visit(child, nextContext);
    if (node.type === 'listItem' && !(node.content || []).length)
      blocks.push({ id: createId(), type: context, text: '' });
  };
  for (const child of doc.content || []) visit(child, 'paragraph');
  return blocks;
}

export function editorJsonToDocModel(doc: EditorNode, createId?: () => string): DocModel {
  return { kind: 'doc', version: 1, blocks: editorJsonToDocBlocks(doc, createId) };
}

function runsEqual(left: DocRun[] | undefined, right: DocRun[] | undefined) {
  if (!left && !right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every(
    (run, index) => run.text === right[index].text && runFormatKey(run) === runFormatKey(right[index]),
  );
}

/** Structural equality that ignores key order and undefined fields. */
export function docModelsEqual(left: DocModel | null | undefined, right: DocModel | null | undefined) {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.blocks.length !== right.blocks.length) return false;
  return left.blocks.every((block, index) => {
    const other = right.blocks[index];
    return (
      block.id === other.id &&
      block.type === other.type &&
      block.text === other.text &&
      (block.level ?? undefined) === (other.level ?? undefined) &&
      runsEqual(block.runs, other.runs)
    );
  });
}

export function blockStyleOf(block: Pick<DocBlock, 'type' | 'level'>): BlockStyle {
  if (block.type === 'heading') return `heading${block.level ?? 2}` as BlockStyle;
  return block.type;
}

/** Move one block by one position; returns the same model when nothing changes. */
export function moveDocBlock(model: DocModel, blockId: string, direction: -1 | 1): DocModel {
  const index = model.blocks.findIndex((block) => block.id === blockId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= model.blocks.length) return model;
  const blocks = [...model.blocks];
  const [moved] = blocks.splice(index, 1);
  blocks.splice(target, 0, moved);
  return { ...model, blocks };
}

export function docHeadings(model: DocModel) {
  return model.blocks.filter((block) => block.type === 'heading' && block.text.trim());
}
