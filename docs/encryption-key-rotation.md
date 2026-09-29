# Encryption key rotation

The app encrypts stored secrets with AES-256-GCM in `lib/security/crypto.ts`. The secrets are
mailbox tokens, file and tool credentials, user model keys, and short OAuth transaction rows. The
full list of Convex fields is in `lib/security/encrypted-fields.ts`.

## Formats

- `v1.<iv>.<tag>.<ciphertext>`: the old format. It has no key id.
- `v2.<kid>.<iv>.<tag>.<ciphertext>`: the current format. The key id is authenticated data, so a
  changed key id fails the tag check.

`decryptSecret` reads both formats. `encryptSecret` writes `v2`. It writes `v1` only while
`LAB86_MAIL_ENCRYPTION_WRITE_FORMAT=v1` is set.

## Keyring variables

| Variable | Use |
| --- | --- |
| `LAB86_MAIL_ENCRYPTION_KEY` | The key for new writes. The meaning did not change. |
| `LAB86_MAIL_ENCRYPTION_KEY_ID` | The id of that key. Default: `k1`. |
| `LAB86_MAIL_ENCRYPTION_KEYS` | Optional. Retired keys that only decrypt, as `id:key,id:key`. |
| `LAB86_MAIL_ENCRYPTION_WRITE_FORMAT` | Optional. Unset or `v2`: new writes are `v2`. `v1` keeps new writes in the old format. Case and outer spaces do not count. Other values stop each write with an error. |

A key is 32 bytes in base64 (recommended: `openssl rand -base64 32`). Any other string becomes a
key through SHA-256. A key id has 1 to 32 letters, digits, `_`, or `-`. The ids `v1` and `v2` are
not permitted.

With only `LAB86_MAIL_ENCRYPTION_KEY` set, the keyring holds one key with the id `k1`. The first
deploy of this code needs no variable change. A `v1` value names no key, so the app tries each key
in the ring on it. The tag check rejects a wrong key.

## Rollback safety

A build before this change reads `v1` only. After this deploy, new writes are `v2`. If you think
that you will roll back to an older build, set `LAB86_MAIL_ENCRYPTION_WRITE_FORMAT=v1` before the
deploy. Remove it when the rollback window closes. Do not rotate a key while it is set. The
script stops while it is set, also for a dry run. With this format, all `v1` values count as
current, so the report cannot show the values that need an old key.

The default is `v2`, so each new value names its key id. The writes and the rotation guard read
the variable through one function (`encryptionWriteFormat`), so they always agree. A value that
is not `v1` or `v2` stops the writes and the rotation with an error. Thus a typing error cannot
write `v2` while a rollback window is open.

## Procedure

Do these steps for one environment at a time. Start with staging. Keep the old key until step 6.

1. Make a new key and choose a new id (for example `k2`).
2. On the Railway `web` service, set:
   - `LAB86_MAIL_ENCRYPTION_KEYS=k1:<old key>` (add all other retired keys that are still in use).
   - `LAB86_MAIL_ENCRYPTION_KEY=<new key>`.
   - `LAB86_MAIL_ENCRYPTION_KEY_ID=k2`.
3. Redeploy. New writes now use `k2`. Old values still open with `k1`.
4. On an operator machine, export the same variables, `NEXT_PUBLIC_CONVEX_URL`, and
   `LAB86_CONVEX_INTERNAL_SECRET` of that environment. Then do a dry run:
   `bun scripts/rotate-encryption-key.ts`. The output shows the count of values for each field
   and key id. It shows no value. The count of values that do not open must be zero.
5. Re-encrypt: `bun scripts/rotate-encryption-key.ts --apply`. Each write is a compare and set on
   the value that the script read, so a concurrent app write is kept. Run the dry run again. All
   values must show `k2`, and no value must show `v1` or `k1`.
6. Remove `k1:<old key>` from `LAB86_MAIL_ENCRYPTION_KEYS` and redeploy.

Values in short-lived rows (OAuth states and completions) expire in minutes. If they show the old
key, wait ten minutes and do the dry run again.

## When you add an encrypted field

Add it to `ENCRYPTED_FIELDS` in `lib/security/encrypted-fields.ts` in the same change.
`tests/encryption-key-rotation.test.ts` fails when `convex/schema.ts` has a field whose name
contains `Encrypted` (or starts with `encrypted`) that is not in the list.
