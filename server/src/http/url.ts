/**
 * Drop every trailing `/` of a base URL or path. A loop instead of `s.replace(/\/+$/, '')`: that pattern is tried at
 * every `/` of the string and costs quadratic time on a long run of slashes that does not end the string (CodeQL
 * js/polynomial-redos). Used for configured API bases and request paths.
 */
export function trimTrailingSlashes(s: string): string {
  let end = s.length
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* '/' */) end--
  return end === s.length ? s : s.slice(0, end)
}
