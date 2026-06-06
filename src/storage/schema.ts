/**
 * IndexedDB schema descriptor.
 *
 * A serializable description of the database (name, version, object stores, indexes).
 * It is the single source of truth shared by the main-thread storage layer and the
 * service worker, replacing the previously-duplicated inline `onupgradeneeded` logic.
 *
 * Consumers can define their own schema (extra stores/indexes, a bumped version) and
 * register it via `setRecordingDbSchema()` before the first DB access. Extend
 * {@link DEFAULT_SCHEMA} rather than replacing it if you want to keep the built-in
 * recording stores working.
 */
export interface IndexDescriptor {
  name: string;
  keyPath: string | string[];
  options?: IDBIndexParameters;
}

export interface StoreDescriptor {
  name: string;
  keyPath: string | string[];
  autoIncrement?: boolean;
  indexes?: IndexDescriptor[];
}

export interface SchemaDescriptor {
  dbName: string;
  version: number;
  stores: StoreDescriptor[];
}

/** Canonical store names used by the built-in CRUD operations and the service worker. */
export const STORE_NAMES = {
  REQUESTS: 'pendingRequests',
  CHUNKS: 'pendingChunks',
  METADATA: 'recordingMetadata',
  PRESIGNED_CACHE: 'presignedUrlCache',
  BLOB_STORE: 'blobStore',
  AUTH_TOKEN_CACHE: 'authTokenCache',
  RESILIENCE_LOG: 'resilienceLog'
} as const;

/** The default recording schema (identical to the original hardcoded v5 schema). */
export const DEFAULT_SCHEMA: SchemaDescriptor = {
  dbName: 'RecordingOfflineDB',
  version: 5,
  stores: [
    {
      name: STORE_NAMES.REQUESTS,
      keyPath: 'id',
      indexes: [
        { name: 'status', keyPath: 'status' },
        { name: 'priority', keyPath: 'priority' },
        { name: 'createdAt', keyPath: 'createdAt' }
      ]
    },
    {
      name: STORE_NAMES.CHUNKS,
      keyPath: ['pathIdentifier', 'chunkIndex'],
      indexes: [
        { name: 'status', keyPath: 'status' },
        { name: 'pathIdentifier', keyPath: 'pathIdentifier' }
      ]
    },
    {
      name: STORE_NAMES.METADATA,
      keyPath: 'pathIdentifier',
      indexes: [{ name: 'status', keyPath: 'status' }]
    },
    {
      name: STORE_NAMES.PRESIGNED_CACHE,
      keyPath: ['pathIdentifier', 'chunkIndex'],
      indexes: [{ name: 'expiresAt', keyPath: 'expiresAt' }]
    },
    {
      name: STORE_NAMES.BLOB_STORE,
      keyPath: 'id',
      indexes: [{ name: 'createdAt', keyPath: 'createdAt' }]
    },
    {
      name: STORE_NAMES.AUTH_TOKEN_CACHE,
      keyPath: 'userId',
      indexes: [
        { name: 'sessionId', keyPath: 'sessionId' },
        { name: 'expiresAt', keyPath: 'expiresAt' }
      ]
    },
    {
      name: STORE_NAMES.RESILIENCE_LOG,
      keyPath: 'pathIdentifier',
      indexes: [{ name: 'updatedAt', keyPath: 'updatedAt' }]
    }
  ]
};

/**
 * Create any object stores/indexes from the descriptor that don't already exist.
 * Safe to call from `onupgradeneeded` on both the main thread and the service worker.
 */
export function applySchema(db: IDBDatabase, schema: SchemaDescriptor): void {
  for (const store of schema.stores) {
    if (db.objectStoreNames.contains(store.name)) continue;
    const objectStore = db.createObjectStore(store.name, {
      keyPath: store.keyPath as string | string[],
      autoIncrement: store.autoIncrement
    });
    for (const index of store.indexes ?? []) {
      objectStore.createIndex(index.name, index.keyPath as string | string[], index.options);
    }
  }
}
