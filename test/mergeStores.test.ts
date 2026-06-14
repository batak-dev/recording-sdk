import { describe, it, expect } from 'vitest';
import {
  mergeStores,
  ENGINE_STORES,
  ENGINE_STORE_NAMES,
  RECORDING_DOMAIN_STORES,
  DEFAULT_SCHEMA,
  STORE_NAMES,
  type StoreDescriptor
} from '../src/storage/schema';

const userStore = (name: string): StoreDescriptor => ({ name, keyPath: 'id' });

describe('mergeStores', () => {
  it('appends consumer stores after the engine stores', () => {
    const merged = mergeStores(ENGINE_STORES, [userStore('myStore')]);
    const names = merged.map((s) => s.name);
    expect(names).toContain('myStore');
    // Every engine store is still present.
    for (const n of ENGINE_STORE_NAMES) expect(names).toContain(n);
  });

  it('throws when a consumer store collides with an engine-owned store', () => {
    expect(() => mergeStores(ENGINE_STORES, [userStore(STORE_NAMES.REQUESTS)])).toThrow(
      /engine-owned/
    );
  });

  it('throws on duplicate consumer store names', () => {
    expect(() => mergeStores(ENGINE_STORES, [userStore('dup'), userStore('dup')])).toThrow(
      /Duplicate/
    );
  });

  it('DEFAULT_SCHEMA is engine stores + recording domain stores, all seven canonical names', () => {
    const names = DEFAULT_SCHEMA.stores.map((s) => s.name).sort();
    expect(names).toEqual(Object.values(STORE_NAMES).sort());
    expect(DEFAULT_SCHEMA.stores.length).toBe(
      ENGINE_STORES.length + RECORDING_DOMAIN_STORES.length
    );
  });
});
