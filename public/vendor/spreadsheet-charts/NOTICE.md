# Spreadsheet chart libraries

These independently served chart libraries match the dependencies in Odoo's
pinned spreadsheet source lockfile. Their copyright notices are retained in
the distributed scripts. [Exact versions and SHA-256 hashes](manifest.json).

- Chart.js 4.4.5 — [MIT license](chart-LICENSE.md), https://github.com/chartjs/Chart.js
- chartjs-chart-geo 4.3.6 — [MIT license](chart-geo-LICENSE), https://github.com/sgratzl/chartjs-chart-geo
- Luxon 3.5.0 — [MIT license](luxon-LICENSE.md), https://github.com/moment/luxon
- chartjs-adapter-luxon 1.3.1 — [MIT license](chart-luxon-LICENSE.md), https://github.com/chartjs/chartjs-adapter-luxon
- The treemap renderer is the unmodified `demo/lib/chart_js_treemap.js` from the
  [distributed Odoo source](/vendor/o-spreadsheet/19.0.50/source.tar.gz), carrying
  chartjs-chart-treemap 3.1.0's MIT copyright notice.

Reproduce these files with `node scripts/sync-spreadsheet-chart-assets.mjs`.
