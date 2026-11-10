import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ mode }) => {
  const demo = mode === 'demo'
  return {
    root: fileURLToPath(new URL('./client', import.meta.url)),
    plugins: [vue()],
    build: demo
      ? { outDir: '../dist-demo', emptyOutDir: true, chunkSizeWarningLimit: 1600, rollupOptions: { input: fileURLToPath(new URL('./client/demo.html', import.meta.url)) } }
      : { outDir: '../dist', emptyOutDir: true },
    server: demo
      ? { host: '127.0.0.1', port: 5175, strictPort: true, proxy: { '/api': 'http://127.0.0.1:4318' } }
      : { host: '127.0.0.1', port: 5174, strictPort: true, proxy: { '/api': 'http://127.0.0.1:4317' } },
  }
})
