# Odoo Spreadsheet in Albatross

This editor uses **o-spreadsheet 19.0.50** by Odoo (LGPL-3.0-or-later) and
**Owl 2.8.2** by Odoo (LGPL-3.0-only). These libraries are distributed as separate
JavaScript modules, not incorporated into Albatross's application chunks.

- [o-spreadsheet license](LICENSE) and [copyright notice](COPYRIGHT)
- [Complete corresponding o-spreadsheet source](source.tar.gz), commit `e4992587245f832c0dbf361b1f23f14b74613d4e`
- [Owl license](/vendor/owl/2.8.2/LICENSE)
- [Complete corresponding Owl source](/vendor/owl/2.8.2/source.tar.gz), commit `54129a5f8dfc1ce16c62ee2f216058c043043a6e`
- [Runtime/source hashes](manifest.json)
- [Chart renderer licenses](/vendor/spreadsheet-charts/NOTICE.md)
- [Bootstrap MIT license](BOOTSTRAP-LICENSE), version 5.3.3
- [Font Awesome licenses](/vendor/font-awesome-4.7.0/LICENSES.txt), version 4.7.0

Upstream repositories: https://github.com/odoo/o-spreadsheet and https://github.com/odoo/owl.

## Modification and replacement

The only change to the shipped o-spreadsheet JavaScript module is replacing its
bare `@odoo/owl` import with `/vendor/owl/2.8.2/dist/owl.es.js`. Its application
logic is unchanged. Bootstrap utilities are filtered and scoped to
`.albatross-sheet-frame`; the generated stylesheet identifies this modification.

To rebuild a library, unpack its corresponding source archive in a separate
directory, install the dependencies using its checked-in lockfile and supported
Node version, then run its documented build script (`npm run build` for
o-spreadsheet; `npm run build` for Owl). See each archive's package.json and
README for build prerequisites. For o-spreadsheet, apply the one import-path
replacement above to the generated ESM bundle. Retain the license notices.

To run a compatible modified version, replace only these independently served
modules/assets on your installation (or use a browser's local network-response
overrides for these URLs):

- `/vendor/o-spreadsheet/19.0.50/dist/o_spreadsheet.esm.js`
- `/vendor/o-spreadsheet/19.0.50/dist/o_spreadsheet.xml`
- `/vendor/o-spreadsheet/19.0.50/dist/o_spreadsheet.css`
- `/vendor/owl/2.8.2/dist/owl.es.js`

The app imports these URLs at runtime, so no Albatross source or app rebuild is
needed to replace the libraries with compatible modified copies. Preserve the
19.0.50 public API and version marker, or update the adapter's version pin when
developing an incompatible version. Clear the browser cache after replacement.
The root repository's `scripts/sync-odoo-spreadsheet-assets.mjs` reproduces the
asset copies, import-path replacement, scoped Bootstrap rules, and manifest.

No warranty is provided for these libraries. The supplied licenses govern their
use and redistribution; this notice does not replace those licenses or provide
a legal opinion about other distribution arrangements.
