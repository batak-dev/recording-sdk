/**
 * IndexedDB service for offline queue persistence
 */

import type {
  QueuedRequest,
  StoredChunk,
  RecordingMetadata,
  RequestStatus,
  PresignedUrlCache,
  AuthTokenCache
} from './types';
import type { ResilienceEvent, ResilienceSessionMeta, ChunkStatusSnapshot } from '../resilience/types';
import {
  DEFAULT_SCHEMA,
  applySchema,
  STORE_NAMES,
  type SchemaDescriptor
} from '../storage/schema';

// Active schema. Override via setRecordingDbSchema() before the first getDB() call to
// add custom stores/indexes or bump the version. Extend DEFAULT_SCHEMA to keep the
// built-in recording stores working.
let activeSchema: SchemaDescriptor = DEFAULT_SCHEMA;

export function setRecordingDbSchema(schema: SchemaDescriptor): void {
  activeSchema = schema;
}

export function getRecordingDbSchema(): SchemaDescriptor {
  return activeSchema;
}

// Store names (re-exported for the built-in CRUD operations and the service worker).
export const STORES = STORE_NAMES;

// Crash-safe snapshot of a recording's resilience event log.
export interface ResilienceLogRecord {
  pathIdentifier: string;
  meta: ResilienceSessionMeta;
  events: ResilienceEvent[];
  updatedAt: number;
  /**
   * Per-chunk local upload statuses captured by clearRecordingData() right before the chunk
   * records are purged. Lets B5 consistency be recomputed when the log is downloaded later.
   */
  chunkStatuses?: ChunkStatusSnapshot[];
}

/**
 * Register background sync to trigger Service Worker retry when network is back
 */
async function registerBackgroundSync(): Promise<void> {
  // Only meaningful on a page with a serviceWorker container. Cast to `any` so this file
  // compiles under both the DOM lib (main thread) and the WebWorker lib (service worker),
  // where `window`/`navigator.serviceWorker` are not declared. In a service worker the
  // container is absent, so this no-ops.
  if (typeof navigator === 'undefined') return;
  const nav = navigator as any;

  try {
    if (nav.serviceWorker && 'ready' in nav.serviceWorker) {
      const registration = await nav.serviceWorker.ready;
      if (registration?.sync?.register) {
        await registration.sync.register('retry-queue');
        console.log('[DB] Background sync registered for pending operations');
      }
    }
  } catch (error) {
    console.warn('[DB] Failed to register background sync:', error);
  }
}

/**
 * Initialize and get the IndexedDB database
 */
export async function getDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(activeSchema.dbName, activeSchema.version);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      // Build stores/indexes from the (possibly customized) schema descriptor.
      applySchema(db, activeSchema);
    };
  });
}

// ==================== Request Operations ====================

export async function addRequest(request: QueuedRequest): Promise<void> {
  const db = await getDB();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction([STORES.REQUESTS], 'readwrite');
    const store = transaction.objectStore(STORES.REQUESTS);
    const req = store.put(request);

    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
  
  // Register background sync so SW retries when network returns
  await registerBackgroundSync();
}

export async function getRequest(id: string): Promise<QueuedRequest | null> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORES.REQUESTS], 'readonly');
    const store = transaction.objectStore(STORES.REQUESTS);
    const request = store.get(id);

    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

export async function updateRequest(request: QueuedRequest): Promise<void> {
  return addRequest(request); // PUT operation updates if exists
}

export async function deleteRequest(id: string): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORES.REQUESTS], 'readwrite');
    const store = transaction.objectStore(STORES.REQUESTS);
    const request = store.delete(id);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function getRequestsByStatus(status: RequestStatus): Promise<QueuedRequest[]> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORES.REQUESTS], 'readonly');
    const store = transaction.objectStore(STORES.REQUESTS);
    const index = store.index('status');
    const request = index.getAll(status);

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getAllRequests(): Promise<QueuedRequest[]> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORES.REQUESTS], 'readonly');
    const store = transaction.objectStore(STORES.REQUESTS);
    const request = store.getAll();

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ==================== Chunk Operations ====================

