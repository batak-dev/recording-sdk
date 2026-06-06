/**
 * Service-worker factory.
 *
 * `createRecordingWorker()` wires up the background-sync retry engine inside a service
 * worker. It reuses the SDK's IndexedDB layer (`db`/`blobStorage`) and schema descriptor,
 * so the worker and the main thread share one source of truth (no duplicated schema or
 * CRUD as in the original hand-written sw.js).
 *
 * Build-time usage (the "standard solution"): a consumer writes a tiny `sw-entry.ts` that
 * imports this factory and passes any custom adapters, then their bundler emits a single
 * self-contained worker served at the origin root. A prebuilt zero-config worker is also
 * shipped (`dist/sw.default.js`).
 *
 * This module targets the ServiceWorkerGlobalScope (WebWorker lib), not the DOM.
 */
import * as db from '../offlineQueue/db';
import * as blobStorage from '../offlineQueue/blobStorage';
import { setRecordingDbSchema } from '../offlineQueue/db';
import type { SchemaDescriptor } from '../storage/schema';
import { Priority } from '../offlineQueue/types';
import type { QueuedRequest, RequestType, StoredChunk } from '../offlineQueue/types';

// `self` is the ServiceWorkerGlobalScope; cast once so we get clients/registration/etc.
const sw = self as unknown as ServiceWorkerGlobalScope;

export interface RecordingWorkerEndpoints {
  start: (baseUrl: string, pathIdentifier: string) => string;
  complete: (baseUrl: string, pathIdentifier: string) => string;
  presigned: (baseUrl: string, pathIdentifier: string) => string;
}

const DEFAULT_ENDPOINTS: RecordingWorkerEndpoints = {
  start: (base, id) => `${base}/api/v0/all/recordings/${id}/start`,
  complete: (base, id) => `${base}/api/v0/all/recordings/${id}/complete`,
  presigned: (base, id) => `${base}/api/v0/all/recordings/${id}/presigned`
};

export interface RecordingWorkerOptions {
  /** Recording-service base URL. Can also be set/updated at runtime via a SET_CONFIG message. */
  recordingServiceUrl?: string;
  /** Custom IndexedDB schema (registered via setRecordingDbSchema). */
  schema?: SchemaDescriptor;
  /** Resolve the bearer token. Defaults to the most-recent valid token in the auth-token cache. */
  getAuthToken?: () => Promise<string | null>;
  /** Override the REST endpoint URLs (target a different backend). */
  endpoints?: Partial<RecordingWorkerEndpoints>;
  /** Max upload attempts before a chunk is marked FAILED (default 5). */
  maxChunkAttempts?: number;
  /** Delay before re-running the retry loop while operations remain (default 10000ms). */
  autoRetryIntervalMs?: number;
  /** Minimum gap between fetch-triggered pending checks (default 30000ms). */
  networkCheckIntervalMs?: number;
  /** Content-Type used for the object-store PUT upload (default 'video/webm'). */
  uploadContentType?: string;
  /** How long a freshly fetched presigned URL is considered valid (default 10min). */
  presignedTtlMs?: number;
}

/**
 * Install all service-worker event handlers and the retry engine. Call once at the top of
 * your worker entry.
 */
