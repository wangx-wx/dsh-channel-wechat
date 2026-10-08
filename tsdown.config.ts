import type { UserConfig } from 'tsdown'

/**
 * Host-half build. The client half (M6) gets its own entry and the lazy-CJS
 * wrapper from recon/13; this config must not grow that responsibility early.
 *
 * Every @deepseek-ai/* import stays a runtime require: the profile host owns a
 * single cordis instance, and bundling a copy would break service identity.
 */
const config: UserConfig = {
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  // The published manifest names lib/index.js; keep the emitted extension
  // fixed so the entry path cannot drift with the package's "type" field.
  fixedExtension: false,
  dts: false,
  sourcemap: false,
  clean: true,
  deps: {
    neverBundle: (specifier: string) => specifier.startsWith('@deepseek-ai/'),
  },
}

export default [config]