export async function addChunk(chunk: StoredChunk): Promise<void> {
  const db = await getDB();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction([STORES.CHUNKS], 'readwrite');
    const store = transaction.objectStore(STORES.CHUNKS);
    const request = store.put(chunk);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
  
  // Register background sync so SW retries when network returns
  await registerBackgroundSync();
}

export async function getChunk(pathIdentifier: string, chunkIndex: number): Promise<StoredChunk | null> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORES.CHUNKS], 'readonly');
    const store = transaction.objectStore(STORES.CHUNKS);
    const request = store.get([pathIdentifier, chunkIndex]);

    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

export async function updateChunk(chunk: StoredChunk): Promise<void> {
  return addChunk(chunk); // PUT operation updates if exists
}

export async function deleteChunk(pathIdentifier: string, chunkIndex: number): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORES.CHUNKS], 'readwrite');
    const store = transaction.objectStore(STORES.CHUNKS);
    const request = store.delete([pathIdentifier, chunkIndex]);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function getChunksByPath(pathIdentifier: string): Promise<StoredChunk[]> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORES.CHUNKS], 'readonly');
    const store = transaction.objectStore(STORES.CHUNKS);
    const index = store.index('pathIdentifier');
    const request = index.getAll(pathIdentifier);

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getChunksByStatus(status: RequestStatus): Promise<StoredChunk[]> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORES.CHUNKS], 'readonly');
    const store = transaction.objectStore(STORES.CHUNKS);
    const index = store.index('status');
    const request = index.getAll(status);

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getAllChunks(): Promise<StoredChunk[]> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORES.CHUNKS], 'readonly');
    const store = transaction.objectStore(STORES.CHUNKS);
    const request = store.getAll();

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Reclaim orphaned in-flight work: requests/chunks left at IN_PROGRESS by a drainer (the page's
 * OfflineQueueManager or the Service Worker) that died mid-operation — a tab refresh/close or a
 * terminated worker. IN_PROGRESS is an in-memory lock; the next drainer only ever picks up
 * PENDING items, so without this an orphan is never retried and any COMPLETE_RECORDING that
 * depends on it blocks forever.
 *
 * Safe to call at a drainer's startup because the page and the SW are mutually exclusive (the SW
 * defers to any open window), so nothing else is legitimately mid-flight at that moment. Returns
 * the number of items reclaimed.
 */
export async function resetStuckProcessing(): Promise<number> {
  let count = 0;
  for (const req of await getRequestsByStatus('IN_PROGRESS')) {
    req.status = 'PENDING';
    req.updatedAt = Date.now();
    await updateRequest(req);
    count++;
  }
  for (const chunk of await getChunksByStatus('IN_PROGRESS')) {
    chunk.status = 'PENDING';
    await updateChunk(chunk);
    count++;
  }
  return count;
}

// ==================== Metadata Operations ====================

export async function saveMetadata(metadata: RecordingMetadata): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORES.METADATA], 'readwrite');
    const store = transaction.objectStore(STORES.METADATA);
    const request = store.put(metadata);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function getMetadata(pathIdentifier: string): Promise<RecordingMetadata | null> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORES.METADATA], 'readonly');
    const store = transaction.objectStore(STORES.METADATA);
    const request = store.get(pathIdentifier);

    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

export async function deleteMetadata(pathIdentifier: string): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORES.METADATA], 'readwrite');
    const store = transaction.objectStore(STORES.METADATA);
    const request = store.delete(pathIdentifier);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

// ==================== Presigned URL Cache Operations ====================

export async function cachePresignedUrl(cache: PresignedUrlCache): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORES.PRESIGNED_CACHE], 'readwrite');
    const store = transaction.objectStore(STORES.PRESIGNED_CACHE);
    const request = store.put(cache);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function getCachedPresignedUrl(pathIdentifier: string, chunkIndex: number): Promise<PresignedUrlCache | null> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORES.PRESIGNED_CACHE], 'readonly');
    const store = transaction.objectStore(STORES.PRESIGNED_CACHE);
    const request = store.get([pathIdentifier, chunkIndex]);

    request.onsuccess = () => {
      const result = request.result;
      // Check if expired
      if (result && result.expiresAt > Date.now()) {
        resolve(result);
      } else {
        resolve(null);
      }
    };
    request.onerror = () => reject(request.error);
  });
}

