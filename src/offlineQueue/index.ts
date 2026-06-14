/**
 * Offline Queue Module
 * Provides resilient request queueing with IndexedDB persistence
 * and automatic retry for network failures
 */

export { OfflineQueueManager } from './manager';
export type { QueueManagerOptions } from './manager';
export { setupRequestHandlers, enqueueChunkUpload, enqueueCompleteRecording } from './requestHandlers';
export * from './types';
export * as db from './db';
export * as blobStorage from './blobStorage';

// Operation execution contracts + the built-in recording-service registry. The registry is
// the data-driven replacement for the closed RequestType union; a consumer can build their
// own OperationRegistry against these contracts.
export type {
  RequestSpec,
  RecordingEndpoints,
  EngineTimings,
  OperationContext,
  OperationDefinition,
  OperationRegistry
} from './operations';
export { priorityFor, isChunkDriven } from './operations';
export {
  recordingOperationRegistry,
  processRecordingRequest,
  processRecordingChunk
} from './recordingOperations';
