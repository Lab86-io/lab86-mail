import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// convex/_generated/api.d.ts is checked in and edited by hand, because
// `npx convex codegen` pushes to production in this repo. This test reads the
// file text and fails when it drifts from the modules in convex/.

const convexDir = path.join(import.meta.dir, '..', 'convex');
const apiTypesPath = path.join(convexDir, '_generated', 'api.d.ts');

// Convex does not put these files in the function API.
const NOT_API_MODULES = new Set(['schema', 'auth.config', 'convex.config']);

const FUNCTION_EXPORT =
  /^export const \w+\s*(?::[^=]+)?=\s*(?:query|mutation|action|internalQuery|internalMutation|internalAction|httpAction)\s*\(/m;

interface ConvexModule {
  name: string;
  hasFunctions: boolean;
}

interface ApiTypes {
  imports: Map<string, string>;
  entries: Map<string, string>;
}

function listConvexModules(dir: string, prefix = ''): ConvexModule[] {
  const modules: ConvexModule[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === '_generated' || entry.name === 'node_modules') continue;
      modules.push(...listConvexModules(path.join(dir, entry.name), `${prefix}${entry.name}/`));
      continue;
    }
    if (!/\.(ts|tsx|js)$/.test(entry.name) || entry.name.endsWith('.d.ts')) continue;
    const name = `${prefix}${entry.name.replace(/\.(ts|tsx|js)$/, '')}`;
    if (NOT_API_MODULES.has(name)) continue;
    const source = readFileSync(path.join(dir, entry.name), 'utf8');
    modules.push({ name, hasFunctions: hasConvexFunctions(source) });
  }
  return modules;
}

function hasConvexFunctions(source: string) {
  return FUNCTION_EXPORT.test(source);
}

function parseApiTypes(text: string): ApiTypes {
  const imports = new Map<string, string>();
  for (const match of text.matchAll(/^import type \* as (\w+) from "\.\.\/([^"]+)\.js";$/gm)) {
    imports.set(match[2], match[1]);
  }
  const entries = new Map<string, string>();
  const block = text.match(/declare const fullApi: ApiFromModules<\{([\s\S]*?)\}>;/);
  for (const match of (block?.[1] ?? '').matchAll(/^\s*(?:"([^"]+)"|(\w+)): typeof (\w+);$/gm)) {
    entries.set(match[1] ?? match[2], match[3]);
  }
  return { imports, entries };
}

function findApiTypeDrift(modules: ConvexModule[], api: ApiTypes) {
  const known = new Set(modules.map((module) => module.name));
  const named = new Set([...api.imports.keys(), ...api.entries.keys()]);
  const missing = modules
    .filter(
      (module) => module.hasFunctions && !(api.imports.has(module.name) && api.entries.has(module.name)),
    )
    .map((module) => module.name);
  const unknown = [...named].filter((name) => !known.has(name));
  const unmatched = [...named].filter((name) => {
    const alias = api.imports.get(name);
    return !alias || api.entries.get(name) !== alias;
  });
  return { missing: missing.sort(), unknown: unknown.sort(), unmatched: unmatched.sort() };
}

const apiText = (lines: { imports: string[]; entries: string[] }) =>
  [
    ...lines.imports,
    '',
    'declare const fullApi: ApiFromModules<{',
    ...lines.entries.map((line) => `  ${line}`),
    '}>;',
  ].join('\n');

describe('checked-in Convex API types', () => {
  test('list every Convex module that exports functions, and only modules that exist', () => {
    const modules = listConvexModules(convexDir);
    const api = parseApiTypes(readFileSync(apiTypesPath, 'utf8'));
    expect(modules.filter((module) => module.hasFunctions).length).toBeGreaterThan(40);
    expect(api.imports.size).toBeGreaterThan(40);
    expect(findApiTypeDrift(modules, api)).toEqual({ missing: [], unknown: [], unmatched: [] });
  });

  test('a module with functions that the file does not list is reported', () => {
    const api = parseApiTypes(
      apiText({
        imports: ['import type * as boards from "../boards.js";'],
        entries: ['boards: typeof boards;'],
      }),
    );
    expect(
      findApiTypeDrift(
        [
          { name: 'boards', hasFunctions: true },
          { name: 'newModule', hasFunctions: true },
          { name: 'helpers', hasFunctions: false },
        ],
        api,
      ),
    ).toEqual({ missing: ['newModule'], unknown: [], unmatched: [] });
  });

  test('a module that the file lists but that does not exist is reported', () => {
    const api = parseApiTypes(
      apiText({
        imports: [
          'import type * as boards from "../boards.js";',
          'import type * as removed from "../removed.js";',
        ],
        entries: ['boards: typeof boards;', 'removed: typeof removed;'],
      }),
    );
    expect(findApiTypeDrift([{ name: 'boards', hasFunctions: true }], api)).toEqual({
      missing: [],
      unknown: ['removed'],
      unmatched: [],
    });
  });

  test('an import without its entry, or an entry without its import, is reported', () => {
    const api = parseApiTypes(
      apiText({
        imports: ['import type * as boards from "../boards.js";', 'import type * as jev from "../jev.js";'],
        entries: ['boards: typeof boards;', 'mcp: typeof mcp;', '"nested/tasks": typeof nested_tasks;'],
      }),
    );
    expect(
      findApiTypeDrift(
        [
          { name: 'boards', hasFunctions: true },
          { name: 'jev', hasFunctions: true },
          { name: 'mcp', hasFunctions: true },
          { name: 'nested/tasks', hasFunctions: true },
        ],
        api,
      ),
    ).toEqual({
      missing: ['jev', 'mcp', 'nested/tasks'],
      unknown: [],
      unmatched: ['jev', 'mcp', 'nested/tasks'],
    });
  });

  test('function exports are found in every builder form, and helper modules are not', () => {
    expect(
      hasConvexFunctions('export const list = query({\n  args: {},\n  handler: async () => [],\n});'),
    ).toBe(true);
    expect(
      hasConvexFunctions('export const tick = internalAction({ args: {}, handler: async () => {} });'),
    ).toBe(true);
    expect(hasConvexFunctions('export const hook = httpAction(async () => new Response());')).toBe(true);
    expect(
      hasConvexFunctions('export const recordValidator = v.object({});\nexport function helper() {}'),
    ).toBe(false);
    expect(hasConvexFunctions('const hidden = query({ args: {}, handler: async () => null });')).toBe(false);
  });
});
