import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.js', 'apps/web/test/**/*.test.js', 'extension/test/**/*.test.js', 'agent/test/**/*.test.js'],
    environment: 'node',
  },
})
