/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, unknown>
  export default component
}

/** plugins/lectureThemePlugin.mts — fonts + theme.css + compiled tokens of the enabled theme packs. */
declare module 'virtual:lecture-theme' {
  import type { ThemeRuntime } from './docs/.vitepress/theme/tokens/prefs'
  export const THEME_RUNTIME: ThemeRuntime
}
declare module 'virtual:lecture-theme.css'

/** plugins/lectureThemePlugin.mts (P2e) - slot components of the enabled themes; see theme/slots/runtime.ts. */
declare module 'virtual:lecture-components' {
  import type { Component } from 'vue'
  export const SLOT_DEFAULT_THEME: string
  /** P4a WP-H3: `layout` of every enabled theme (theme.json `layout.edges`, default `curve`). */
  export const THEME_LAYOUT: Record<string, { edges: import('./docs/.vitepress/theme/slots/contract.ts').LayoutEdgeStyle }>
  export const SLOT_STATIC: Partial<Record<import('./docs/.vitepress/theme/slots/contract.ts').SlotName, { impl: string; component: Component }>>
  export const SLOT_COMPONENTS: Record<
    string,
    Partial<Record<import('./docs/.vitepress/theme/slots/contract.ts').SlotName, { impl: string; load: () => Promise<Component> }>>
  >
}

/** plugins/companionPromptsPlugin.mts (WP-F7) — site-owned versioned AI system prompt and quick actions. */
declare module 'virtual:lecture-prompts' {
  import type { CompanionPromptsFile, PROMPT_LIMITS as PromptLimitsType } from './docs/.vitepress/prompts/companion.ts'
  export const COMPANION_PROMPTS: CompanionPromptsFile
  export const PROMPT_LIMITS: typeof PromptLimitsType
}

/** VitePress internals the sidebar item override imports (dist ships no types for them). */
declare module 'vitepress/dist/client/theme-default/composables/sidebar.js' {
  import type { ComputedRef, Ref } from 'vue'
  import type { DefaultTheme } from 'vitepress/theme'
  export function useSidebarControl(item: ComputedRef<DefaultTheme.SidebarItem>): {
    collapsed: Ref<boolean>
    collapsible: ComputedRef<boolean>
    isLink: ComputedRef<boolean>
    isActiveLink: Ref<boolean>
    hasActiveLink: ComputedRef<boolean>
    hasChildren: ComputedRef<boolean>
    toggle: () => void
  }
}

interface ImportMetaEnv {
  /** '1' enables the AI sidebar mock backend (no network). */
  readonly VITE_AI_MOCK?: string
  /** '1' enables lecture debug overlays / verbose logging. */
  readonly VITE_LECTURE_DEBUG?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
