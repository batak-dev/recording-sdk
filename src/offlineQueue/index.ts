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