export function createRecordingWorker(options: RecordingWorkerOptions = {}): void {
  if (options.schema) setRecordingDbSchema(options.schema);

  let recordingServiceUrl = options.recordingServiceUrl ?? 'http://localhost:8082';
  const endpoints: RecordingWorkerEndpoints = { ...DEFAULT_ENDPOINTS, ...options.endpoints };
  const maxChunkAttempts = options.maxChunkAttempts ?? 5;
  const autoRetryIntervalMs = options.autoRetryIntervalMs ?? 10000;
  const networkCheckIntervalMs = options.networkCheckIntervalMs ?? 30000;
  const uploadContentType = options.uploadContentType ?? 'video/webm';
  const presignedTtlMs = options.presignedTtlMs ?? 10 * 60 * 1000;

  const getAuthToken =
    options.getAuthToken ?? (async () => (await db.getCurrentAuthToken())?.token ?? null);

  const isOnline = () => sw.navigator?.onLine !== false;

  function getRequestPriority(type: RequestType): Priority {
    switch (type) {
      case 'START_RECORDING':
        return Priority.CRITICAL;
      case 'PRESIGNED_URL':
      case 'UPLOAD_CHUNK':
        return Priority.HIGH;
      case 'COMPLETE_RECORDING':
        return Priority.LOW;
      default:
        return Priority.MEDIUM;
    }
  }

  async function notifyClients(message: any): Promise<void> {
    const clients = await sw.clients.matchAll({ type: 'window' });
    for (const client of clients) client.postMessage(message);
  }

  async function authenticatedFetch(url: string, init: RequestInit): Promise<Response> {
    const token = await getAuthToken();
    if (!token) throw new Error('AUTH_TOKEN_UNAVAILABLE');

    const response = await fetch(url, {
      ...init,
      headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` }
    });

    if (response.status === 401) throw new Error('AUTH_TOKEN_EXPIRED');
    if (response.status === 403) throw new Error('AUTH_FORBIDDEN');
    return response;
  }

  function isNetworkError(error: any): boolean {
    const message = String(error?.message ?? error);
    return message.includes('Failed to fetch') || message.includes('NetworkError') || !isOnline();
  }

  // ---- Auth bookkeeping for chunk-associated requests --------------------------------

  async function markChunkRequestsNeedsAuth(chunk: StoredChunk): Promise<void> {
    for (const id of [chunk.uploadRequestId, chunk.presignedRequestId]) {
      if (!id) continue;
      const req = await db.getRequest(id);
      if (req && req.status !== 'COMPLETED') {
        req.status = 'NEEDS_AUTH';
        req.updatedAt = Date.now();
        await db.updateRequest(req);
      }
    }
  }

  async function markChunkRequestCompleted(chunk: StoredChunk): Promise<void> {
    for (const id of [chunk.uploadRequestId, chunk.presignedRequestId]) {
      if (!id) continue;
      const req = await db.getRequest(id);
      if (req && req.status !== 'COMPLETED') {
        req.status = 'COMPLETED';
        req.updatedAt = Date.now();
        await db.updateRequest(req);
      }
    }
  }

  // ---- Chunk processing --------------------------------------------------------------

  async function processChunk(chunk: StoredChunk): Promise<void> {
    const blob = await blobStorage.retrieveBlob(chunk.blobId);
    if (!blob) throw new Error(`Blob ${chunk.blobId} not found`);

    let uploadUrl = chunk.presignedUrl;
    const expired = !chunk.presignedUrlExpiresAt || chunk.presignedUrlExpiresAt < Date.now();

    if (!uploadUrl || expired) {
      try {
        const response = await authenticatedFetch(endpoints.presigned(recordingServiceUrl, chunk.pathIdentifier), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chunk_index: chunk.chunkIndex })
        });
        if (!response.ok) throw new Error(`Presigned URL request failed: ${response.status}`);

        const data = await response.json();
        uploadUrl = data.presigned_url;
        chunk.presignedUrl = uploadUrl;
        chunk.presignedUrlExpiresAt = Date.now() + presignedTtlMs;
        await db.updateChunk(chunk);
      } catch (error: any) {
        if (error.message === 'AUTH_TOKEN_UNAVAILABLE' || error.message === 'AUTH_TOKEN_EXPIRED') {
          await markChunkRequestsNeedsAuth(chunk);
          throw new Error('AUTH_TOKEN_UNAVAILABLE');
        }
        throw error;
      }
    }

    const response = await fetch(uploadUrl!, {
      method: 'PUT',
      body: blob,
      headers: { 'Content-Type': uploadContentType }
    });
    if (!response.ok) throw new Error(`Upload failed: ${response.status} ${response.statusText}`);

    chunk.status = 'COMPLETED';
    await db.updateChunk(chunk);
    await markChunkRequestCompleted(chunk);
    await blobStorage.deleteBlob(chunk.blobId);
  }

  // ---- Request processing ------------------------------------------------------------

  async function checkDependencies(request: QueuedRequest): Promise<boolean> {
    if (!request.dependencies || request.dependencies.length === 0) return true;
    for (const depId of request.dependencies) {
      const dep = await db.getRequest(depId);
      if (!dep || dep.status !== 'COMPLETED') return false;
    }
    return true;
  }

  async function processRequest(request: QueuedRequest): Promise<void> {
    request.status = 'IN_PROGRESS';
    request.updatedAt = Date.now();
    await db.updateRequest(request);

    const { pathIdentifier } = request.data;

    switch (request.type) {
      case 'START_RECORDING': {
        const response = await authenticatedFetch(endpoints.start(recordingServiceUrl, pathIdentifier), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        if (!response.ok) throw new Error(`Start recording request failed: ${response.status}`);
        break;
      }
      case 'COMPLETE_RECORDING': {
        const response = await authenticatedFetch(endpoints.complete(recordingServiceUrl, pathIdentifier), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        if (!response.ok) throw new Error(`Complete recording request failed: ${response.status}`);
        request.data.result = await response.json();
        break;
      }
      case 'PREPARE':
      case 'GET_SALT':
        // Never queued for the worker — mark completed to unblock dependents.
        break;
      default:
        throw new Error(`Unsupported request type: ${request.type}`);
    }

    request.status = 'COMPLETED';
    request.updatedAt = Date.now();
    await db.updateRequest(request);
  }

  // ---- Retry orchestration -----------------------------------------------------------

  let retrying = false;

  async function retryPendingOperations(): Promise<void> {
    if (!isOnline()) return;
    if (retrying) return;
    retrying = true;
    try {
      // Defer to the page when it's open and driving the queue.
      const clients = await sw.clients.matchAll({ type: 'window', includeUncontrolled: false });
      if (clients.length > 0) {
        await notifyClients({ type: 'SW_READY', message: 'Service Worker ready but deferring' });
        return;
      }

      const chunks = (await db.getAllChunks()).filter((c) => c.status === 'PENDING');
      const requests = (await db.getAllRequests()).filter((r) => r.status === 'PENDING');
      if (chunks.length === 0 && requests.length === 0) return;

      let chunkSuccess = 0;
      let chunkFail = 0;
      for (const chunk of chunks) {
        const fresh = await db.getChunk(chunk.pathIdentifier, chunk.chunkIndex);
        if (!fresh || fresh.status !== 'PENDING') continue;
        fresh.status = 'IN_PROGRESS';
        await db.updateChunk(fresh);
        try {
          await processChunk(fresh);
          chunkSuccess++;
          await notifyClients({
            type: 'CHUNK_UPLOADED',
            chunkIndex: chunk.chunkIndex,
            pathIdentifier: chunk.pathIdentifier
          });
        } catch (error) {
          chunkFail++;
          const reload = await db.getChunk(chunk.pathIdentifier, chunk.chunkIndex);
          if (reload) {
            if (!isNetworkError(error)) reload.attempts++;
            reload.status = reload.attempts >= maxChunkAttempts ? 'FAILED' : 'PENDING';
            await db.updateChunk(reload);
          }
        }
      }

      requests.sort((a, b) => {
        const pa = a.priority ?? getRequestPriority(a.type);
        const pb = b.priority ?? getRequestPriority(b.type);
        return pa !== pb ? pa - pb : a.createdAt - b.createdAt;
      });

      let reqSuccess = 0;
      let reqFail = 0;
      for (const request of requests) {
        const fresh = await db.getRequest(request.id);
        if (!fresh || fresh.status !== 'PENDING') continue;
        if (!(await checkDependencies(fresh))) continue;
        try {
          await processRequest(fresh);
          reqSuccess++;
          await notifyClients({ type: 'REQUEST_COMPLETED', requestId: request.id, requestType: request.type });
        } catch (error: any) {
          reqFail++;
          const reload = await db.getRequest(request.id);
          if (reload) {
            if (!isNetworkError(error)) reload.attempts++;
            if (error.message === 'AUTH_TOKEN_UNAVAILABLE' || error.message === 'AUTH_TOKEN_EXPIRED') {
              reload.status = 'NEEDS_AUTH';
            } else if (reload.attempts >= reload.maxAttempts) {
              reload.status = 'FAILED';
              reload.error = error.message;
            } else {
              reload.status = 'PENDING';
            }
            reload.updatedAt = Date.now();
            await db.updateRequest(reload);
          }
        }
      }

      await notifyClients({
        type: 'SYNC_COMPLETE',
        chunkSuccessCount: chunkSuccess,
        chunkFailCount: chunkFail,
        requestSuccessCount: reqSuccess,
        requestFailCount: reqFail
      });

      const remainingChunks = await db.getChunksByStatus('PENDING');
      const remainingRequests = await db.getRequestsByStatus('PENDING');
      if ((remainingChunks.length > 0 || remainingRequests.length > 0) && isOnline()) {
        setTimeout(() => {
          retryPendingOperations().catch((e) => console.error('[SW] Scheduled retry failed:', e));
        }, autoRetryIntervalMs);
      }
    } catch (error) {
      console.error('[SW] Error during retry:', error);
    } finally {
      retrying = false;
    }
  }

  // ---- Event wiring ------------------------------------------------------------------

  sw.addEventListener('install', () => {
    sw.skipWaiting();
  });

  sw.addEventListener('activate', (event: any) => {
    event.waitUntil(
      sw.clients.claim().then(async () => {
        if (!isOnline()) return;
        const pendingChunks = await db.getChunksByStatus('PENDING');
        const pendingRequests = await db.getRequestsByStatus('PENDING');
        if (pendingChunks.length > 0 || pendingRequests.length > 0) {
          setTimeout(() => {
            retryPendingOperations().catch((e) => console.error('[SW] Auto-retry failed on activation:', e));
          }, 1000);
        }
      })
    );
  });

  sw.addEventListener('sync', (event: any) => {
    if (event.tag === 'retry-queue') {
      event.waitUntil(retryPendingOperations());
    }
  });

  sw.addEventListener('online' as any, () => {
    retryPendingOperations().catch((e) => console.error('[SW] Retry failed after coming online:', e));
  });

  let lastNetworkCheck = 0;
  sw.addEventListener('fetch', (event: any) => {
    const now = Date.now();
    if (now - lastNetworkCheck <= networkCheckIntervalMs) return;
    lastNetworkCheck = now;
    if (!isOnline()) return;
    event.waitUntil(
      (async () => {
        const pendingChunks = await db.getChunksByStatus('PENDING');
        const pendingRequests = await db.getRequestsByStatus('PENDING');
        if (pendingChunks.length > 0 || pendingRequests.length > 0) {
          await retryPendingOperations();
        }
      })().catch(() => {})
    );
  });

  sw.addEventListener('message', (event: any) => {
    const data = event.data || {};
    if (data.type === 'SET_CONFIG') {
      if (data.recordingServiceUrl) recordingServiceUrl = data.recordingServiceUrl;
      event.ports?.[0]?.postMessage({ success: true });
    } else if (data.type === 'TRIGGER_SYNC') {
      retryPendingOperations()
        .then(() => event.ports?.[0]?.postMessage({ success: true }))
        .catch((error) => event.ports?.[0]?.postMessage({ success: false, error: error.message }));
    }
  });
}
