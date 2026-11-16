import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const pagesBase = process.env.PAGES_BASE ?? '/permit-route-planner/'

export default defineConfig(({ mode }) => {
  const demo = mode === 'demo'
  const pages = mode === 'pages'
  const outDir = pages ? '../dist-pages' : demo ? '../dist-demo' : '../dist'
  const input = pages
    ? fileURLToPath(new URL('./client/pages.html', import.meta.url))
    : demo
      ? fileURLToPath(new URL('./client/demo.html', import.meta.url))
      : undefined
  return {
    root: fileURLToPath(new URL('./client', import.meta.url)),
    base: pages ? pagesBase : '/',
    plugins: [vue()],
    build: {
      outDir,
      emptyOutDir: true,
      chunkSizeWarningLimit: 1600,
      ...(input ? { rollupOptions: { input } } : {}),
    },
    server: demo || pages
      ? { host: '127.0.0.1', port: 5175, strictPort: true, proxy: { '/api': 'http://127.0.0.1:4318' } }
      : { host: '127.0.0.1', port: 5174, strictPort: true, proxy: { '/api': 'http://127.0.0.1:4317' } },
  }
})
