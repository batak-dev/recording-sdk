/**
 * Example: custom service-worker entry.
 *
 * Bundle this to a single self-contained ESM file served at your origin root (e.g.
 * `public/sw.js`) and register it from the page with
 * `registerRecordingWorker('/sw.js', { recordingServiceUrl, type: 'module' })`.
 *
 * It imports the SAME config module the page uses, so the worker and the page agree on the
 * operations, endpoints, schema, and timings. The worker keeps its fixed internal structure
 * (events, retry/drain orchestration, Background Sync) — only the config flows in.
 *
 * Scaffold this file with: `npx recording-sdk init-sw public/sw-entry.ts`
 */
import { createRecordingWorker } from '@batak-dev/recording-sdk/sw/worker';
import { buildRecordingConfig } from './recording.config';

// A worker has no page http client; build the config without a page-only transport (the
// worker never uses it). Pass a stub for the http client arg, or refactor buildRecordingConfig
// to make `transport` optional. The base URL is also recovered from the worker script URL.
createRecordingWorker(buildRecordingConfig(undefined as any, self.location.origin));
