import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'node:fs'

// The app's version (root package.json, the same number the extension's manifest gets), so
// the hosted site can tell when an installed extension is older than itself.
// R_APP_VERSION overrides it, to try the "Update your extension" banner locally.
const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
const appVersion = process.env.R_APP_VERSION || version

// base './' makes the build work on any static host path (GitHub Pages project
// sites, Netlify, Vercel, Cloudflare Pages) and inside the extension.
export default defineConfig({
  base: './',
  plugins: [vue(), tailwindcss()],
  define: { __R_VERSION__: JSON.stringify(appVersion) },
  build: { target: 'es2022', chunkSizeWarningLimit: 900 },
  server: { port: 5173 },
})
