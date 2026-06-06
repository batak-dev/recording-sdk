import { defineConfig } from 'tsup';

// Service-worker builds. Separate from the main config because these target the
// ServiceWorkerGlobalScope (WebWorker lib) rather than the DOM. `clean: false` so they
// append to the dist/ produced by the main build.
export default defineConfig([
  {
    // Factory module — consumers import this into their own worker entry and bundle it.
    entry: { worker: 'src/sw/worker.ts' },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: false,
    treeshake: true,
    target: 'es2022',
    tsconfig: 'tsconfig.sw.json'
  },
  {
    // Prebuilt zero-config worker — self-contained single ESM file to serve at the origin
    // root and register with `{ type: 'module' }` (the SDK targets Chromium, which supports
    // module service workers). Produces dist/sw.default.js.
    entry: { 'sw.default': 'src/sw/default-entry.ts' },
    format: ['esm'],
    dts: false,
    sourcemap: true,
    clean: false,
    treeshake: true,
    minify: true,
    target: 'es2022',
    tsconfig: 'tsconfig.sw.json'
  }
]);
