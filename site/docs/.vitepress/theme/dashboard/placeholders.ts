/**
 * theme/dashboard/placeholders.ts — pure helpers behind the placeholder block editor (plan_v2_content_separation §8).
 *
 * A template is plain text with `{name}` tokens. In the editor a KNOWN token (one of the names the field allows)
 * is an unbreakable block; an unknown `{xxx}` stays text and is reported. Nothing here touches the DOM.
 */

export type PlaceholderName = 'lecture' | 'group' | 'outline' | 'selection' | 'lectures'

/** Which tokens each kind of field may use (prompts: F7 placeholders; home description: the lecture count). */
export const PLACEHOLDER_SETS = {
  prompts: ['lecture', 'group', 'outline', 'selection'],
  texts: ['lectures'],
} as const satisfies Record<string, readonly PlaceholderName[]>

export type Segment = { kind: 'text'; text: string } | { kind: 'token'; name: string }

const TOKEN_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g

/** Split a template into text runs and known-token blocks (unknown tokens stay inside the text). */
export function segmentTemplate(value: string, allowed: readonly string[]): Segment[] {
  const out: Segment[] = []
  let last = 0
  for (const m of value.matchAll(TOKEN_RE)) {
    const name = m[1] as string
    if (!allowed.includes(name)) continue
    const at = m.index ?? 0
    if (at > last) out.push({ kind: 'text', text: value.slice(last, at) })
    out.push({ kind: 'token', name })
    last = at + m[0].length
  }
  if (last < value.length) out.push({ kind: 'text', text: value.slice(last) })
  return out
}

/** Inverse of `segmentTemplate`. */
export function joinSegments(segments: readonly Segment[]): string {
  return segments.map((s) => (s.kind === 'token' ? `{${s.name}}` : s.text)).join('')
}

/** `{xxx}` tokens the field does not know (they are sent as typed, never replaced). */
export function unknownTokens(value: string, allowed: readonly string[]): string[] {
  const seen = new Set<string>()
  for (const m of value.matchAll(TOKEN_RE)) {
    const name = m[1] as string
    if (!allowed.includes(name)) seen.add(name)
  }
  return [...seen]
}

/** Known tokens a template uses. */
export function usedTokens(value: string, allowed: readonly string[]): string[] {
  const seen = new Set<string>()
  for (const m of value.matchAll(TOKEN_RE)) {
    const name = m[1] as string
    if (allowed.includes(name)) seen.add(name)
  }
  return [...seen]
}

/** Replace known tokens with sample values (the assembled-request preview of a quick action). */
export function fillTemplate(value: string, samples: Readonly<Record<string, string>>): string {
  return value.replace(TOKEN_RE, (all, name: string) => (name in samples ? (samples[name] as string) : all))
}

/** Move one item of a list (keyboard or drag reordering of quick actions). Out-of-range moves return the list unchanged. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) return [...list]
  const next = [...list]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item as T)
  return next
}
