/**
 * Guard: in a scoped <style>, Vue compiles `:global(X) .y` to just `X` and drops `.y`, so the rule hits the
 * ancestor itself. In F7 that put a 2 px border, a mono font and 11.5 px text on <html data-lec-theme="datasheet">.
 * Write the descendant selector plainly (`[data-lec-theme='datasheet'] .y`): Vue scopes `.y`, the ancestor
 * needs no scope. `:global(...)` alone, as a whole selector, is still allowed.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(__dirname, '../../docs/.vitepress')
const skip = new Set(['dist', 'cache', '.temp', 'node_modules'])

function vueFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) vueFiles(p, out)
    else if (e.name.endsWith('.vue')) out.push(p)
  }
  return out
}

/** `:global(...)` followed (after whitespace) by more selector text on the same selector. */
const BROKEN = /:global\([^)]*\)[ \t]+[.#[a-zA-Z*:]/

describe('scoped styles never put a selector after :global(...)', () => {
  it('finds no `:global(X) .y` in any theme component', () => {
    const hits: string[] = []
    for (const file of vueFiles(root)) {
      const src = fs.readFileSync(file, 'utf8')
      for (const block of src.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)) {
        const start = src.slice(0, block.index).split('\n').length
        const css = block[1] ?? ''
        css.split('\n').forEach((line, i) => {
          if (BROKEN.test(line)) hits.push(`${path.relative(root, file)}:${start + i}: ${line.trim()}`)
        })
      }
    }
    expect(hits).toEqual([])
  })

  it('the pattern catches the F7 case and allows a whole-selector :global()', () => {
    expect(BROKEN.test(":global([data-lec-theme='datasheet']) .ai-selection-toolbar {")).toBe(true)
    expect(BROKEN.test(':global(.am-dim) .am-node:not(.on) { opacity: 0.3; }')).toBe(true)
    expect(BROKEN.test(':global(.vp-doc table) {')).toBe(false)
    expect(BROKEN.test(":global([data-lec-theme='datasheet'] .x) {")).toBe(false)
  })
})
