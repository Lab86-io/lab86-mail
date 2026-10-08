/**
 * Re-wrap every Passwords and IDs data key under the current secure KEK.
 *
 * DRY RUN BY DEFAULT. Without --apply it reads the wrapped keys, counts them by
 * KEK id, checks that the keyring opens each one, and writes nothing. The
 * output holds counts only, never a value.
 *
 * Procedure (docs/albatross-secure-store.md, "Storage and keys"):
 *   1. Make a new KEK: 32 random bytes, base64. Back it up before you use it.
 *   2. Set LAB86_SECURE_KEK to the new key and LAB86_SECURE_KEK_ID to a new id.
 *      Move the old key to LAB86_SECURE_KEKS as "oldId:oldKey".
 *   3. Run this script, then run it with --apply.
 *   4. When a dry run shows every item on the new id, remove the old key.
 *
 * Usage:
 *   bun scripts/rotate-secure-kek.ts
 *   bun scripts/rotate-secure-kek.ts --apply --page-size 50
 *
 * Environment (the same values as the web service of the target deployment):
 *   NEXT_PUBLIC_CONVEX_URL (or CONVEX_URL), LAB86_CONVEX_INTERNAL_SECRET,
 *   LAB86_SECURE_KEK, LAB86_SECURE_KEK_ID, LAB86_SECURE_KEKS
 */
import { api, convexMutation, convexQuery } from '../lib/hosted/convex';
import { secureKeyring } from '../lib/secure/crypto';
import {
  formatSecureRotationReport,
  rotateSecureKek,
  type SecureRotationStore,
} from '../lib/secure/rotation';

function parseArgs(argv: string[]) {
  const options = { apply: false, pageSize: 100 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--page-size') options.pageSize = Number(argv[++index]) || 100;
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: bun scripts/rotate-secure-kek.ts [--apply] [--page-size <n>]');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const keyring = secureKeyring();
if (!keyring) throw new Error('LAB86_SECURE_KEK is not set.');
console.log(`Keyring: current "${keyring.currentKeyId}", all [${[...keyring.keys.keys()].join(', ')}]`);

const store: SecureRotationStore = {
  listPage: (input) => convexQuery(api.secureDetails.rotationPage, input),
  rewrap: (input) => convexMutation(api.secureDetails.rewrap, { ...input, id: input.id as any }),
};

const report = await rotateSecureKek(store, options, keyring);
for (const line of formatSecureRotationReport(report)) console.log(line);
if (report.unopened > 0) {
  console.log(`${report.unopened} item(s) did not open with this keyring. Do not remove an old key yet.`);
  process.exitCode = 1;
}
if (!options.apply) console.log('Dry run: nothing was written. Add --apply to re-wrap.');
