/** Generate contracts from the exact source distributed with the pinned engine. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import ts from 'typescript';

const manifest = JSON.parse(readFileSync('public/vendor/o-spreadsheet/19.0.50/manifest.json', 'utf8'));
const dir = mkdtempSync(resolve(tmpdir(), 'albatross-sheet-contract-'));
try {
  execFileSync('tar', [
    '-xzf',
    'public/vendor/o-spreadsheet/19.0.50/source.tar.gz',
    '-C',
    dir,
    '--strip-components=1',
  ]);
  const path = resolve(dir, 'src/types/commands.ts');
  const program = ts.createProgram([path], {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext,
  });
  const checker = program.getTypeChecker();
  const file = program.getSourceFile(path);
  const definitions = {};
  const seen = new Map();
  function schema(type) {
    // Upstream uses branded string/number aliases for IDs and pixel positions.
    // Their JSON representation is the primitive, without the compile-time brand.
    if (type.isIntersection()) {
      const primitive = type.types.find((t) => t.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike));
      if (primitive) return schema(primitive);
    }
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return {};
    if (type.flags & ts.TypeFlags.Never) return false;
    if (type.isStringLiteral() || type.isNumberLiteral()) return { const: type.value };
    if (type.flags & ts.TypeFlags.BooleanLiteral) return { const: type.intrinsicName === 'true' };
    if (type.flags & ts.TypeFlags.String) return { type: 'string' };
    if (type.flags & ts.TypeFlags.Number) return { type: 'number' };
    if (type.flags & ts.TypeFlags.Null) return { type: 'null' };
    if (type.isUnion())
      return { anyOf: type.types.filter((t) => !(t.flags & ts.TypeFlags.Undefined)).map(schema) };
    if (checker.isArrayType(type)) return { type: 'array', items: schema(checker.getTypeArguments(type)[0]) };
    if (checker.isTupleType(type))
      return { type: 'array', items: checker.getTypeArguments(type).map(schema), additionalItems: false };
    if (seen.has(type)) return { $ref: `#/$defs/${seen.get(type)}` };
    const name = `T${seen.size}`;
    seen.set(type, name);
    const properties = {};
    const required = [];
    for (const property of checker.getPropertiesOfType(type)) {
      if (property.name.startsWith('__@')) continue;
      const declaration = property.valueDeclaration || property.declarations?.[0];
      const value = checker.getTypeOfSymbolAtLocation(property, declaration || file);
      if (value.getCallSignatures().length) continue;
      properties[property.name] = schema(value);
      const description = ts.displayPartsToString(property.getDocumentationComment(checker));
      if (description && typeof properties[property.name] === 'object')
        properties[property.name] = { ...properties[property.name], description };
      if (
        !(property.flags & ts.SymbolFlags.Optional) &&
        !(value.isUnion() && value.types.some((t) => t.flags & ts.TypeFlags.Undefined))
      )
        required.push(property.name);
    }
    const index = checker.getIndexTypeOfType(type, ts.IndexKind.String);
    definitions[name] = {
      type: 'object',
      properties,
      required,
      additionalProperties: index ? schema(index) : false,
    };
    return { $ref: `#/$defs/${name}` };
  }
  // Session/history/rendering commands do not author workbook content. All core
  // commands and the editing helpers remain available, including sort/autofill.
  const omitted = new Set([
    'UNDO',
    'REDO',
    'REQUEST_UNDO',
    'REQUEST_REDO',
    'START',
    'EVALUATE_CELLS',
    'EVALUATE_CHARTS',
    'START_CHANGE_HIGHLIGHT',
    'CLEAN_CLIPBOARD_HIGHLIGHT',
    'RESIZE_SHEETVIEW',
    'SET_VIEWPORT_OFFSET',
    'MOVE_VIEWPORT_DOWN',
    'MOVE_VIEWPORT_UP',
    'MOVE_VIEWPORT_TO_CELL',
    'SELECT_FIGURE',
    'PIVOT_START_PRESENCE_TRACKING',
    'PIVOT_STOP_PRESENCE_TRACKING',
    'PASTE_FROM_OS_CLIPBOARD',
  ]);
  const commands = {};
  for (const kind of ['CoreCommand', 'LocalCommand']) {
    const node = file.statements.find((n) => ts.isTypeAliasDeclaration(n) && n.name.text === kind);
    for (const type of checker.getTypeAtLocation(node).types) {
      const tag = type.getProperty('type');
      const name = checker.getTypeOfSymbolAtLocation(tag, tag.valueDeclaration).value;
      if (omitted.has(name)) continue;
      commands[name] = { kind: kind === 'CoreCommand' ? 'core' : 'local', schema: schema(type) };
    }
  }
  const functions = readdirSync(resolve(dir, 'src/functions'))
    .filter((name) => /^module_.*\.ts$/.test(name))
    .flatMap((name) =>
      [
        ...readFileSync(resolve(dir, 'src/functions', name), 'utf8').matchAll(
          /export const ([A-Z][A-Z0-9_]*)\s*=/g,
        ),
      ].map((match) => match[1].replaceAll('_', '.')),
    )
    .sort();
  const output = {
    version: manifest.version,
    commit: manifest.sources.spreadsheet.commit,
    commands,
    functions,
    $defs: definitions,
  };
  writeFileSync('lib/documents/spreadsheet-command-catalog.json', `${JSON.stringify(output, null, 2)}\n`);
  console.log(
    `Generated ${Object.keys(commands).length} commands, ${Object.keys(definitions).length} definitions.`,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
