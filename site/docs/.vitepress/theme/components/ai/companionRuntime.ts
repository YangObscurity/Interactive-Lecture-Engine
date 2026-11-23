/**
 * companionRuntime.ts — Runtime adapter resolution and capability matrix for the AI companion.
 *
 * Adapters (schema.ts + Plan B):
 *   - 'off'               -> companion UI, trigger button, SelectionToolbar, and BYOK section all absent
 *   - 'proxy'             -> mounts companion, talks to /api/ai/* (lecture-api), optional BYOK allowed
 *   - 'openai-compatible' -> mounts companion, reader BYOK key only (never calls /api/ai/* or AI health probe)
 */

export type CompanionAdapter = 'off' | 'proxy' | 'openai-compatible'

export interface CompanionCapabilities {
  adapter: CompanionAdapter
  enabled: boolean
  allowProxy: boolean
  allowByok: boolean
  showByokSection: boolean
}

const DEFAULT_ADAPTER: CompanionAdapter = 'off'

export function normalizeCompanionAdapter(raw: unknown): CompanionAdapter {
  if (raw === 'proxy') return 'proxy'
  if (raw === 'openai-compatible' || raw === 'byok') return 'openai-compatible'
  return 'off'
}

export function companionCapabilities(adapter: CompanionAdapter): CompanionCapabilities {
  if (adapter === 'proxy') {
    return {
      adapter: 'proxy',
      enabled: true,
      allowProxy: true,
      allowByok: true,
      showByokSection: true,
    }
  }
  if (adapter === 'openai-compatible') {
    return {
      adapter: 'openai-compatible',
      enabled: true,
      allowProxy: false,
      allowByok: true,
      showByokSection: true,
    }
  }
  return {
    adapter: 'off',
    enabled: false,
    allowProxy: false,
    allowByok: false,
    showByokSection: false,
  }
}

let activeAdapter: CompanionAdapter = DEFAULT_ADAPTER

export function resolveCompanionAdapterFromTheme(themeConfig: unknown): CompanionAdapter {
  if (!themeConfig || typeof themeConfig !== 'object') return 'off'
  const modules = (themeConfig as { lectureModules?: unknown }).lectureModules
  if (!modules || typeof modules !== 'object') return 'off'
  const companion = (modules as { companion?: unknown }).companion
  if (!companion || typeof companion !== 'object') return 'off'
  return normalizeCompanionAdapter((companion as { adapter?: unknown }).adapter)
}

/** Configure the singleton companion runtime from VitePress siteData.themeConfig. */
export function configureCompanion(themeConfig: unknown): CompanionCapabilities {
  activeAdapter = resolveCompanionAdapterFromTheme(themeConfig)
  return companionCapabilities(activeAdapter)
}

/** Set adapter directly (primarily for unit tests). */
export function setCompanionAdapter(raw: unknown): CompanionCapabilities {
  activeAdapter = normalizeCompanionAdapter(raw)
  return companionCapabilities(activeAdapter)
}

export function companionRuntime(): CompanionCapabilities {
  return companionCapabilities(activeAdapter)
}
