// Build the backend-free GitHub Pages preview: refresh frozen demo data, bundle
// with the pages entry, then publish the single HTML page as index.html.
import { cp, mkdir, rename, rm, access, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'dist-pages')

function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', env })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited with ${code}`)))
  })
}

async function exists(target) {
  try { await access(target); return true } catch { return false }
}

await rm(dist, { recursive: true, force: true })

console.log('[pages] regenerating frozen demo data')
await run(process.execPath, ['scripts/build-static-demo-data.mjs'])

console.log('[pages] bundling static preview')
const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')
if (!await exists(viteBin)) throw new Error('vite is not installed; run npm ci first')
await run(process.execPath, [viteBin, 'build', '--config', 'vite.config.js', '--mode', 'pages'])

// Vite names the emitted HTML after its path relative to the project root.
const emitted = path.join(dist, 'pages.html')
if (await exists(emitted)) {
  await rename(emitted, path.join(dist, 'index.html'))
} else if (!await exists(path.join(dist, 'index.html'))) {
  throw new Error('pages build did not emit an HTML entry')
}

// GitHub Pages runs Jekyll unless told otherwise; the marker keeps asset dirs intact.
await writeFile(path.join(dist, '.nojekyll'), '')
await cp(path.join(dist, 'index.html'), path.join(dist, '404.html'))

console.log(`[pages] ready: ${path.relative(root, dist)}/index.html`)
