import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    queue: 'src/queue.ts',
    storage: 'src/storage.ts',
    network: 'src/network.ts',
    resilience: 'src/resilience.ts',
    transport: 'src/transport.ts',
    auth: 'src/auth.ts',
    sw: 'src/sw.ts'
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: 'es2022',
  // Keep heavy browser deps external — the consumer's bundler resolves them.
  external: ['@mediapipe/tasks-vision', 'webm-muxer']
});
