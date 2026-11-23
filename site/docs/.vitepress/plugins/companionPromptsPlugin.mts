/**
 * plugins/companionPromptsPlugin.mts — Vite virtual module (`virtual:lecture-prompts`) + dev HMR
 * + dist output emitter for site-managed companion prompts (WP-F7).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { Plugin } from 'vite'
import { AI_PROMPTS } from '../site.config.mts'
import { PROMPT_LIMITS } from '../prompts/companion.ts'
import { loadAndValidateSitePrompts } from '../prompts/load.mts'

export const VIRTUAL_PROMPTS_ID = 'virtual:lecture-prompts'
const RESOLVED_VIRTUAL_PROMPTS_ID = '\0virtual:lecture-prompts'

function renderVirtualPromptsModule(): string {
  const loaded = loadAndValidateSitePrompts()
  return [
    `export const COMPANION_PROMPTS = ${JSON.stringify(loaded.prompts)};`,
    `export const PROMPT_LIMITS = ${JSON.stringify(PROMPT_LIMITS)};`,
    '',
  ].join('\n')
}

export function emitCompanionPromptsDist(outDir: string): string {
  const loaded = loadAndValidateSitePrompts()
  const dest = resolve(outDir, AI_PROMPTS.distRelativePath)
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, JSON.stringify(loaded.prompts, null, 2) + '\n', 'utf8')
  return dest
}

/**
 * The Dashboard writes prompts/companion.json itself (dev API) and already holds the saved file: the watcher must not
 * answer its own write with a full page reload (that dropped the "saved as vN" status and every other unsaved draft on
 * the page, audit-dashboard #1). The dev API records the text it wrote; a change event whose file text is exactly that
 * only invalidates the virtual module (the next real page load reads the new file). Edits from anywhere else (an
 * editor, git checkout, content:watch) still reload. Kept on globalThis: VitePress restarts re-evaluate this module.
 */
const SELF_WRITE_KEY = Symbol.for('lecture.companionPrompts.selfWrite')
type SelfWriteSlot = { [SELF_WRITE_KEY]?: { path: string; text: string } }

export function notePromptsSelfWrite(filePath: string, text: string): void {
  ;(globalThis as SelfWriteSlot)[SELF_WRITE_KEY] = { path: resolve(filePath), text }
}

/** Pure decision for the watcher: true when the changed file is the Dashboard's own last write (no reload). */
export function isPromptsSelfWrite(filePath: string, text: string | null): boolean {
  const last = (globalThis as SelfWriteSlot)[SELF_WRITE_KEY]
  return !!last && text !== null && last.path === resolve(filePath) && last.text === text
}

function readText(p: string): string | null {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

export function companionPromptsPlugin(): Plugin {
  const loaded = loadAndValidateSitePrompts()
  const watchedPath = resolve(loaded.filePath)

  return {
    name: 'lecture-companion-prompts',
    resolveId(id) {
      if (id === VIRTUAL_PROMPTS_ID) return RESOLVED_VIRTUAL_PROMPTS_ID
      return null
    },
    load(id) {
      if (id === RESOLVED_VIRTUAL_PROMPTS_ID) {
        return renderVirtualPromptsModule()
      }
      return null
    },
    configureServer(server) {
      server.watcher.add(watchedPath)
      const onChange = (changedFile: string) => {
        if (resolve(changedFile) !== watchedPath) return
        try {
          loadAndValidateSitePrompts()
          const mod = server.moduleGraph.getModuleById(RESOLVED_VIRTUAL_PROMPTS_ID)
          if (mod) server.moduleGraph.invalidateModule(mod)
          if (isPromptsSelfWrite(watchedPath, readText(watchedPath))) return
          server.ws.send({ type: 'full-reload' })
        } catch (err) {
          console.error('[lecture-companion-prompts] reload aborted:', err)
        }
      }
      server.watcher.on('change', onChange)
      server.watcher.on('add', onChange)
    },
  }
}
