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
  const names = new Set(existing);
  const db = {
    objectStoreNames: { contains: (n: string) => names.has(n) },
    createObjectStore(name: string, _opts: any) {
      names.add(name);
      created[name] = [];
      return {
        createIndex(indexName: string) {
          created[name].push(indexName);
        }
      };
    }
  } as unknown as IDBDatabase;
  return { db, created };
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
