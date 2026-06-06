/**
 * `@ta/recording-sdk/storage` — IndexedDB persistence layer.
 *
 * Exposes the default IndexedDB schema + CRUD operations and the transient blob
 * store. The store names and schema are the single source of truth shared by the
 * main thread and the service worker.
 */
export * from './offlineQueue/db';
export * from './offlineQueue/blobStorage';
