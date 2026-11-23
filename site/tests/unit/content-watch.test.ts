/**
 * S4a: `npm run dev` starts the content watcher in content mode (contentWatchPlugin.mts).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveContent } from '../../docs/.vitepress/content/paths.mts'
import { contentWatchPlugin, stopContentWatch } from '../../docs/.vitepress/plugins/contentWatchPlugin.mts'

const SITE_DIR = path.resolve(__dirname, '../..')
const REPO_ROOT = path.resolve(SITE_DIR, '..')
const TEMPLATE_DIR = path.join(REPO_ROOT, 'templates', 'content')

const tempRoots: string[] = []
function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempRoots.push(d)
  return d
}
afterEach(() => {
  while (tempRoots.length > 0) fs.rmSync(tempRoots.pop() as string, { recursive: true, force: true })
})

/** A repo skeleton whose `templates/content` is a copy of the real template. */
function repoWithTemplate(): string {
  const root = tmp('s4-repo-')
  fs.mkdirSync(path.join(root, 'site', 'docs', '.vitepress'), { recursive: true })
  fs.cpSync(TEMPLATE_DIR, path.join(root, 'templates', 'content'), { recursive: true })
  return root
}

describe('npm run dev watches the content folder', () => {
  type Hook = (server: unknown) => Promise<void>
  function fakeServer() {
    const closers: (() => void)[] = []
    const errors: string[] = []
    return {
      errors,
      close: () => closers.forEach((c) => c()),
      server: {
        config: { logger: { error: (m: string) => errors.push(m) } },
        httpServer: { once: (_ev: string, cb: () => void) => closers.push(cb) },
      },
    }
  }

  it('starts one watcher in content mode, replaces it on a restart and stops it with the server', async () => {
    const content = tmp('s4-watch-')
    fs.writeFileSync(path.join(content, 'groups.ts'), 'export const GROUPS = []\n')
    const started: string[] = []
    let closed = 0
    const start = (async (o: { contentPaths?: { root: string } }) => {
      started.push(o.contentPaths?.root ?? '')
      return { close: () => void closed++ }
    }) as never
    const env = { LECTURE_CONTENT_DIR: content }
    const a = fakeServer()
    await (contentWatchPlugin({ env, start }).configureServer as unknown as Hook)(a.server)
    expect(started).toEqual([path.resolve(content)])
    const b = fakeServer()
    await (contentWatchPlugin({ env, start }).configureServer as unknown as Hook)(b.server)
    expect(started).toHaveLength(2)
    expect(closed).toBe(1)
    a.close() // the old server closing does not stop the new watcher
    expect(closed).toBe(1)
    b.close()
    expect(closed).toBe(2)
    stopContentWatch()
  })

  it('does nothing in in-place mode or with LECTURE_CONTENT_WATCH=0, and logs a refused first sync', async () => {
    const content = tmp('s4-watch-')
    fs.writeFileSync(path.join(content, 'groups.ts'), 'export const GROUPS = []\n')
    let calls = 0
    const start = (async () => {
      calls++
      throw new Error('Refusing to overwrite locally modified file')
    }) as never
    const repo = repoWithTemplate()
    const s = fakeServer()
    await (contentWatchPlugin({ env: { LECTURE_CONTENT_DIR: content, LECTURE_CONTENT_WATCH: '0' }, start }).configureServer as unknown as Hook)(s.server)
    expect(calls).toBe(0)
    expect(resolveContent({ repoRoot: repo, env: {} }).mode).toBe('in-place')
    await (contentWatchPlugin({ env: { LECTURE_CONTENT_DIR: content }, start }).configureServer as unknown as Hook)(s.server)
    expect(calls).toBe(1)
    expect(s.errors.join('\n')).toMatch(/locally modified/)
    stopContentWatch()
  })

  it('is registered for the dev server only', () => {
    expect(contentWatchPlugin().apply).toBe('serve')
  })
})
