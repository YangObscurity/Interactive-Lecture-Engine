/**
 * S6 decision B, dev project: scripts/dev_e2e.mjs runs `vitepress dev` with LECTURE_CONTENT_DIR at the throw-away demo
 * copy (site/.e2e-demo/content). That copy is a content folder of its own, not the read-only demo fallback: the
 * Dashboard's writes and concept drafting stay open and land in the copy, never in templates/demo-content.
 */
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveContent } from '../../docs/.vitepress/content/paths.mts'
import { demoEnv, E2E_CONTENT_COPY, E2E_CONTENT_DIR, E2E_ROOT } from '../../scripts/build_e2e.mjs'
import { DEV_STATE_FILE } from '../../scripts/dev_e2e.mjs'

describe('dev e2e server content', () => {
  it('runs on the demo copy as a content folder of its own (writes open, not demo: true)', () => {
    const env = demoEnv()
    expect(env.LECTURE_CONTENT_DIR).toBe(E2E_CONTENT_COPY)
    const paths = resolveContent({ env })
    expect(paths.mode).toBe('content')
    expect(paths.root).toBe(E2E_CONTENT_COPY)
    expect(paths.demo).not.toBe(true)
    expect(path.relative(E2E_CONTENT_DIR, paths.siteTexts).startsWith('..')).toBe(true)
  })

  it('keeps its state file in the git-ignored e2e folder', () => {
    expect(path.dirname(DEV_STATE_FILE)).toBe(E2E_ROOT)
  })
})
