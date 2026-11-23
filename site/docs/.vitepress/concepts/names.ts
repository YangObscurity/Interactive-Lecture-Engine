/**
 * concepts/names.ts - Dependency-free concept name normalisation.
 *
 * Pure and lightweight so browser components (e.g. SelectionToolbar.vue) can match
 * selected text against concept names and aliases without pulling mdast into the bundle.
 */

/** Whitespace plus ASCII and CJK punctuation (Unicode P*, ASCII symbols, the CJK symbols block). */
export const NAME_NOISE = /[\s\p{P}\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e\u3000-\u303f]+/gu

/** NFKC, lower case, whitespace and punctuation removed. Two names that normalise equal are the same name. */
export function normalizeConceptName(name: string): string {
  return (name ?? '').normalize('NFKC').toLowerCase().replace(NAME_NOISE, '')
}
