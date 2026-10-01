import { Plugin } from '@tiptap/pm/state';
import { type Editor, Extension, Node } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { clampListLevel, validDocLink } from './doc-rich-text';

/**
 * Move the list items in the selection one nesting level in or out. Returns
 * false outside a list, so Tab keeps its usual focus behavior there.
 */
export function changeListLevel(editor: Editor, delta: 1 | -1) {
  if (!editor.isActive('listItem')) return false;
  const { from, to } = editor.state.selection;
  const transaction = editor.state.tr;
  editor.state.doc.nodesBetween(from, to, (node, position) => {
    if (node.type.name !== 'listItem') return;
    const listLevel = clampListLevel(Number(node.attrs.listLevel || 0) + delta);
    if (listLevel !== node.attrs.listLevel)
      transaction.setNodeMarkup(position, undefined, { ...node.attrs, listLevel });
  });
  if (transaction.docChanged) editor.view.dispatch(transaction);
  return true;
}

/**
 * The canonical model is flat: never allow hidden nested structures to be
 * lost on save. Nesting is a level on each item (Google Docs lists work the
 * same way), not a list inside a list.
 */
const FlatListItem = Node.create({
  name: 'listItem',
  content: 'paragraph',
  defining: true,
  addAttributes() {
    return {
      listLevel: {
        default: 0,
        parseHTML: (element: HTMLElement) => clampListLevel(element.getAttribute('data-list-level')),
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes.listLevel ? { 'data-list-level': attributes.listLevel } : {},
      },
    };
  },
  parseHTML: () => [{ tag: 'li' }],
  renderHTML: ({ HTMLAttributes }) => ['li', HTMLAttributes, 0],
  addKeyboardShortcuts() {
    return {
      Enter: () => this.editor.commands.splitListItem(this.name),
      Tab: () => changeListLevel(this.editor, 1),
      'Shift-Tab': () => changeListLevel(this.editor, -1),
    };
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
        // A heading shown as the document title or subtitle.
        types: ['heading'],
        attributes: {
          variant: {
            default: null,
            keepOnSplit: false,
            parseHTML: (element: HTMLElement) => {
              const variant = element.getAttribute('data-variant');
              return variant === 'title' || variant === 'subtitle' ? variant : null;
            },
            renderHTML: (attributes: Record<string, unknown>) =>
              attributes.variant ? { 'data-variant': attributes.variant } : {},
          },
        },
      },
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

export function documentExtensions() {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      listItem: false,
      blockquote: false,
      codeBlock: false,
      horizontalRule: false,
      link: {
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        defaultProtocol: 'https',
        protocols: ['mailto'],
        HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank', class: null },
        // Only the links the document model holds: http, https and mailto.
        isAllowedUri: (url, context) => Boolean(validDocLink(url)) && context.defaultValidate(url),
      },
      trailingNode: false,
    }),
    FlatListItem,
    FlatQuote,
    BlockIdentity,
  ];
}
