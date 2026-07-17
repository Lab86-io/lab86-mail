import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('Convex schema indexes', () => {
  test('uses unique index names within every table', () => {
    const schema = readFileSync(path.join(process.cwd(), 'convex/schema.ts'), 'utf8');
    const tableStarts = [...schema.matchAll(/^ {2}([a-zA-Z0-9_]+): defineTable\(/gm)];

    expect(tableStarts.length).toBeGreaterThan(10);

    for (const [position, tableStart] of tableStarts.entries()) {
      const tableName = tableStart[1];
      const nextTable = tableStarts[position + 1];
      const tableSource = schema.slice(tableStart.index, nextTable?.index ?? schema.length);
      const indexNames = [...tableSource.matchAll(/\.(?:index|searchIndex)\(\s*(['"])([^'"]+)\1/g)].map(
        (match) => match[2],
      );
      const duplicates = indexNames.filter((name, index) => indexNames.indexOf(name) !== index);

      expect([...new Set(duplicates)], `${tableName} has duplicate index names`).toEqual([]);
    }
  });
});
