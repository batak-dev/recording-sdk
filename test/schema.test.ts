import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SCHEMA,
  STORE_NAMES,
  applySchema,
  type SchemaDescriptor
} from '../src/storage/schema';

/**
 * Minimal in-memory stand-in for the slice of IDBDatabase that `applySchema` touches
 * (objectStoreNames + createObjectStore + createIndex). Lets us assert the data-driven
 * schema build without a real IndexedDB.
 */
function createMockDb(existing: string[] = []) {
  const created: Record<string, string[]> = {};
  const deleted: string[] = [];
  const names = new Set(existing);
  const db = {
    // DOMStringList-like: supports `.contains` and iteration (for Array.from).
    objectStoreNames: {
      contains: (n: string) => names.has(n),
      get length() {
        return names.size;
      },
      [Symbol.iterator]: () => names.values()
    },
    createObjectStore(name: string, _opts: any) {
      names.add(name);
      created[name] = [];
      return {
        createIndex(indexName: string) {
          created[name].push(indexName);
        }
      };
    },
    deleteObjectStore(name: string) {
      names.delete(name);
      deleted.push(name);
    }
  } as unknown as IDBDatabase;
  return { db, created, deleted };
}

describe('DEFAULT_SCHEMA', () => {
  it('declares all seven canonical stores', () => {
    const names = DEFAULT_SCHEMA.stores.map((s) => s.name).sort();
    expect(names).toEqual(Object.values(STORE_NAMES).sort());
  });

  it('uses a composite key for chunk and presigned-cache stores', () => {
    const chunks = DEFAULT_SCHEMA.stores.find((s) => s.name === STORE_NAMES.CHUNKS);
    expect(chunks?.keyPath).toEqual(['pathIdentifier', 'chunkIndex']);
  });

  it('is at version 6 (pendingTimeline removed) and does not declare a timeline store', () => {
    expect(DEFAULT_SCHEMA.version).toBe(6);
    expect(DEFAULT_SCHEMA.stores.some((s) => s.name === 'pendingTimeline')).toBe(false);
  });
});

describe('applySchema', () => {
  it('creates every store and its indexes on a fresh db', () => {
    const { db, created } = createMockDb();
    applySchema(db, DEFAULT_SCHEMA);
    expect(Object.keys(created).sort()).toEqual(Object.values(STORE_NAMES).sort());
    expect(created[STORE_NAMES.REQUESTS].sort()).toEqual(['createdAt', 'priority', 'status']);
  });

  it('skips stores that already exist (idempotent upgrade)', () => {
    const { db, created } = createMockDb([STORE_NAMES.REQUESTS]);
    applySchema(db, DEFAULT_SCHEMA);
    expect(created[STORE_NAMES.REQUESTS]).toBeUndefined();
    expect(created[STORE_NAMES.BLOB_STORE]).toBeDefined();
  });

  it('drops obsolete stores no longer in the descriptor (legacy pendingTimeline)', () => {
    const { db, created, deleted } = createMockDb([
      ...Object.values(STORE_NAMES),
      'pendingTimeline'
    ]);
    applySchema(db, DEFAULT_SCHEMA);
    // All canonical stores already existed -> nothing created; only the legacy store dropped.
    expect(Object.keys(created)).toEqual([]);
    expect(deleted).toEqual(['pendingTimeline']);
  });

  it('supports a custom schema (storage adapter swap)', () => {
    const custom: SchemaDescriptor = {
      dbName: 'CustomDB',
      version: 1,
      stores: [
        {
          name: 'myStore',
          keyPath: 'id',
          indexes: [{ name: 'byTag', keyPath: 'tag' }]
        }
      ]
    };
    const { db, created } = createMockDb();
    applySchema(db, custom);
    expect(Object.keys(created)).toEqual(['myStore']);
    expect(created.myStore).toEqual(['byTag']);
  });
});
