/**
 * core/hash.ts — tiny non-cryptographic hash shared by the progress code.
 *
 * FNV-1a over UTF-16 code units, 32 bit, rendered as 8 lower-case hex digits. Used for the batch
 * `Idempotency-Key` (same operations -> same key across retries) and for the seed content version.
 * Not for anything security related. Pure, SSR-safe, no imports.
 */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}
