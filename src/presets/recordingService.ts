/**
 * Recording-service preset.
 *
 * Bundles everything specific to the default backend (the recording-service REST contract:
 * presigned-URL + direct object-store upload) into one separable module: the operation
 * registry, the per-chunk processor, endpoints, domain stores, wire DTOs, and the HTTP
 * transport. None of this is in the engine core — pass `recordingServicePreset(...)` to
 * `defineRecordingConfig`, or compose your own preset from the same building blocks.
 *
 *   import { recordingServicePreset } from '@batak-dev/recording-sdk/presets';
 *   import { defineRecordingConfig } from '@batak-dev/recording-sdk';
 *
 *   const config = defineRecordingConfig(recordingServicePreset({ baseURL }));
 */
import type { RecordingConfig } from '../recordingConfig';
import {
  recordingOperationRegistry,
  processRecordingChunk,
  DEFAULT_ENDPOINTS,
  DEFAULT_BASE_URL,
  DEFAULT_UPLOAD_CONTENT_TYPE
} from '../offlineQueue/recordingOperations';
import { RECORDING_DOMAIN_STORES } from '../storage/schema';

export interface RecordingServicePresetOptions {
  /** Backend base URL. */
  baseURL?: string;
  /** Content-Type for the object-store PUT upload (default 'video/webm'). */
  uploadContentType?: string;
}

/**
 * Build a {@link RecordingConfig} targeting the recording-service contract. Pass the result
 * to `defineRecordingConfig`. Spread it to override individual pieces, e.g.
 * `defineRecordingConfig({ ...recordingServicePreset({ baseURL }), stores: [...] })`.
 */
export function recordingServicePreset(
  opts: RecordingServicePresetOptions = {}
): RecordingConfig {
  return {
    baseUrl: opts.baseURL ?? DEFAULT_BASE_URL,
    operations: recordingOperationRegistry,
    processChunk: processRecordingChunk,
    endpoints: DEFAULT_ENDPOINTS,
    stores: RECORDING_DOMAIN_STORES,
    uploadContentType: opts.uploadContentType ?? DEFAULT_UPLOAD_CONTENT_TYPE
  };
}

// Building blocks, re-exported so consumers can compose/extend the preset.
export {
  recordingOperationRegistry,
  processRecordingChunk,
  processRecordingRequest
} from '../offlineQueue/recordingOperations';
export { RECORDING_DOMAIN_STORES } from '../storage/schema';
export {
  RecordingServiceTransport,
  type RecordingServiceTransportOptions
} from '../transport/RecordingServiceTransport';
export * from '../transport/recordingServiceTypes';
