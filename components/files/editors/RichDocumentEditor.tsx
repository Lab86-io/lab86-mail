'use client';

import { EditorState } from '@tiptap/pm/state';
import { EditorContent, type JSONContent, useEditor, useEditorState } from '@tiptap/react';
import {
  ArrowDown,
  ArrowUp,
  Bold,
  Code,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Link2,
  List,
  ListOrdered,
  Quote,
  Redo2,
  Strikethrough,
  Underline,
  Undo2,
} from 'lucide-react';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { GOOGLE_DOC_EDITING_NOTICE } from '@/lib/documents/google-write-policy';
import type { AlbatrossDocumentModel } from '@/lib/documents/model';
import { changeListLevel, documentExtensions } from './doc-extensions';
import {
  type BlockStyle,
  type DocModel,
  docHeadings,
  docModelsEqual,
  docModelToEditorJson,
  editorJsonToDocModel,
  linkFromInput,
  moveDocBlock,
} from './doc-rich-text';
import './document-editors.css';

export function RichDocumentEditor({
  model,
  onChange,
  readOnly = false,
  target = 'albatross',
}: {
  model: DocModel;
  onChange: (model: AlbatrossDocumentModel) => void;
  readOnly?: boolean;
  /** `google`: the model saves to a Google Doc; the editor says so. */
  target?: 'albatross' | 'google';
}) {
  const modelRef = useRef(model);
  const callback = useRef(onChange);
  callback.current = onChange;
  const [notice, setNotice] = useState('');
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkDraft, setLinkDraft] = useState('');
  const [linkError, setLinkError] = useState('');
  const linkFieldId = useId();
  const editor = useEditor(
    {
      immediatelyRender: false,
      extensions: documentExtensions(),
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
          if (!unsupported) return false;
          const text = data.getData('text/plain');
          setNotice(
            target === 'google'
              ? 'Pasted text only. Open the Doc in Google to add tables and images.'
              : 'Pasted text only. Tables, images and nested lists need a full Office editor.',
          );
          if (!text) return true;
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
    [],
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
                    ? current.getAttributes('heading').variant ||
                      `heading${current.getAttributes('heading').level}`
                    : 'paragraph',
            link: current.isActive('link') ? String(current.getAttributes('link').href || '') : '',
            inList: current.isActive('listItem'),
            listLevel: Number(current.getAttributes('listItem').listLevel) || 0,
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
    if (next === 'title') chain.setNode('heading', { level: 1, variant: 'title' }).run();
    else if (next === 'subtitle') chain.setNode('heading', { level: 2, variant: 'subtitle' }).run();
    else if (next.startsWith('heading'))
      chain.setHeading({ level: Number(next.slice(-1)) as 1 | 2 | 3 }).run();
    else if (next === 'bullet') chain.toggleBulletList().run();
    else if (next === 'numbered') chain.toggleOrderedList().run();
    else if (next === 'quote') chain.wrapIn('blockquote').run();
    else chain.setParagraph().run();
  };
  const openLink = (open: boolean) => {
    setLinkOpen(open);
    setLinkError('');
    if (open) setLinkDraft(status?.link || '');
  };
  const applyLink = (event: FormEvent) => {
    event.preventDefault();
    if (!editor) return;
    const href = linkFromInput(linkDraft);
    if (!href) {
      setLinkError('Type a web address or an email address.');
      return;
    }
    const chain = editor.chain().focus();
    if (editor.state.selection.empty && !editor.isActive('link'))
      chain.insertContent({
        type: 'text',
        text: linkDraft.trim(),
        marks: [{ type: 'link', attrs: { href } }],
      });
    else chain.extendMarkRange('link').setLink({ href });
    chain.run();
    setLinkOpen(false);
  };
  const removeLink = () => {
    editor?.chain().focus().extendMarkRange('link').unsetLink().run();
    setLinkOpen(false);
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
        className="flex shrink-0 flex-wrap items-center gap-1 border-b border-[var(--color-border)] bg-[var(--color-content)] px-3 py-2"
      >
        <select
          aria-label="Paragraph style"
          className="control-field h-11 max-w-36 px-2 text-xs sm:h-8"
          disabled={readOnly || !editor}
          value={status?.style || 'paragraph'}
          onChange={(event) => style(event.target.value as BlockStyle)}
        >
          <option value="paragraph">Paragraph</option>
          <option value="title">Title</option>
          <option value="subtitle">Subtitle</option>
          <option value="heading1">Heading 1</option>
          <option value="heading2">Heading 2</option>
          <option value="heading3">Heading 3</option>
          <option value="bullet">Bullet list</option>
          <option value="numbered">Numbered list</option>
          <option value="quote">Quote</option>
        </select>
        {(
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
        ))}
        <Popover open={linkOpen} onOpenChange={openLink}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-11 sm:size-8"
              aria-label="Link"
              aria-pressed={Boolean(status?.link)}
              disabled={readOnly || !editor}
              onMouseDown={(event) => event.preventDefault()}
            >
              <Link2 className="size-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-80 p-3">
            <form onSubmit={applyLink} className="space-y-2">
              <label htmlFor={linkFieldId} className="block text-xs font-medium">
                Link
              </label>
              <input
                id={linkFieldId}
                value={linkDraft}
                onChange={(event) => {
                  setLinkDraft(event.target.value);
                  setLinkError('');
                }}
                placeholder="https://example.com"
                inputMode="url"
                autoComplete="off"
                className="control-field h-9 w-full px-2 text-base sm:text-sm"
                aria-invalid={Boolean(linkError)}
                aria-describedby={linkError ? `${linkFieldId}-error` : undefined}
              />
              {linkError ? (
                <p id={`${linkFieldId}-error`} role="alert" className="text-xs text-[var(--color-danger)]">
                  {linkError}
                </p>
              ) : null}
              <div className="flex justify-end gap-2 pt-1">
                {status?.link ? (
                  <Button type="button" variant="ghost" size="sm" onClick={removeLink}>
                    Remove
                  </Button>
                ) : null}
                <Button type="submit" size="sm">
                  Apply
                </Button>
              </div>
            </form>
          </PopoverContent>
        </Popover>
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
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-11 sm:size-8"
          aria-label="Decrease indent"
          disabled={readOnly || !status?.inList || !status.listLevel}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => editor && changeListLevel(editor, -1)}
        >
          <IndentDecrease className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-11 sm:size-8"
          aria-label="Increase indent"
          disabled={readOnly || !status?.inList || status.listLevel >= 8}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => editor && changeListLevel(editor, 1)}
        >
          <IndentIncrease className="size-4" />
        </Button>
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
      {target === 'google' ? (
        <p className="border-b border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-text-muted)]">
          {GOOGLE_DOC_EDITING_NOTICE}
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
