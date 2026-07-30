import { defineConfig } from 'vite'

// ── Vite ────────────────────────────────────────────────────────────────────
// base must match the GitHub Pages project subpath. Getting this wrong does
// not fail the build — it produces a deployed page that 404s on every asset,
// which is why `npm run preview` (which honours base) is the thing to test
// against rather than `npm run dev` (which does not).
//
// The WASM artifacts live in public/ and are therefore copied verbatim and
// never parsed by Rollup. That is load-bearing, not incidental: emscripten's
// glue contains conditional require('fs') calls for its Node backend that
// Rollup would try to statically resolve and fail on.
// ────────────────────────────────────────────────────────────────────────────
export default defineConfig({
  base: '/parallax/',

  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,

    // The wasm glue is already minified by emscripten's own pipeline and is
    // served as a separate file; nothing here should try to inline it.
    assetsInlineLimit: 0,
  },

  server: {
    port: 5181,
    strictPort: true,
  },

  preview: {
    port: 4173,
    strictPort: true,
  },
})
