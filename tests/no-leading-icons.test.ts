import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

// Product rule: no icon before button text. An icon may stand alone (with a
// label for assistive tech), or the text may stand alone. Menu items follow
// the same rule. Status glyphs outside buttons and menus may stay when they
// carry meaning (a spinner, a warning, an attachment count).
const BUTTONS: Record<string, string[]> = {
  'components/thread/ThreadView.tsx': ['Show emails with them', 'New email', 'Download', 'Open'],
  'components/thread/InlineComposer.tsx': ['Attach', 'Open'],
  'components/inbox/Inbox.tsx': [
    'Select visible',
    'Archive',
    'Trash',
    'Apply smart labels',
    'Never Main',
    'Always Noise',
    'Move to...',
  ],
  'components/settings/AiSection.tsx': ['Upgrade', 'Save'],
  'app/settings/page.tsx': ['Back to Albatross', 'Resync', 'Disconnect', 'Connect'],
  'components/tasks/TasksSurface.tsx': ['Add card', 'Add column'],
  'components/files/FilesSurface.tsx': [
    'Choose folder',
    'Upload to Albatross',
    'Connect a drive',
    'Setup needed',
  ],
};

/** A self-closing icon element followed directly by words. */
export function leadingIconHits(source: string): string[] {
  const pattern =
    /<(?:RowIcon\b[^>]*|[A-Z][A-Za-z0-9]*\s+className="[^"]*size-[^"]*"[^>]*)\/>\s*(?:\{[^}]*\}\s*)?([A-Z][a-z][^<{\n]*)/g;
  return [...source.matchAll(pattern)].map((match) => match[1].trim());
}

// ---------------------------------------------------------------------------
// Syntax-tree check for menus and text buttons across components/** and app/**.
// ---------------------------------------------------------------------------

/** Modules whose exports draw an icon or a spinner. */
const ICON_MODULES =
  /^(lucide-react|@\/components\/ui\/row-icon|@\/components\/icons\/|@\/components\/loading-ui\/|@\/components\/shell\/navigation-icons|\.\/navigation-icons|@\/components\/palette\/SearchResultIcon)/;
const MENU_ITEMS = new Set([
  'DropdownMenuItem',
  'DropdownMenuCheckboxItem',
  'DropdownMenuRadioItem',
  'ContextMenuItem',
  'ContextMenuCheckboxItem',
  'ContextMenuRadioItem',
  'MenubarItem',
  'CommandItem',
  'SelectItem',
]);
// Rail rows (SidebarMenuButton) are left out: the rail folds to its icons.
const TEXT_CONTROLS = new Set(['button', 'Button', 'a', 'label', 'AccordionTrigger']);
/** Kept on purpose, with the reason. Key: `${file}: ${text}`. */
const KEPT: Record<string, string> = {
  'components/shell/MobileNavigation.tsx: Search Albatross':
    'Looks and acts as a search field; the glass marks the field.',
};

export interface IconHit {
  file: string;
  line: number;
  control: string;
  text: string;
}

function tagOf(node: ts.JsxElement | ts.JsxSelfClosingElement, sf: ts.SourceFile) {
  return (ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName).getText(sf);
}

function attribute(node: ts.JsxElement | ts.JsxSelfClosingElement, name: string, sf: ts.SourceFile) {
  const attributes = ts.isJsxElement(node) ? node.openingElement.attributes : node.attributes;
  const found = attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && property.name.getText(sf) === name,
  );
  return found ? (found.initializer?.getText(sf) ?? 'true') : null;
}

function meaningful(children: ts.NodeArray<ts.JsxChild>, sf: ts.SourceFile) {
  return children.filter(
    (child) =>
      !(ts.isJsxText(child) && !child.getText(sf).trim()) &&
      !(ts.isJsxExpression(child) && !child.expression),
  );
}

