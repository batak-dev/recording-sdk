import { describe, it, expect } from 'vitest';
import { defineRecordingConfig } from '../src/recordingConfig';
import { recordingOperationRegistry } from '../src/offlineQueue/recordingOperations';
import { CODEC_PRESETS } from '../src/config';
import { STORE_NAMES, ENGINE_SCHEMA_VERSION, type StoreDescriptor } from '../src/storage/schema';
import { Priority } from '../src/offlineQueue/types';

describe('defineRecordingConfig', () => {
  it('reproduces the recording-service defaults with no input', () => {
    const c = defineRecordingConfig();
    expect(c.baseUrl).toBe('http://localhost:8082');
    expect(c.operations).toBe(recordingOperationRegistry);
    expect(c.codecs).toBe(CODEC_PRESETS);
    expect(c.uploadContentType).toBe('video/webm');
    expect(c.endpoints.start('http://x', 'abc')).toBe('http://x/api/v0/all/recordings/abc/start');
    expect(c.timings.maxChunkAttempts).toBe(5);
    // All seven canonical stores assembled.
    expect(c.schema.stores.map((s) => s.name).sort()).toEqual(Object.values(STORE_NAMES).sort());
    expect(c.schema.version).toBe(ENGINE_SCHEMA_VERSION);
  });

  it('merges consumer stores and bumps the schema version to the max', () => {
    const mine: StoreDescriptor = { name: 'myStore', keyPath: 'id' };
    const c = defineRecordingConfig({ stores: [mine], schemaVersion: 99 });
    expect(c.schema.stores.some((s) => s.name === 'myStore')).toBe(true);
    // Consumer-supplied stores replace the default domain stores (engine stores remain).
    expect(c.schema.stores.some((s) => s.name === STORE_NAMES.METADATA)).toBe(false);
    expect(c.schema.stores.some((s) => s.name === STORE_NAMES.REQUESTS)).toBe(true);
    expect(c.schema.version).toBe(99);
  });

  it('throws when a consumer store collides with an engine-owned store', () => {
    expect(() => defineRecordingConfig({ stores: [{ name: STORE_NAMES.REQUESTS, keyPath: 'id' }] })).toThrow(
      /engine-owned/
    );
  });

  it('passes through custom operations, endpoints and timings', () => {
    const customOps = { PING: { priority: Priority.MEDIUM, kind: 'request' as const, handle: async () => {} } };
    const c = defineRecordingConfig({
      operations: customOps,
      endpoints: { start: (b, id) => `${b}/x/${id}` },
      timings: { maxChunkAttempts: 9 }
    });
    expect(c.operations).toBe(customOps);
    expect(c.endpoints.start('h', 'i')).toBe('h/x/i');
    // Unspecified endpoints keep the defaults.
    expect(c.endpoints.complete('h', 'i')).toBe('h/api/v0/all/recordings/i/complete');
    // Unspecified timings keep the defaults.
    expect(c.timings.maxChunkAttempts).toBe(9);
    expect(c.timings.presignedTtlMs).toBe(10 * 60 * 1000);
  });
});
