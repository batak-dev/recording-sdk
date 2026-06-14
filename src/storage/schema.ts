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

/**
 * Stores the engine owns outright: the durable request queue, blob staging, the resilience
 * log, and the minimal chunk store. These are the plumbing the offline/retry/background-sync
 * guarantee is built on — a consumer cannot redefine them. Backend-specific fields on a
 * chunk are carried in the operation payloads, not by redefining the store shape.
 */
export const ENGINE_STORES: StoreDescriptor[] = [
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
    name: STORE_NAMES.BLOB_STORE,
    keyPath: 'id',
    indexes: [{ name: 'createdAt', keyPath: 'createdAt' }]
  },
  {
    name: STORE_NAMES.RESILIENCE_LOG,
    keyPath: 'pathIdentifier',
    indexes: [{ name: 'updatedAt', keyPath: 'updatedAt' }]
  }
];

/** Names of the engine-owned stores; consumer (domain) stores may not reuse these. */
export const ENGINE_STORE_NAMES: readonly string[] = ENGINE_STORES.map((s) => s.name);

/**
 * The built-in recording-service domain stores. These are *not* engine-owned: in a later
 * phase they move to the consumer's config. Declared here so the default schema keeps
 * working with zero config.
 */
export const RECORDING_DOMAIN_STORES: StoreDescriptor[] = [
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
    name: STORE_NAMES.AUTH_TOKEN_CACHE,
    keyPath: 'userId',
    indexes: [
      { name: 'sessionId', keyPath: 'sessionId' },
      { name: 'expiresAt', keyPath: 'expiresAt' }
    ]
  }
];

/**
 * Merge engine-owned stores with consumer-declared domain stores into one descriptor list.
 * Throws if a consumer store collides with an engine-owned store or duplicates another
 * consumer store, so the durability plumbing can never be silently overridden. This is the
 * function the config facade calls to assemble the final schema.
 */
export function mergeStores(engine: StoreDescriptor[], user: StoreDescriptor[]): StoreDescriptor[] {
  const engineNames = new Set(engine.map((s) => s.name));
  const seen = new Set<string>();
  const merged: StoreDescriptor[] = [...engine];
  for (const store of user) {
    if (engineNames.has(store.name)) {
      throw new Error(`Store "${store.name}" is engine-owned and cannot be redefined by config.`);
    }
    if (seen.has(store.name)) {
      throw new Error(`Duplicate store "${store.name}" in config.`);
    }
    seen.add(store.name);
    merged.push(store);
  }
  return merged;
}

/**
 * The default recording schema: engine stores + the built-in recording-service domain
 * stores. v6 prunes the obsolete `pendingTimeline` store (per-question video splitting now
 * uses the `questionOrder` carried in each chunk). The pruning happens generically in
 * {@link applySchema}: any object store present in the DB but absent from this descriptor is
 * dropped during the version upgrade.
 */
/** Schema version owned by the engine. `defineRecordingConfig` takes the max of this and
 *  any consumer `schemaVersion`, so both engine and consumer upgrades force onupgradeneeded. */
export const ENGINE_SCHEMA_VERSION = 6;

/** Default IndexedDB name; overridable via config. */
export const DEFAULT_DB_NAME = 'RecordingOfflineDB';

export const DEFAULT_SCHEMA: SchemaDescriptor = {
  dbName: DEFAULT_DB_NAME,
  version: ENGINE_SCHEMA_VERSION,
  stores: mergeStores(ENGINE_STORES, RECORDING_DOMAIN_STORES)
};

/**
 * Reconcile the database to the descriptor: create any missing stores/indexes, and drop any
 * object store that is no longer part of the schema (e.g. the legacy `pendingTimeline` store).
 * The descriptor is the single source of truth. Safe to call from `onupgradeneeded` on both the
 * main thread and the service worker. Bump `SchemaDescriptor.version` whenever you add or remove
 * a store so this runs against existing databases.
 */
export function applySchema(db: IDBDatabase, schema: SchemaDescriptor): void {
  const wanted = new Set(schema.stores.map((s) => s.name));

  // Create missing stores (+ their indexes).
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

  // Drop obsolete stores no longer in the descriptor.
  for (const name of Array.from(db.objectStoreNames as unknown as ArrayLike<string>)) {
    if (!wanted.has(name)) db.deleteObjectStore(name);
  }
}
