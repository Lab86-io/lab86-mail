const GRID_NUMBER_FORMATS = {
  text: '@',
  number: '#,##0.00',
  currency: '$#,##0.00',
  percent: '0.00%',
  date: 'yyyy-mm-dd',
};
function constantTextFormula(value) {
  // Odoo's formula parser does not use Excel's doubled-quote escaping. CHAR
  // segments work in both engines, including trailing backslashes/newlines,
  // and never allow user text to become executable expression syntax.
  return `=${value
    .split(/(["\\\r\n])/u)
    .filter(Boolean)
    .map((part) => (/^["\\\r\n]$/u.test(part) ? `CHAR(${part.charCodeAt(0)})` : `"${part}"`))
    .join('&')}`;
}
/** Upgrade a version 1 grid without reinterpreting literal values as formulas. */
export function workbookDataFromGrid(engine, grid) {
  const data = engine.helpers.createEmptyWorkbookData(grid.sheets[0]?.name || 'Sheet1');
  const formats = {};
  const formatIds = new Map();
  data.sheets = grid.sheets.map((tab) => {
    const sheet = engine.helpers.createEmptySheet(tab.id, tab.name);
    const cells = {};
    const sheetFormats = {};
    for (const [address, cell] of Object.entries(tab.cells)) {
      const isLiteralString = !cell.formula && typeof cell.value === 'string';
      const format = cell.format ? GRID_NUMBER_FORMATS[cell.format] : isLiteralString ? '@' : undefined;
      const xc = address.toUpperCase();
      if (format) {
        let id = formatIds.get(format);
        if (!id) {
          id = formatIds.size + 1;
          formatIds.set(format, id);
          formats[id] = format;
        }
        sheetFormats[xc] = id;
      }
      let content = cell.formula ? `=${cell.formula.replace(/^=/u, '')}` : cell.value;
      if (content === undefined || content === '') continue;
      if (isLiteralString && (String(content).startsWith('=') || format !== '@')) {
        // Odoo treats '=' as formula even with text formatting, and numeric
        // formats otherwise parse numeric-looking strings. A constant-string
        // expression preserves the exact typed value without executing it.
        content = constantTextFormula(String(content));
      }
      cells[xc] = String(content);
    }
    return {
      ...sheet,
      colNumber: Math.max(sheet.colNumber, tab.columnCount),
      rowNumber: Math.max(sheet.rowNumber, tab.rowCount),
      cells,
      formats: sheetFormats,
    };
  });
  data.formats = formats;
  return data;
}