/** Syntax-tree scan: controls whose first visible child is an icon and that also show text. */
export function iconBeforeTextHits(file: string, source: string, controls: Set<string>): IconHit[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const icons = new Set<string>();
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const from = (statement.moduleSpecifier as ts.StringLiteral).text;
    // Animated icons live in components/ui beside the primitives, named `…Icon`.
    const isIcon = (name: string) =>
      ICON_MODULES.test(from) || (from.startsWith('@/components/ui/') && /Icon$/.test(name));
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings))
      for (const item of bindings.elements) if (isIcon(item.name.text)) icons.add(item.name.text);
    const name = statement.importClause?.name?.text;
    if (name && isIcon(name)) icons.add(name);
  }
  if (!icons.size) return [];

  const iconElements = (node: ts.Node): Array<ts.JsxSelfClosingElement> | null => {
    if (ts.isJsxSelfClosingElement(node)) return icons.has(tagOf(node, sf)) ? [node] : null;
    if (!ts.isJsxExpression(node) || !node.expression) return null;
    // `{busy ? <Spinner /> : <Plus />}` or `{busy && <Spinner />}` holds icons only.
    const found: ts.JsxSelfClosingElement[] = [];
    let other = false;
    const walk = (child: ts.Node) => {
      if (ts.isJsxSelfClosingElement(child)) {
        if (icons.has(tagOf(child, sf))) found.push(child);
        else other = true;
        return;
      }
      if (ts.isJsxElement(child) || ts.isJsxFragment(child) || ts.isStringLiteralLike(child)) {
        other = true;
        return;
      }
      if (ts.isTemplateExpression(child)) {
        other = true;
        return;
      }
      ts.forEachChild(child, walk);
    };
    walk(node.expression);
    return found.length && !other ? found : null;
  };
  const visibleElement = (node: ts.JsxElement) =>
    !/\bsr-only\b/.test(attribute(node, 'className', sf) || '') &&
    attribute(node, 'aria-hidden', sf) === null;
  const visibleText = (node: ts.JsxChild): boolean => {
    if (ts.isJsxText(node)) return Boolean(node.getText(sf).trim());
    if (ts.isJsxElement(node)) return visibleElement(node);
    if (!ts.isJsxExpression(node) || !node.expression || iconElements(node)) return false;
    // `{count > 0 && <span aria-hidden>…</span>}` shows no text; a string does.
    const shows = (expression: ts.Expression): boolean => {
      if (ts.isParenthesizedExpression(expression)) return shows(expression.expression);
      if (ts.isConditionalExpression(expression))
        return shows(expression.whenTrue) || shows(expression.whenFalse);
      if (ts.isBinaryExpression(expression))
        return expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
          ? shows(expression.right)
          : shows(expression.left) || shows(expression.right);
      if (ts.isJsxElement(expression)) return visibleElement(expression);
      if (ts.isJsxFragment(expression)) return expression.children.some(visibleText);
      if (ts.isJsxSelfClosingElement(expression)) return false;
      return !(
        expression.kind === ts.SyntaxKind.NullKeyword ||
        expression.kind === ts.SyntaxKind.FalseKeyword ||
        (ts.isIdentifier(expression) && expression.text === 'undefined')
      );
    };
    return shows(node.expression);
  };
  const hiddenWhenWide = (node: ts.JsxSelfClosingElement) =>
    /\S+:hidden\b/.test(attribute(node, 'className', sf) || '');
  const shownWhenWide = (node: ts.JsxChild) =>
    ts.isJsxElement(node) &&
    /(^|["'\s])hidden\b/.test(attribute(node, 'className', sf) || '') &&
    /\S+:(inline|block|flex|inline-flex|inline-block)\b/.test(attribute(node, 'className', sf) || '');

  const hits: IconHit[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) && controls.has(tagOf(node, sf))) {
      let children = meaningful(node.children, sf);
      // A single wrapper span or fragment holds the real content.
      while (
        children.length === 1 &&
        ((ts.isJsxElement(children[0]) && tagOf(children[0], sf) === 'span') || ts.isJsxFragment(children[0]))
      ) {
        children = meaningful((children[0] as ts.JsxElement | ts.JsxFragment).children, sf);
      }
      const leading = children.length > 1 ? iconElements(children[0]) : null;
      const text = children.slice(1).filter(visibleText);
      // An icon for narrow widths and a word for wide ones never show together.
      const swapped = leading?.every(hiddenWhenWide) && text.every(shownWhenWide);
      if (leading && text.length && !swapped) {
        hits.push({
          file,
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          control: tagOf(node, sf),
          text: text[0].getText(sf).replace(/\s+/g, ' ').trim().slice(0, 60),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

function componentFiles(dir: string): string[] {
  return readdirSync(path.join(process.cwd(), dir), { withFileTypes: true }).flatMap((entry) => {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return componentFiles(relative);
    return entry.name.endsWith('.tsx') ? [relative] : [];
  });
}

function scan(controls: Set<string>) {
  return [...componentFiles('components'), ...componentFiles('app')].flatMap((file) =>
    iconBeforeTextHits(file, readFileSync(path.join(process.cwd(), file), 'utf8'), controls),
  );
}

test('the detector finds an icon before text and allows icon-only buttons', () => {
  expect(leadingIconHits('<button><Plus className="size-3" /> Add card</button>')).toEqual(['Add card']);
  expect(leadingIconHits('<button><RowIcon icon={X} size={12} />\n  Archive\n</button>')).toEqual([
    'Archive',
  ]);
  expect(
    leadingIconHits('<button><Trash2 className="size-3.5" />\n<span className="sr-only">Delete</span>'),
  ).toEqual([]);
});

test('the syntax-tree detector covers menus, spinners, wrappers, and responsive swaps', () => {
  const header =
    "import { Plus, Loader2, Mail } from 'lucide-react';\nimport { Ring } from '@/components/loading-ui/ring';\n";
  const hits = (body: string) =>
    iconBeforeTextHits(
      'x.tsx',
      `${header}export const X = () => (${body});`,
      new Set([...MENU_ITEMS, ...TEXT_CONTROLS]),
    ).map((hit) => `${hit.control}: ${hit.text}`);
  expect(hits('<DropdownMenuItem><Plus className="size-3.5" /> Add a drive</DropdownMenuItem>')).toEqual([
    'DropdownMenuItem: Add a drive',
  ]);
  expect(hits('<CommandItem><Mail /><span>Inbox</span></CommandItem>')).toEqual([
    'CommandItem: <span>Inbox</span>',
  ]);
  expect(hits('<Button>{busy ? <Ring /> : <Plus />}{label}</Button>')).toEqual(['Button: {label}']);
  expect(hits('<Button><span><Mail />{name}</span></Button>')).toEqual(['Button: {name}']);
  // Allowed: icon only, a word only, a hidden label, an aria-hidden badge, or a swap by width.
  expect(hits('<Button aria-label="Add"><Plus /></Button>')).toEqual([]);
  expect(hits('<Button>{busy ? "Saving…" : "Save"}</Button>')).toEqual([]);
  expect(hits('<button><Plus /><span className="sr-only">Add</span></button>')).toEqual([]);
  expect(hits('<button><Mail /><span aria-hidden>3</span></button>')).toEqual([]);
  expect(
    hits(
      '<Button><Plus className="size-4 sm:hidden" /><span className="hidden sm:inline">Add</span></Button>',
    ),
  ).toEqual([]);
  expect(
    hits('<Button><Plus className="size-4" /><span className="hidden sm:inline">Add</span></Button>'),
  ).toEqual(['Button: <span className="hidden sm:inline">Add</span>']);
  // A status line outside a control is not a button.
  expect(hits('<p role="status"><Loader2 /> Loading</p>')).toEqual([]);
});

test('reader, composer, inbox, settings, tasks, and files buttons have no leading icons', () => {
  const offenders = Object.entries(BUTTONS).flatMap(([file, texts]) =>
    leadingIconHits(readFileSync(path.join(process.cwd(), file), 'utf8'))
      .filter((hit) => texts.includes(hit))
      .map((hit) => `${file}: ${hit}`),
  );
  expect(offenders).toEqual([]);
});

test('no menu item in components or app pages puts an icon before its text', () => {
  expect(scan(MENU_ITEMS).map((hit) => `${hit.file}:${hit.line} ${hit.control}: ${hit.text}`)).toEqual([]);
});

test('no text button in components or app pages puts an icon before its text', () => {
  const offenders = scan(TEXT_CONTROLS)
    .filter((hit) => !KEPT[`${hit.file}: ${hit.text}`])
    .map((hit) => `${hit.file}:${hit.line} ${hit.control}: ${hit.text}`);
  expect(offenders).toEqual([]);
});

test('the calendar Today button does not use an all-caps month label', () => {
  const button = readFileSync(
    path.join(process.cwd(), 'components/calendar/engine/today-button.tsx'),
    'utf8',
  );
  expect(button).not.toContain('uppercase');
});
