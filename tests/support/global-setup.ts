/**
 * Build the package once before the integration suites run.
 *
 * Those suites assert against the artifact this package actually publishes -
 * `lib/index.js` and the export form inside it - so a stale or missing build
 * would make them describe something other than what ships. Building here
 * keeps `pnpm test:integration` self-contained on a fresh clone instead of
 * silently depending on someone having run `pnpm build` first.
 */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

export default function setup(): void {
  const result = spawnSync('pnpm', ['build'], {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) {
    throw new Error(`pnpm build failed (status ${String(result.status)}):\n${result.stdout}\n${result.stderr}`)
  }
}
