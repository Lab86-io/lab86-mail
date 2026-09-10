import { Plugin } from '@tiptap/pm/state';
import { Extension, Node } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';

/** The canonical model is flat: never allow hidden nested structures to be lost on save. */
const FlatListItem = Node.create({
  name: 'listItem',
  content: 'paragraph',
  defining: true,
  parseHTML: () => [{ tag: 'li' }],
  renderHTML: () => ['li', 0],
  addKeyboardShortcuts() {
    return { Enter: () => this.editor.commands.splitListItem(this.name) };
  },
});

const FlatQuote = Node.create({
  name: 'blockquote',
  group: 'block',
  content: 'paragraph+',
  defining: true,
  parseHTML: () => [{ tag: 'blockquote' }],
  renderHTML: () => ['blockquote', 0],
});

/** Assign split/pasted blocks identities inside the transaction, so undo preserves them too. */
const BlockIdentity = Extension.create({
  name: 'albatrossBlockIdentity',
  addGlobalAttributes() {
    return [
      {
        types: ['paragraph', 'heading'],
        attributes: {
          blockId: {
            default: null,
            keepOnSplit: false,
            parseHTML: (element: HTMLElement) => element.getAttribute('data-block-id'),
            renderHTML: (attributes: Record<string, unknown>) => ({ 'data-block-id': attributes.blockId }),
          },
        },
      },
    ];
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction(transactions, oldState, state) {
          if (!transactions.some((transaction) => transaction.docChanged)) return null;
          const preserved = new Map<number, string>();
          oldState.doc.descendants((node, position) => {
            if (node.type.name !== 'paragraph' && node.type.name !== 'heading') return;
            if (typeof node.attrs.blockId !== 'string' || !node.attrs.blockId) return;
            let mapped = position;
            for (const change of transactions) mapped = change.mapping.map(mapped, 1);
            if (!preserved.has(mapped)) preserved.set(mapped, node.attrs.blockId);
          });
          const seen = new Set<string>();
          const transaction = state.tr;
          state.doc.descendants((node, position) => {
            if (node.type.name !== 'paragraph' && node.type.name !== 'heading') return;
            let id = node.attrs.blockId;
            if (typeof id !== 'string' || !id || id.length > 120 || seen.has(id)) {
              const existing = preserved.get(position);
              id = existing && !seen.has(existing) ? existing : crypto.randomUUID();
              transaction.setNodeMarkup(position, undefined, { ...node.attrs, blockId: id });
            }
            seen.add(id);
          });
          return transaction.docChanged ? transaction : null;
        },
      }),
    ];
  },
});

export function documentExtensions(plainTextOnly = false) {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      listItem: false,
      blockquote: false,
      codeBlock: false,
      horizontalRule: false,
      link: false,
      trailingNode: false,
      ...(plainTextOnly ? { bold: false, italic: false, underline: false, strike: false, code: false } : {}),
    }),
    FlatListItem,
    FlatQuote,
    BlockIdentity,
  ];
}
