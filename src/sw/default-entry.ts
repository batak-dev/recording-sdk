/**
 * Prebuilt zero-config recording worker.
 *
 * Bundled to `dist/sw.default.js`. Serve this file from your origin root and register it
 * with `registerRecordingWorker('/sw.default.js', { recordingServiceUrl })`. For custom
 * adapters (schema, transport, auth), write your own entry calling `createRecordingWorker`.
 */
import { createRecordingWorker } from './worker';

createRecordingWorker();
