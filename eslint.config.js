import js from '@eslint/js'
import vue from 'eslint-plugin-vue'
import globals from 'globals'

export default [
  {
    ignores: ['**/dist/**', '**/dist-ext/**', 'node_modules/**', 'private/**', 'test-results/**', 'playwright-report/**', 'test-builds/**'],
  },
  js.configs.recommended,
  ...vue.configs['flat/essential'],
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node, ...globals.webextensions, __R_VERSION__: 'readonly', __R_APP_URL__: 'readonly' },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'vue/multi-word-component-names': 'off',
    },
  },
  // Playwright fixtures must destructure their first argument, even when empty
  { files: ['tests/e2e/**'], rules: { 'no-empty-pattern': 'off' } },
]
