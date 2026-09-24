/**
 * Build the loadable extension into `dist/`.
 *
 * `tsc --noEmit` typechecks; it cannot produce the extension itself because
 * Chrome's ESM loader has no module resolution for the bare `zod` specifier.
 * esbuild bundles each entry point into a single self-contained ESM file, which
 * is also what the manifest's `content_security_policy` (`script-src 'self'`)
 * requires.
 *
 * Load the result via chrome://extensions → Developer mode → Load unpacked →
 * extension/dist.
 */

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const outDir = join(root, 'dist')
const dev = process.argv.includes('--dev')

const ENTRY_POINTS = [
  { in: join(root, 'src/background/service-worker.ts'), out: 'background/service-worker' },
  { in: join(root, 'src/popup/popup.ts'), out: 'popup/popup' },
]

/** package.json is the one place the version is bumped; the manifest follows it. */
async function syncManifestVersion() {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const manifestPath = join(outDir, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest.version !== pkg.version) {
    manifest.version = pkg.version
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  }
}

async function main() {
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })

  // Static assets: manifest, popup markup/styles, icons.
  await cp(join(root, 'public'), outDir, { recursive: true })
  await syncManifestVersion()

  await build({
    entryPoints: ENTRY_POINTS,
    outdir: outDir,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    // Matches `minimum_chrome_version`; every API these entry points use ships there.
    target: ['chrome116'],
    minify: !dev,
    sourcemap: dev ? 'inline' : false,
    legalComments: 'none',
    logLevel: 'info',
    define: { 'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production') },
  })

  // Relative, so a pasted build log does not carry the local directory layout.
  const shown = relative(process.cwd(), outDir) || '.'
  console.log(`[extension] built ${dev ? 'development' : 'production'} extension -> ${shown}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
