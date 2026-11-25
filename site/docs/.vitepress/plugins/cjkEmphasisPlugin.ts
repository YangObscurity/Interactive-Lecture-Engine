/**
 * plugins/cjkEmphasisPlugin.ts — Fix CommonMark emphasis (`*` / `**`) next to CJK characters and punctuation.
 *
 * CommonMark 0.30+ treats `**text（info）**的` as non-right-flanking because the delimiter follows Unicode punctuation
 * (`）`) and precedes a non-whitespace CJK letter (`的`), leaving literal `**` in rendered output. Similarly,
 * `由**“核心”**` treats opening `**` after a CJK letter before punctuation as non-left-flanking. Extending `scanDelims`
 * strictly for `*` (`0x2A`) when adjacent to CJK characters resolves both without altering ASCII/code/math emphasis.
 */
interface MarkdownItLike {
  inline?: {
    State?: {
      prototype?: unknown
    }
  }
}

const PATCHED = Symbol('cjkEmphasisPatched')

function isWhiteSpace(code: number): boolean {
  if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0b || code === 0x0c) return true
  return code === 0xa0 || (code >= 0x2000 && code <= 0x200a) || code === 0x202f || code === 0x205f || code === 0x3000
}

function isCjkChar(code: number): boolean {
  return (
    (code >= 0x3040 && code <= 0x30ff) || // Hiragana & Katakana
    (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
    (code >= 0xac00 && code <= 0xd7af) || // Hangul Syllables
    (code >= 0xf900 && code <= 0xfaff) // CJK Compatibility Ideographs
  )
}

function charBefore(src: string, start: number): number {
  if (start <= 0) return 0x20
  let code = src.charCodeAt(start - 1)
  if ((code & 0xfc00) === 0xdc00 && start >= 2) {
    const hi = src.charCodeAt(start - 2)
    if ((hi & 0xfc00) === 0xd800) code = 0x10000 + ((hi - 0xd800) << 10) + (code - 0xdc00)
  }
  return code
}

function charAfter(src: string, start: number): number {
  const max = src.length
  let pos = start
  const marker = src.charCodeAt(start)
  while (pos < max && src.charCodeAt(pos) === marker) pos++
  if (pos >= max) return 0x20
  let code = src.charCodeAt(pos)
  if ((code & 0xfc00) === 0xd800 && pos + 1 < max) {
    const lo = src.charCodeAt(pos + 1)
    if ((lo & 0xfc00) === 0xdc00) code = 0x10000 + ((code - 0xd800) << 10) + (lo - 0xdc00)
  }
  return code
}

interface StateProtoLike {
  [PATCHED]?: boolean
  scanDelims(start: number, canSplitWord: boolean): { can_open: boolean; can_close: boolean; length: number }
}

export function cjkEmphasisPlugin(md: MarkdownItLike): void {
  const proto = md.inline?.State?.prototype as StateProtoLike | undefined
  if (!proto || proto[PATCHED]) return
  const origScanDelims = proto.scanDelims
  proto.scanDelims = function (this: { src: string }, start: number, canSplitWord: boolean) {
    const res = origScanDelims.call(this, start, canSplitWord)
    if (this.src.charCodeAt(start) !== 0x2a) return res // only `*` / `**`; never touch `_`
    const prev = charBefore(this.src, start)
    const next = charAfter(this.src, start)
    if (!res.can_open && !isWhiteSpace(next) && isCjkChar(prev)) {
      res.can_open = true
    }
    if (!res.can_close && !isWhiteSpace(prev) && isCjkChar(next)) {
      res.can_close = true
    }
    return res
  }
  proto[PATCHED] = true
}
