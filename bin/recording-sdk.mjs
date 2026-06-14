#!/usr/bin/env node
/**
 * Minimal scaffolder for the recording SDK.
 *
 *   recording-sdk init-sw [outfile]
 *
 * Writes a service-worker entry that imports your shared `recording.config` and installs the
 * worker. Bundle the emitted file (your bundler) into a single ESM served at the origin root.
 * The worker's internal structure is fixed; only your config flows in.
 */
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const [cmd, outArg] = process.argv.slice(2);

if (cmd !== 'init-sw') {
  console.error('Usage: recording-sdk init-sw [outfile]');
  process.exit(cmd === '--help' || cmd === '-h' ? 0 : 1);
}

const out = resolve(outArg ?? 'sw-entry.ts');
if (existsSync(out)) {
  console.error(`Refusing to overwrite existing file: ${out}`);
  process.exit(1);
}

const template = `import { createRecordingWorker } from '@batak-dev/recording-sdk/sw/worker';
// The SAME config module your page imports. Adjust the path / how you build the config.
import config from './recording.config';

createRecordingWorker(config);
`;

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, template);
console.log(`Wrote service-worker entry: ${out}`);
console.log('Next: bundle it to a single ESM file at your origin root and register it with');
console.log("registerRecordingWorker('/sw.js', { recordingServiceUrl, type: 'module' }).");
