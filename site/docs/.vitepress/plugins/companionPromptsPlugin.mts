/**
 * plugins/companionPromptsPlugin.mts — Vite virtual module (`virtual:lecture-prompts`) + dev HMR
 * + dist output emitter for site-managed companion prompts (WP-F7).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
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
