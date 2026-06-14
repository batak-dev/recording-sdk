/**
 * Recording-service operations (Phase 1 extraction).
 *
 * The chunk-upload and request state machine that the service worker previously inlined.
 * Moved here verbatim and rewritten against {@link OperationContext} so it is portable
 * (no closure over the worker's globals) and is the single place the recording-service
 * REST shapes (`{ chunk_index }`, `data.presigned_url`, start/complete/presigned
 * endpoints) live. The engine skeleton (drain loop, background sync, events) stays in the
 * service-worker factory and calls into these functions.
 *
 * Behaviour is intentionally identical to the previous inline implementation; this is a
 * pure relocation. In a later phase these become data-driven operation definitions in the
 * consumer's config (the recording-service specifics leave the SDK entirely).
 */
import { Priority } from './types';
import type { QueuedRequest, StoredChunk } from './types';
import type { OperationContext, OperationRegistry, RecordingEndpoints } from './operations';

/**
 * Default recording-service REST endpoint builders. The literal `/api/v0/...` paths live
 * here (recording-service specifics), not in the engine skeleton. Worker-safe: no DOM imports.
 */
export const DEFAULT_ENDPOINTS: RecordingEndpoints = {
  start: (base, id) => `${base}/api/v0/all/recordings/${id}/start`,
  complete: (base, id) => `${base}/api/v0/all/recordings/${id}/complete`,
  presigned: (base, id) => `${base}/api/v0/all/recordings/${id}/presigned`
};

/** Fallback recording-service base URL when none is configured or recoverable. */
export const DEFAULT_BASE_URL = 'http://localhost:8082';

/** Content-Type used for the object-store PUT upload. */
export const DEFAULT_UPLOAD_CONTENT_TYPE = 'video/webm';

// ---- Auth bookkeeping for chunk-associated requests ----------------------------------

async function markChunkRequestsNeedsAuth(ctx: OperationContext, chunk: StoredChunk): Promise<void> {
  for (const id of [chunk.uploadRequestId, chunk.presignedRequestId]) {
    if (!id) continue;
    const req = await ctx.db.getRequest(id);
    if (req && req.status !== 'COMPLETED') {
      req.status = 'NEEDS_AUTH';
      req.updatedAt = Date.now();
      await ctx.db.updateRequest(req);
    }
  }
}

async function markChunkRequestCompleted(ctx: OperationContext, chunk: StoredChunk): Promise<void> {
  for (const id of [chunk.uploadRequestId, chunk.presignedRequestId]) {
    if (!id) continue;
    const req = await ctx.db.getRequest(id);
    if (req && req.status !== 'COMPLETED') {
      req.status = 'COMPLETED';
      req.updatedAt = Date.now();
      await ctx.db.updateRequest(req);
    }
  }
}

// When a chunk is permanently FAILED, fail its chunk-driven requests too. The retry loop
// skips PRESIGNED_URL/UPLOAD_CHUNK requests (the chunk loop owns them), so leaving them
// PENDING would otherwise keep `remaining` > 0 forever and block COMPLETE_RECORDING's deps.
export async function markChunkRequestsFailed(
  ctx: OperationContext,
  chunk: StoredChunk,
  error: string
): Promise<void> {
  for (const id of [chunk.uploadRequestId, chunk.presignedRequestId]) {
    if (!id) continue;
    const req = await ctx.db.getRequest(id);
    if (req && req.status !== 'COMPLETED' && req.status !== 'FAILED') {
      req.status = 'FAILED';
      req.error = error;
      req.updatedAt = Date.now();
      await ctx.db.updateRequest(req);
    }
  }
}

// ---- Chunk processing ----------------------------------------------------------------

