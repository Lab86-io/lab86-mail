/**
 * Re-encrypt every stored secret under the current encryption key.
 *
 * DRY RUN BY DEFAULT. Without --apply it reads the encrypted fields, counts
 * them by key id, checks that the keyring opens each one, and writes nothing.
 * The output holds counts only, never a value.
 *
 * The fields come from lib/security/encrypted-fields.ts. The procedure is in
 * docs/encryption-key-rotation.md. Read it before you use --apply.
 *
 * Usage:
 *   bun scripts/rotate-encryption-key.ts
 *   bun scripts/rotate-encryption-key.ts --table providerGrants --page-size 50
 *   bun scripts/rotate-encryption-key.ts --apply
 *
 * Environment (the same values as the web service of the target deployment):
 *   NEXT_PUBLIC_CONVEX_URL (or CONVEX_URL), LAB86_CONVEX_INTERNAL_SECRET
 *   LAB86_MAIL_ENCRYPTION_KEY, LAB86_MAIL_ENCRYPTION_KEY_ID  the new key
 *   LAB86_MAIL_ENCRYPTION_KEYS  every older key that stored values still use
 */
import { api, convexMutation, convexQuery } from '../lib/hosted/convex';
import { encryptionKeyring } from '../lib/security/crypto';
import {
  assertRotationWriteFormat,
  formatRotationReport,
  type RotationStore,
  rotateEncryptedFields,
} from '../lib/security/key-rotation';

function parseArgs(argv: string[]) {
  const options = { apply: false, tables: [] as string[], pageSize: 100 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--table') options.tables.push(String(argv[++index] || ''));
    else if (arg === '--page-size') options.pageSize = Number(argv[++index]) || 100;
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: bun scripts/rotate-encryption-key.ts [--apply] [--table <name>]... [--page-size <n>]',
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
// Also for a dry run: with the v1 write format, its report hides values under retired keys.
assertRotationWriteFormat();
const keyring = encryptionKeyring();
console.log(`Keyring: current "${keyring.currentKeyId}", all [${[...keyring.keys.keys()].join(', ')}]`);

const store: RotationStore = {
  listPage: (input) => convexQuery(api.encryptionRotation.listEncryptedPage, input),
  replace: (input) => convexMutation(api.encryptionRotation.replaceEncryptedValue, input),
};

const report = await rotateEncryptedFields(store, options);
for (const line of formatRotationReport(report)) console.log(line);
const undecryptable = Object.values(report.fields).reduce((sum, field) => sum + field.undecryptable, 0);
if (undecryptable > 0) {
  console.log(`${undecryptable} value(s) did not open with this keyring. Do not retire a key yet.`);
  process.exitCode = 1;
}
if (!options.apply) console.log('Dry run: nothing was written. Add --apply to re-encrypt.');
