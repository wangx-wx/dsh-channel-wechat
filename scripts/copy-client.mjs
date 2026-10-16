/**
 * Copy the hand-written browser half into the published artifact.
 *
 * The client half is plain JavaScript wrapped in the loader's lazy-CJS form, so
 * it needs no bundling: the file is already the exact artifact the browser
 * loads. Copying keeps it out of `src/` (which `files[]` does not carry) and
 * free of the host build's ESM/target settings, which would rewrite it.
 *
 * `dsh-wechat` ships its client half the same way, and `docs/recon/13` records
 * why: reproducing the repository-internal `clientBundle` tsdown preset is only
 * necessary for TSX and CSS modules, neither of which this page uses.
 */

import { copyFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

mkdirSync(`${root}lib`, { recursive: true })
copyFileSync(`${root}src/client/client.js`, `${root}lib/client.js`)
