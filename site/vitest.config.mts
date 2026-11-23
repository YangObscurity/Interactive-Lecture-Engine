import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

// Default environment is node; DOM tests opt in per file with
//   // @vitest-environment happy-dom
export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    globals: false,
    cache: false,
    setupFiles: ['tests/setup/storage.ts'],
  },
})