export async function deletePresignedUrl(pathIdentifier: string, chunkIndex: number): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORES.PRESIGNED_CACHE], 'readwrite');
    const store = transaction.objectStore(STORES.PRESIGNED_CACHE);
    const request = store.delete([pathIdentifier, chunkIndex]);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function cleanupExpiredPresignedUrls(): Promise<number> {
  const db = await getDB();
  const now = Date.now();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORES.PRESIGNED_CACHE], 'readwrite');
    const store = transaction.objectStore(STORES.PRESIGNED_CACHE);
    const index = store.index('expiresAt');
    const range = IDBKeyRange.upperBound(now);
    const request = index.openCursor(range);

    let deletedCount = 0;

    request.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest).result;
      if (cursor) {
        cursor.delete();
        deletedCount++;
        cursor.continue();
      } else {
        resolve(deletedCount);
      }
    };

    request.onerror = () => reject(request.error);
  });
}

// ==================== Cleanup Operations ====================

export async function cleanupExpiredRequests(): Promise<number> {
  const requests = await getAllRequests();
  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000; // 24 hours

  let deletedCount = 0;
  for (const request of requests) {
    if (now - request.createdAt > maxAge && request.status === 'FAILED') {
      await deleteRequest(request.id);
      deletedCount++;
    }
  }

  return deletedCount;
}

export async function clearAllData(): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(
      [STORES.REQUESTS, STORES.CHUNKS, STORES.METADATA, STORES.PRESIGNED_CACHE, STORES.AUTH_TOKEN_CACHE],
      'readwrite'
    );

    const stores = [STORES.REQUESTS, STORES.CHUNKS, STORES.METADATA, STORES.PRESIGNED_CACHE, STORES.AUTH_TOKEN_CACHE];
    stores.forEach(storeName => {
      transaction.objectStore(storeName).clear();
    });

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

/**
 * Remove a single recording's transient data once it is fully uploaded and completed on the
 * server: its chunks (and their stored blobs), presigned-URL cache entries, queued requests
 * and metadata. The resilience event log is kept by default so the report / crash-recovery
 * (`loadPersistedReport`) still works — pass `keepResilienceLog: false` to drop it too.
 */
export async function clearRecordingData(
  pathIdentifier: string,
  options: { keepResilienceLog?: boolean } = {}
): Promise<void> {
  const keepResilienceLog = options.keepResilienceLog ?? true;

  // Chunks + their blobs + presigned-cache entries.
  const chunks = await getChunksByPath(pathIdentifier);

  // Snapshot the per-chunk local statuses into the resilience log before they're deleted, so
  // B5 queue-state consistency can still be computed when the log is downloaded post-hoc.
  if (keepResilienceLog && chunks.length > 0) {
    try {
      const log = await getResilienceLog(pathIdentifier);
      if (log) {
        log.chunkStatuses = chunks.map((c) => ({ chunkIndex: c.chunkIndex, status: c.status }));
        log.updatedAt = Date.now();
        await saveResilienceLog(log);
      }
    } catch {
      // Best-effort: a snapshot failure must not block cleanup.
    }
  }

  const blobIds = chunks.map((c) => c.blobId).filter(Boolean) as string[];
  if (blobIds.length > 0) {
    const db = await getDB();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction([STORES.BLOB_STORE], 'readwrite');
      const store = transaction.objectStore(STORES.BLOB_STORE);
      for (const id of blobIds) store.delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }
  for (const chunk of chunks) {
    await deletePresignedUrl(pathIdentifier, chunk.chunkIndex);
    await deleteChunk(pathIdentifier, chunk.chunkIndex);
  }

  // Queued requests belonging to this recording (path lives in request.data).
  const requests = await getAllRequests();
  for (const req of requests) {
    if (req.data?.pathIdentifier === pathIdentifier) await deleteRequest(req.id);
  }

  // Metadata, and optionally the resilience log.
  await deleteMetadata(pathIdentifier);
  if (!keepResilienceLog) await deleteResilienceLog(pathIdentifier);
}