export async function processRecordingChunk(ctx: OperationContext, chunk: StoredChunk): Promise<void> {
  const blob = await ctx.blobStorage.retrieveBlob(chunk.blobId);
  if (!blob) throw new Error(`Blob ${chunk.blobId} not found`);

  let uploadUrl = chunk.presignedUrl;
  const expired = !chunk.presignedUrlExpiresAt || chunk.presignedUrlExpiresAt < Date.now();

  if (!uploadUrl || expired) {
    try {
      const response = await ctx.authedFetch({
        url: ctx.endpoints.presigned(ctx.baseUrl, chunk.pathIdentifier),
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chunk_index: chunk.chunkIndex })
      });
      if (!response.ok) throw new Error(`Presigned URL request failed: ${response.status}`);

      const data = await response.json();
      uploadUrl = data.presigned_url;
      chunk.presignedUrl = uploadUrl;
      chunk.presignedUrlExpiresAt = Date.now() + ctx.timings.presignedTtlMs;
      await ctx.db.updateChunk(chunk);
    } catch (error: any) {
      if (error.message === 'AUTH_TOKEN_UNAVAILABLE' || error.message === 'AUTH_TOKEN_EXPIRED') {
        await markChunkRequestsNeedsAuth(ctx, chunk);
        throw new Error('AUTH_TOKEN_UNAVAILABLE');
      }
      throw error;
    }
  }

  const response = await fetch(uploadUrl!, {
    method: 'PUT',
    body: blob,
    headers: { 'Content-Type': ctx.uploadContentType }
  });
  if (!response.ok) throw new Error(`Upload failed: ${response.status} ${response.statusText}`);

  chunk.status = 'COMPLETED';
  await ctx.db.updateChunk(chunk);
  await markChunkRequestCompleted(ctx, chunk);
  await ctx.blobStorage.deleteBlob(chunk.blobId);
}

// ---- Request operations (handlers) ---------------------------------------------------

async function handleStartRecording(ctx: OperationContext, request: QueuedRequest): Promise<void> {
  const { pathIdentifier } = request.data;
  const response = await ctx.authedFetch({
    url: ctx.endpoints.start(ctx.baseUrl, pathIdentifier),
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  });
  if (!response.ok) throw new Error(`Start recording request failed: ${response.status}`);
}

async function handleCompleteRecording(ctx: OperationContext, request: QueuedRequest): Promise<void> {
  const { pathIdentifier } = request.data;
  const response = await ctx.authedFetch({
    url: ctx.endpoints.complete(ctx.baseUrl, pathIdentifier),
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  });
  if (!response.ok) throw new Error(`Complete recording request failed: ${response.status}`);
  request.data.result = await response.json();
}

// PREPARE/GET_SALT are never queued for the worker; a no-op handle keeps them able to
// complete and unblock dependents if one ever lands in the queue.
async function handleNoop(): Promise<void> {}

/**
 * The recording-service operation registry. Replaces the previous hard-coded `RequestType`
 * switches (priority, chunk-vs-request classification, dispatch). PRESIGNED_URL and
 * UPLOAD_CHUNK are `kind: 'chunk'` — driven by the engine chunk loop, not dispatched here.
 *
 * In a later phase this object is what moves to the consumer's config; the SDK then only
 * provides the registry contract and the engine that iterates it.
 */
export const recordingOperationRegistry: OperationRegistry = {
  START_RECORDING: { priority: Priority.CRITICAL, kind: 'request', handle: handleStartRecording },
  PRESIGNED_URL: { priority: Priority.HIGH, kind: 'chunk' },
  UPLOAD_CHUNK: { priority: Priority.HIGH, kind: 'chunk' },
  COMPLETE_RECORDING: { priority: Priority.LOW, kind: 'request', handle: handleCompleteRecording },
  PREPARE: { priority: Priority.MEDIUM, kind: 'request', handle: handleNoop },
  GET_SALT: { priority: Priority.MEDIUM, kind: 'request', handle: handleNoop }
};

// ---- Request processing (registry dispatch) ------------------------------------------

export async function processRecordingRequest(
  ctx: OperationContext,
  request: QueuedRequest,
  registry: OperationRegistry = recordingOperationRegistry
): Promise<void> {
  const def = registry[request.type];
  if (!def?.handle) throw new Error(`Unsupported request type: ${request.type}`);

  request.status = 'IN_PROGRESS';
  request.updatedAt = Date.now();
  await ctx.db.updateRequest(request);

  await def.handle(ctx, request);

  request.status = 'COMPLETED';
  request.updatedAt = Date.now();
  await ctx.db.updateRequest(request);
}
