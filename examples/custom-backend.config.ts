/**
 * Example: a fully custom backend, no preset.
 *
 * Shows the "everything reconfigurable" path — you define the operations (request types +
 * how each is performed), the per-chunk processor, the domain stores, the endpoints, and
 * auth. Nothing recording-service-specific is pulled in. The engine (durable queue, retry,
 * background sync, capture pipeline) comes from the SDK.
 */
import { defineRecordingConfig } from '@batak-dev/recording-sdk';
import {
  Priority,
  type OperationRegistry,
  type OperationContext
} from '@batak-dev/recording-sdk/queue';
import type { StoredChunk } from '@batak-dev/recording-sdk/queue';
import type { StoreDescriptor } from '@batak-dev/recording-sdk/storage';

// 1) Operations — the open replacement for the old fixed request-type union. Each `handle`
//    runs identically on the page and in the service worker (only uses `ctx`).
const operations: OperationRegistry = {
  START_RECORDING: {
    priority: Priority.CRITICAL,
    kind: 'request',
    async handle(ctx, req) {
      const res = await ctx.authedFetch({
        url: ctx.endpoints.start(ctx.baseUrl, req.data.pathIdentifier),
        method: 'POST'
      });
      if (!res.ok) throw new Error(`start failed: ${res.status}`);
    }
  },
  // Chunk uploads are driven by the engine chunk loop (see processChunk), not the request
  // loop — so these carry no `handle`.
  PRESIGNED_URL: { priority: Priority.HIGH, kind: 'chunk' },
  UPLOAD_CHUNK: { priority: Priority.HIGH, kind: 'chunk' },
  COMPLETE_RECORDING: {
    priority: Priority.LOW,
    kind: 'request',
    async handle(ctx, req) {
      const res = await ctx.authedFetch({
        url: ctx.endpoints.complete(ctx.baseUrl, req.data.pathIdentifier),
        method: 'POST'
      });
      if (!res.ok) throw new Error(`complete failed: ${res.status}`);
      req.data.result = await res.json();
    }
  }
};

// 2) Per-chunk processor — the engine owns the loop; this is the backend-specific body.
async function processChunk(ctx: OperationContext, chunk: StoredChunk) {
  const blob = await ctx.blobStorage.retrieveBlob(chunk.blobId);
  if (!blob) throw new Error(`blob ${chunk.blobId} missing`);

  let url = chunk.presignedUrl;
  const expired = !chunk.presignedUrlExpiresAt || chunk.presignedUrlExpiresAt < Date.now();
  if (!url || expired) {
    const res = await ctx.authedFetch({
      url: ctx.endpoints.presigned(ctx.baseUrl, chunk.pathIdentifier),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chunk_index: chunk.chunkIndex })
    });
    if (!res.ok) throw new Error(`presigned failed: ${res.status}`);
    url = (await res.json()).presigned_url;
    chunk.presignedUrl = url;
    chunk.presignedUrlExpiresAt = Date.now() + ctx.timings.presignedTtlMs;
    await ctx.db.updateChunk(chunk);
  }

  const put = await fetch(url!, { method: 'PUT', body: blob, headers: { 'Content-Type': ctx.uploadContentType } });
  if (!put.ok) throw new Error(`upload failed: ${put.status}`);

  chunk.status = 'COMPLETED';
  await ctx.db.updateChunk(chunk);
  await ctx.blobStorage.deleteBlob(chunk.blobId);
}

// 3) Domain stores — merged with the engine plumbing stores. mergeStores throws if you
//    reuse an engine-owned name (pendingRequests / pendingChunks / blobStore / resilienceLog).
const stores: StoreDescriptor[] = [
  { name: 'recordingMetadata', keyPath: 'pathIdentifier', indexes: [{ name: 'status', keyPath: 'status' }] },
  { name: 'presignedUrlCache', keyPath: ['pathIdentifier', 'chunkIndex'], indexes: [{ name: 'expiresAt', keyPath: 'expiresAt' }] }
];

export const config = defineRecordingConfig({
  baseUrl: 'https://api.example.com',
  endpoints: {
    start: (b, id) => `${b}/recordings/${id}/start`,
    complete: (b, id) => `${b}/recordings/${id}/complete`,
    presigned: (b, id) => `${b}/recordings/${id}/presigned`
  },
  operations,
  processChunk,
  stores,
  schemaVersion: 1,
  resolveAuthToken: async (db) => (await db.getCurrentAuthToken())?.token ?? null
});
