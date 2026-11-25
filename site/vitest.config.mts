import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

function virtualModulesPlugin() {
  return {
    name: 'vitest-virtual-modules',
    resolveId(id: string) {
      if (id === 'virtual:lecture-theme' || id === 'virtual:lecture-theme.css') {
        return '\0' + id
      }
    },
    load(id: string) {
      if (id === '\0virtual:lecture-theme') {
        return `export const THEME_RUNTIME = {
  defaultTheme: 'reader',
  defaultTint: 'paper',
  defaultBase: 'paper',
  themes: [{ id: 'reader', label: 'Reader', tints: ['paper', 'sepia', 'dark'] }],
};`
      }
      if (id === '\0virtual:lecture-theme.css') {
        return ''
      }
    },
  }
}

// Default environment is node; DOM tests opt in per file with
//   // @vitest-environment happy-dom
export default defineConfig({
  plugins: [vue(), virtualModulesPlugin()],
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    globals: false,
    cache: false,
    setupFiles: ['tests/setup/storage.ts'],
  },
})
