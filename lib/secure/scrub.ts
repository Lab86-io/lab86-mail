// Removes saved values from text that a model reads (docs/albatross-secure-store.md).
//
// A run's browser layer holds a scrubber with the needles of every saved
// item (lib/secure/policy.ts scrubNeedles). Each page snapshot, page text,
// title, URL, and error the model reads passes through it first. The match is
// case-insensitive, longest needle first, so a grouped form wins over a part.

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class SecureScrubber {
  private readonly labels = new Map<string, string>();
  private pattern: RegExp | null = null;

  /** Add the needles of one item, shown as `[secure: <label>]`. */
  add(needles: readonly string[], label: string) {
    for (const needle of needles) {
      const key = needle.toLowerCase();
      if (needle.length >= 6 && !this.labels.has(key)) this.labels.set(key, label);
    }
    this.pattern = null;
  }

  get size() {
    return this.labels.size;
  }

  scrub(text: string): string {
    if (!text || !this.labels.size) return text;
    if (!this.pattern) {
      const keys = [...this.labels.keys()].sort((a, b) => b.length - a.length);
      this.pattern = new RegExp(keys.map(escapeRegExp).join('|'), 'gi');
    }
    return text.replace(
      this.pattern,
      (match) => `[secure: ${this.labels.get(match.toLowerCase()) ?? 'saved value'}]`,
    );
  }
}

/**
 * Hide the value of the fields a run typed a saved value into. In a Playwright
 * AI snapshot a field line looks like `- textbox "Number" [ref=e12]: D1234567`,
 * and a select keeps its choice on a child line marked `[selected]`. The value
 * after the colon and the selected marks under the field go.
 */
export function scrubTypedFields(snapshot: string, fields: ReadonlyMap<string, string>): string {
  if (!fields.size || !snapshot) return snapshot;
  const lines = snapshot.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const ref = line.match(/\[ref=((?:f\d+)?e\d+)\]/)?.[1];
    const label = ref ? fields.get(ref) : undefined;
    if (!label) continue;
    const marker = `[ref=${ref}]`;
    const at = line.indexOf(marker) + marker.length;
    const rest = line.slice(at);
    const colon = rest.indexOf(':');
    if (colon >= 0 && rest.slice(colon + 1).trim())
      lines[index] = `${line.slice(0, at)}${rest.slice(0, colon)}: [secure: ${label}]`;
    const indent = line.length - line.trimStart().length;
    for (let child = index + 1; child < lines.length; child += 1) {
      const childIndent = lines[child].length - lines[child].trimStart().length;
      if (lines[child].trim() && childIndent <= indent) break;
      lines[child] = lines[child].replace(/\s*\[selected\]/g, '');
    }
  }
  return lines.join('\n');
}
