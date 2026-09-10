'use client';

import { EditorState } from '@tiptap/pm/state';
import { EditorContent, type JSONContent, useEditor, useEditorState } from '@tiptap/react';
import {
  ArrowDown,
  ArrowUp,
  Bold,
  Code,
  Italic,
  List,
  ListOrdered,
  Quote,
  Redo2,
  Strikethrough,
  Underline,
  Undo2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { AlbatrossDocumentModel } from '@/lib/documents/model';
import { documentExtensions } from './doc-extensions';
import {
  type BlockStyle,
  type DocModel,
  docHeadings,
  docModelsEqual,
  docModelToEditorJson,
  editorJsonToDocModel,
  moveDocBlock,
} from './doc-rich-text';
import './document-editors.css';

export function RichDocumentEditor({
  model,
  onChange,
  readOnly = false,
  plainTextOnly = false,
}: {
  model: DocModel;
  onChange: (model: AlbatrossDocumentModel) => void;
  readOnly?: boolean;
  /** Direct Google editing only supports the provider's existing paragraph-level subset. */
  plainTextOnly?: boolean;
}) {
  const modelRef = useRef(model);
  const callback = useRef(onChange);
  callback.current = onChange;
  const [notice, setNotice] = useState('');
  const editor = useEditor(
    {
      immediatelyRender: false,
      extensions: documentExtensions(plainTextOnly),
      content: docModelToEditorJson(model) as JSONContent,
      editable: !readOnly,
      editorProps: {
        attributes: {
          role: 'textbox',
          'aria-label': 'Document text',
          'aria-multiline': 'true',
          'data-placeholder': 'Start writing…',
        },
        handlePaste(view, event) {
          const data = event.clipboardData;
          if (!data) return false;
          const html = data.getData('text/html');
          const parsed = html ? new DOMParser().parseFromString(html, 'text/html') : null;
          const unsupported =
            data.files.length > 0 ||
            Boolean(parsed?.querySelector('table, img, video, iframe, li ul, li ol'));
          if (!unsupported && !plainTextOnly) return false;
          const text = data.getData('text/plain');
          if (unsupported || html)
            setNotice(
              plainTextOnly
                ? 'Pasted as plain text. Direct Google editing supports text and paragraph styles only.'
                : 'Pasted text only. Tables, images and nested lists need a full Office editor.',
            );
          if (!text) return unsupported;
          const paragraphs = text
            .split(/\r?\n/)
            .map((line) =>
              view.state.schema.nodes.paragraph.create(null, line ? view.state.schema.text(line) : undefined),
            );
          const { from, to } = view.state.selection;
          view.dispatch(view.state.tr.replaceWith(from, to, paragraphs));
          return true;
        },
      },
      onUpdate({ editor: current }) {
        const next = editorJsonToDocModel(current.getJSON());
        modelRef.current = next;
        callback.current(next);
      },
    },
    [plainTextOnly],
  );
  const status = useEditorState({
    editor,
    selector: ({ editor: current }) =>
      current
        ? {
            blockId: current.state.selection.$from.parent.attrs.blockId as string | undefined,
            style: current.isActive('bulletList')
              ? 'bullet'
              : current.isActive('orderedList')
                ? 'numbered'
                : current.isActive('blockquote')
                  ? 'quote'
                  : current.isActive('heading')
                    ? `heading${current.getAttributes('heading').level}`
                    : 'paragraph',
            bold: current.isActive('bold'),
            italic: current.isActive('italic'),
            underline: current.isActive('underline'),
            strike: current.isActive('strike'),
            code: current.isActive('code'),
            undo: current.can().undo(),
            redo: current.can().redo(),
            empty: current.isEmpty,
          }
        : null,
  });

  useEffect(() => {
    editor?.setEditable(!readOnly, false);
  }, [editor, readOnly]);
  useEffect(() => {
    if (!editor || docModelsEqual(modelRef.current, model)) return;
    modelRef.current = model;
    editor.commands.setContent(docModelToEditorJson(model) as JSONContent, { emitUpdate: false });
    // A server revision is a new undo boundary; undo must not resurrect its predecessor.
    editor.view.updateState(
      EditorState.create({ schema: editor.schema, doc: editor.state.doc, plugins: editor.state.plugins }),
    );
    editor.view.dispatch(editor.state.tr.setMeta('addToHistory', false));
  }, [editor, model]);

  const focusBlock = (id: string) => {
    if (!editor) return;
    editor.state.doc.descendants((node, position) => {
      if (node.attrs.blockId === id) editor.commands.focus(position + 1);
    });
  };
  const move = (direction: -1 | 1) => {
    if (!editor || readOnly || !status?.blockId) return;
    const next = moveDocBlock(modelRef.current, status.blockId, direction);
    if (next === modelRef.current) return;
    editor.commands.setContent(docModelToEditorJson(next) as JSONContent);
    focusBlock(status.blockId);
  };
  const style = (next: BlockStyle) => {
    if (!editor) return;
    const chain = editor.chain().focus().clearNodes();
    if (next.startsWith('heading')) chain.setHeading({ level: Number(next.slice(-1)) as 1 | 2 | 3 }).run();
    else if (next === 'bullet') chain.toggleBulletList().run();
    else if (next === 'numbered') chain.toggleOrderedList().run();
    else if (next === 'quote') chain.wrapIn('blockquote').run();
    else chain.setParagraph().run();
  };
  const index = model.blocks.findIndex((block) => block.id === status?.blockId);
  const headings = docHeadings(model);
  return (
    <fieldset
      aria-label="Document editing workspace"
      disabled={readOnly}
      className="doc-editor-workspace m-0 flex h-full min-h-0 min-w-0 flex-col border-0 p-0"
      onKeyDown={(event) => {
        if (event.defaultPrevented || event.nativeEvent.isComposing) return;
        if (
          (event.metaKey || event.ctrlKey) &&
          event.altKey &&
          ['ArrowUp', 'ArrowDown'].includes(event.key)
        ) {
          event.preventDefault();
          event.stopPropagation();
          move(event.key === 'ArrowUp' ? -1 : 1);
        }
      }}
    >
      <div
        role="toolbar"
        aria-label="Document formatting"
        className="flex shrink-0 flex-wrap items-center gap-1 border-b border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2"
      >
        <select
          aria-label="Paragraph style"
          className="control-field h-11 max-w-36 px-2 text-xs sm:h-8"
          disabled={readOnly || !editor}
          value={status?.style || 'paragraph'}
          onChange={(event) => style(event.target.value as BlockStyle)}
        >
          <option value="paragraph">Paragraph</option>
          <option value="heading1">Heading 1</option>
          <option value="heading2">Heading 2</option>
          <option value="heading3">Heading 3</option>
          <option value="bullet">Bullet list</option>
          <option value="numbered">Numbered list</option>
          <option value="quote">Quote</option>
        </select>
        {!plainTextOnly
          ? (
              [
                ['bold', Bold],
                ['italic', Italic],
                ['underline', Underline],
                ['strike', Strikethrough],
                ['code', Code],
              ] as const
            ).map(([mark, Icon]) => (
              <Button
                key={mark}
                variant="ghost"
                size="icon-sm"
                className="size-11 sm:size-8"
                aria-label={mark === 'strike' ? 'Strikethrough' : mark[0].toUpperCase() + mark.slice(1)}
                aria-pressed={Boolean(status?.[mark])}
                disabled={readOnly || !editor}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => editor?.chain().focus().toggleMark(mark).run()}
              >
                <Icon className="size-4" />
              </Button>
            ))
          : null}
        {(
          [
            ['bullet', List],
            ['numbered', ListOrdered],
            ['quote', Quote],
          ] as const
        ).map(([kind, Icon]) => (
          <Button
            key={kind}
            variant="ghost"
            size="icon-sm"
            className="size-11 sm:size-8"
            aria-label={kind === 'bullet' ? 'Bullet list' : kind === 'numbered' ? 'Numbered list' : 'Quote'}
            aria-pressed={status?.style === kind}
            disabled={readOnly || !editor}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => style(status?.style === kind ? 'paragraph' : kind)}
          >
            <Icon className="size-4" />
          </Button>
        ))}
        <span className="mx-1 h-5 border-l border-[var(--color-border)]" />
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-11 sm:size-8"
          aria-label="Undo"
          disabled={readOnly || !status?.undo}
          onClick={() => editor?.chain().focus().undo().run()}
        >
          <Undo2 className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-11 sm:size-8"
          aria-label="Redo"
          disabled={readOnly || !status?.redo}
          onClick={() => editor?.chain().focus().redo().run()}
        >
          <Redo2 className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-11 sm:size-8"
          aria-label="Move block up"
          disabled={readOnly || index < 1}
          onClick={() => move(-1)}
        >
          <ArrowUp className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-11 sm:size-8"
          aria-label="Move block down"
          disabled={readOnly || index < 0 || index === model.blocks.length - 1}
          onClick={() => move(1)}
        >
          <ArrowDown className="size-4" />
        </Button>
      </div>
      {plainTextOnly ? (
        <p className="border-b border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-text-muted)]">
          Direct Google editing: text, headings and lists. Open in Google for full formatting; rich paste is
          text only.
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="px-3 py-2 text-xs text-[var(--color-text-muted)]">
          {notice}
        </p>
      ) : null}
      <div className="flex min-h-0 flex-1">
        {headings.length ? (
          <nav
            aria-label="Document outline"
            className="doc-outline w-40 shrink-0 overflow-y-auto border-r border-[var(--color-border)] p-3"
          >
            <p className="mb-3 text-xs text-[var(--color-text-muted)]">Outline</p>
            {headings.map((heading) => (
              <button
                type="button"
                key={heading.id}
                title={heading.text}
                onClick={() => focusBlock(heading.id)}
                className="block w-full truncate rounded-[var(--radius-control)] px-2 py-2 text-left text-xs hover:bg-[var(--color-control-hover)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
              >
                {heading.text}
              </button>
            ))}
          </nav>
        ) : null}
        <div className="doc-canvas-scroller min-w-0 flex-1 overflow-y-auto">
          <article
            aria-label="Document canvas"
            className="doc-rich-text mx-auto min-h-[850px] max-w-[820px] border border-slate-200 bg-white"
            data-empty={status?.empty}
          >
            <EditorContent editor={editor} />
          </article>
        </div>
      </div>
      <div className="shrink-0 border-t border-[var(--color-border)] px-3 py-1.5 text-[11px] text-[var(--color-text-muted)]">
        {
          model.blocks
            .map((block) => block.text)
            .join(' ')
            .trim()
            .split(/\s+/)
            .filter(Boolean).length
        }{' '}
        words · {model.blocks.length} blocks
      </div>
    </fieldset>
  );
}
