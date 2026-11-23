// ESLint flat config (non-type-aware for speed).
// - V2 folders: strict (errors).
// - Legacy V1 code: same rule set downgraded to warnings, so `npm run lint` exits 0 today.
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import pluginVue from 'eslint-plugin-vue'
import vueParser from 'vue-eslint-parser'

const V2_DIRS = ['core', 'api', 'progress', 'auth', 'access', 'charts', 'reading', 'pinout', 'home', 'group', 'ai2', 'debug', 'tokens', 'slots', 'curriculum', 'map', 'search']
const V2_FILES = [
  ...V2_DIRS.map((d) => `docs/.vitepress/theme/${d}/**/*.{ts,mts,vue}`),
  'docs/.vitepress/site.config.mts',
  'docs/.vitepress/lecture-config.mts',
  'docs/.vitepress/content/**/*.{ts,mts}',
  'docs/.vitepress/i18n/**/*.ts',
  'docs/.vitepress/access/**/*.{ts,mts}',
  'docs/.vitepress/curriculum/**/*.{ts,mts}',
  'docs/.vitepress/search/**/*.{ts,mts}',
  'docs/.vitepress/prompts/**/*.{ts,mts}',
  'docs/.vitepress/concepts/**/*.{ts,mts}',
  'docs/.vitepress/config.v2.mts',
  'docs/.vitepress/plugins/lectureThemePlugin.mts',
  'docs/.vitepress/plugins/companionPromptsPlugin.mts',
  'docs/.vitepress/plugins/conceptLinkPlugin.mts',
  'docs/.vitepress/plugins/conceptsPlugin.mts',
  'docs/.vitepress/plugins/dashboardDevPlugin.mts',
  'docs/.vitepress/plugins/contentWatchPlugin.mts',
  'scripts/content/**/*.{ts,mts}',
  'lecture.config.ts',
  'tests/**/*.{ts,mts}',
  'vitest.config.mts',
  'env.d.ts',
]

/** Map every configured rule severity to "warn". */
function toWarn(configs) {
  return configs.map((c) => {
    if (!c.rules) return c
    const rules = {}
    for (const [name, val] of Object.entries(c.rules)) {
      const sev = Array.isArray(val) ? val[0] : val
      if (sev === 'off' || sev === 0) rules[name] = val
      else rules[name] = Array.isArray(val) ? ['warn', ...val.slice(1)] : 'warn'
    }
    return { ...c, rules }
  })
}

const base = [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
  },
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: { parser: tseslint.parser, extraFileExtensions: ['.vue'], sourceType: 'module' },
    },
  },
  {
    rules: {
      // Formatting-ish vue rules are noise for this codebase.
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/multiline-html-element-content-newline': 'off',
      'vue/html-self-closing': 'off',
      'vue/html-indent': 'off',
      'vue/html-closing-bracket-newline': 'off',
      'vue/attributes-order': 'off',
      'vue/multi-word-component-names': 'off',
      'no-undef': 'off', // TS handles this
    },
  },
]

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'docs/.vitepress/cache/**',
      'docs/.vitepress/.temp/**',
      'docs/public/**',
      'playwright-report/**',
      'test-results/**',
      'tests/.cache/**',
    ],
  },
  // Legacy (everything not V2): whole rule set downgraded to warn.
  ...toWarn(base),
  // V2 strict: re-apply the same rules as errors, scoped to V2 files
  // (only plugins+rules are copied; parsers/processors come from the blocks above).
  ...base.filter((c) => c.rules).map((c) => ({ files: V2_FILES, ...(c.plugins ? { plugins: c.plugins } : {}), rules: c.rules })),
  {
    files: V2_FILES,
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { disallowTypeAnnotations: false }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
    },
  },
)
