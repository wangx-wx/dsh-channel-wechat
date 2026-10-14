import type { UserConfig } from 'tsdown'

/**
 * Host-half build. The client half (M6) gets its own entry and the lazy-CJS
 * wrapper from recon/13; this config must not grow that responsibility early.
 *
 * Every @deepseek-ai/* import stays a runtime require: the profile host owns a
 * single cordis instance, and bundling a copy would break service identity.
 */
const config: UserConfig = {
  // `startup` is a separate entry because the profile loader must resolve it
  // by subpath: it declares `inject`, and only a row naming it gets the
  // launcher-provided command line.
  entry: { index: 'src/index.ts', startup: 'src/startup.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  // The published manifest names lib/index.js; keep the emitted extension
  // fixed so the entry path cannot drift with the package's "type" field.
  fixedExtension: false,
  // The `./startup` subpath declares a `types` face, so one has to exist in the
  // artifact that ships. It used to point at `src/startup.ts`, which `files[]`
  // does not carry: the declaration resolved while developing and silently
  // degraded to `any` for anyone who installed the package.
  dts: true,
  sourcemap: false,
  clean: true,
  // The bundle inlines the vendored qrcode-generator, whose MIT header lives in
  // `src/vendor/qrcode.mjs` and would otherwise be dropped from the published
  // artifact - stripping an attribution the license requires us to carry.
  // `THIRD_PARTY_NOTICES.md` has the full notice; this banner keeps the
  // attribution inside the file that actually contains the code.
  outputOptions: {
    banner: [
      '/*!',
      ' * Includes qrcode-generator 2.0.4 - Copyright (c) 2009, 2016 Kazuhiko Arase.',
      ' * Licensed under the MIT license: http://www.opensource.org/licenses/mit-license.php',
      ' *',
      ' * Portions adapted from @tencent-weixin/openclaw-weixin',
      ' * (MIT, Copyright (C) 2026 Tencent).',
      ' * See THIRD_PARTY_NOTICES.md for the full notices.',
      ' */',
    ].join('\n'),
  },
  deps: {
    // commander is a runtime dependency, not a copy of the harness: bundling
    // it would duplicate a singleton the host already owns.
    neverBundle: (specifier: string) => specifier.startsWith('@deepseek-ai/') || specifier === 'commander',
  },
}

export default [config]
