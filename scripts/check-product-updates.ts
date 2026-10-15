import { existsSync } from 'node:fs';
import { PRODUCT_UPDATES } from '../lib/updates/feed';

for (const update of PRODUCT_UPDATES) {
  if (
    update.preview &&
    'image' in update.preview &&
    !existsSync(new URL(`../public${update.preview.image}`, import.meta.url))
  ) {
    throw new Error(`Screenshot missing for ${update.id}: ${update.preview.image}`);
  }
}

console.log(`Validated ${PRODUCT_UPDATES.length} product update batches.`);