// ==================== Auth Token Cache Operations ====================

export async function cacheAuthToken(tokenData: AuthTokenCache): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORES.AUTH_TOKEN_CACHE], 'readwrite');
    const store = transaction.objectStore(STORES.AUTH_TOKEN_CACHE);
    const request = store.put(tokenData);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function getAuthToken(userId: string): Promise<AuthTokenCache | null> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORES.AUTH_TOKEN_CACHE], 'readonly');
    const store = transaction.objectStore(STORES.AUTH_TOKEN_CACHE);
    const request = store.get(userId);

    request.onsuccess = () => {
      const result = request.result;
      // Check if expired (with 5-minute buffer)
      if (result && result.expiresAt > Date.now() + 5 * 60 * 1000) {
        resolve(result);
      } else {
        resolve(null);
      }
    };
    request.onerror = () => reject(request.error);
  });
}

export async function getCurrentAuthToken(): Promise<AuthTokenCache | null> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORES.AUTH_TOKEN_CACHE], 'readonly');
    const store = transaction.objectStore(STORES.AUTH_TOKEN_CACHE);
    const request = store.getAll();

    request.onsuccess = () => {
      const tokens = request.result;
      if (tokens.length === 0) {
        resolve(null);
        return;
      }
      
      // Return the most recent non-expired token
      const validTokens = tokens.filter(t => t.expiresAt > Date.now() + 5 * 60 * 1000);
      if (validTokens.length === 0) {
        resolve(null);
        return;
      }
      
      // Sort by createdAt descending and return the newest
      validTokens.sort((a, b) => b.createdAt - a.createdAt);
      resolve(validTokens[0]);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function deleteAuthToken(userId: string): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORES.AUTH_TOKEN_CACHE], 'readwrite');
    const store = transaction.objectStore(STORES.AUTH_TOKEN_CACHE);
    const request = store.delete(userId);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function clearAllAuthTokens(): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORES.AUTH_TOKEN_CACHE], 'readwrite');
    const store = transaction.objectStore(STORES.AUTH_TOKEN_CACHE);
    const request = store.clear();

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function cleanupExpiredAuthTokens(): Promise<number> {
  const db = await getDB();
  const now = Date.now();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORES.AUTH_TOKEN_CACHE], 'readwrite');
    const store = transaction.objectStore(STORES.AUTH_TOKEN_CACHE);
    const index = store.index('expiresAt');
    const range = IDBKeyRange.upperBound(now);
    const request = index.openCursor(range);

    let deletedCount = 0;

    request.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest).result;
      if (cursor) {
        cursor.delete();
        deletedCount++;
        cursor.continue();
      } else {
        resolve(deletedCount);
      }
    };

    request.onerror = () => reject(request.error);
  });
}

// ==================== Resilience Log Operations ====================

export async function saveResilienceLog(record: ResilienceLogRecord): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORES.RESILIENCE_LOG], 'readwrite');
    const store = transaction.objectStore(STORES.RESILIENCE_LOG);
    const request = store.put(record);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function getResilienceLog(pathIdentifier: string): Promise<ResilienceLogRecord | null> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORES.RESILIENCE_LOG], 'readonly');
    const store = transaction.objectStore(STORES.RESILIENCE_LOG);
    const request = store.get(pathIdentifier);

    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

export async function listResilienceLogPaths(): Promise<string[]> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORES.RESILIENCE_LOG], 'readonly');
    const store = transaction.objectStore(STORES.RESILIENCE_LOG);
    const request = store.getAllKeys();

    request.onsuccess = () => resolve((request.result || []) as string[]);
    request.onerror = () => reject(request.error);
  });
}

export async function deleteResilienceLog(pathIdentifier: string): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORES.RESILIENCE_LOG], 'readwrite');
    const store = transaction.objectStore(STORES.RESILIENCE_LOG);
    const request = store.delete(pathIdentifier);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
