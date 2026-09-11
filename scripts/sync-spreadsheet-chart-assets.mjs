/** Same chart runtime used by the pinned Odoo demo, served from our own origin. */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const base = 'public/vendor/spreadsheet-charts';
const assets = [
  ['chart.js/dist/chart.umd.js', 'chart.umd.js'],
  ['chart.js/LICENSE.md', 'chart-LICENSE.md'],
  ['chartjs-chart-geo/build/index.umd.js', 'chart-geo.umd.js'],
  ['chartjs-chart-geo/LICENSE', 'chart-geo-LICENSE'],
  ['luxon/build/global/luxon.min.js', 'luxon.min.js'],
  ['luxon/LICENSE.md', 'luxon-LICENSE.md'],
  ['chartjs-adapter-luxon/dist/chartjs-adapter-luxon.umd.min.js', 'chart-luxon.umd.js'],
  ['chartjs-adapter-luxon/LICENSE.md', 'chart-luxon-LICENSE.md'],
];
await mkdir(base, { recursive: true });
const hashes = {};
for (const [source, target] of assets) {
  const content = await readFile(`node_modules/${source}`);
  await writeFile(`${base}/${target}`, content);
  hashes[target] = createHash('sha256').update(content).digest('hex');
}
const archive = 'public/vendor/o-spreadsheet/19.0.50/source.tar.gz';
const entry = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' })
  .split('\n')
  .find((path) => path.endsWith('/demo/lib/chart_js_treemap.js'));
const treemap = execFileSync('tar', ['-xOzf', archive, entry]);
await writeFile(`${base}/chart-treemap.js`, treemap);
hashes['chart-treemap.js'] = createHash('sha256').update(treemap).digest('hex');
const versions = {};
for (const name of ['chart.js', 'chartjs-chart-geo', 'luxon', 'chartjs-adapter-luxon'])
  versions[name] = JSON.parse(await readFile(`node_modules/${name}/package.json`, 'utf8')).version;
await writeFile(`${base}/manifest.json`, `${JSON.stringify({ versions, files: hashes }, null, 2)}\n`);
