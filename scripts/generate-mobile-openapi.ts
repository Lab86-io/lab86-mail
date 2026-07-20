import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mobileOpenAPIV1 } from '../lib/mobile/v1/openapi';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const document = `${JSON.stringify(mobileOpenAPIV1(), null, 2)}\n`;
const outputs = [
  path.join(root, 'docs/mobile/openapi/mobile-v1.json'),
  path.join(root, 'apps/ios/Packages/MobileAPI/Sources/MobileAPI/openapi.yaml'),
];

for (const output of outputs) {
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, document);
}

console.log(`Generated MobileContractV1 OpenAPI 3.1 in ${outputs.length} locations.`);
