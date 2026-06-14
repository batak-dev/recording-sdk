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
import type { QueuedRequest, StoredChunk } from '../offlineQueue/types';
import {
  type OperationContext,
  type OperationRegistry,
  type RecordingEndpoints,
  type EngineTimings,
  priorityFor,
  isChunkDriven,
  DEFAULT_TIMINGS
} from '../offlineQueue/operations';
import {
  recordingOperationRegistry,
  processRecordingChunk,
  processRecordingRequest,
  markChunkRequestsFailed,
  DEFAULT_ENDPOINTS,
  DEFAULT_BASE_URL,
  DEFAULT_UPLOAD_CONTENT_TYPE
} from '../offlineQueue/recordingOperations';

// `self` is the ServiceWorkerGlobalScope; cast once so we get clients/registration/etc.
const sw = self as unknown as ServiceWorkerGlobalScope;

/** @deprecated Use `RecordingEndpoints` from the operations module. */
export type RecordingWorkerEndpoints = RecordingEndpoints;

/**
 * Worker input. Preferred: pass a `ResolvedRecordingConfig` from `defineRecordingConfig` —
 * the page and the worker then share one config object. All fields are optional; the legacy
 * fields are still honored for back-compat.
 */
export interface RecordingWorkerOptions {
  /** Backend base URL (preferred). Also recoverable from the worker script URL / SET_CONFIG. */
  baseUrl?: string;
  /** Custom IndexedDB schema (registered via setRecordingDbSchema). */
  schema?: SchemaDescriptor;
  /** Operation registry. Defaults to the built-in recording-service operations. */
  operations?: OperationRegistry;
  /** Per-chunk processor (engine owns the loop). Defaults to the recording-service one. */
  processChunk?: (ctx: OperationContext, chunk: StoredChunk) => Promise<void>;
  /** Resolve the bearer token from engine storage. */
  resolveAuthToken?: (database: typeof db) => Promise<string | null>;
  /** Override the REST endpoint URLs (target a different backend). */
  endpoints?: Partial<RecordingEndpoints>;
  /** Timing knobs (merged over the engine defaults). */
  timings?: Partial<EngineTimings>;
  /** Content-Type used for the object-store PUT upload (default 'video/webm'). */
  uploadContentType?: string;

  // Present on ResolvedRecordingConfig but unused by the worker (page-only); accepted so the
  // whole resolved config object can be passed through unchanged.
  codecs?: unknown;
  transport?: unknown;
  authProvider?: unknown;

  // ---- Legacy aliases (deprecated; still honored) ----
  /** @deprecated use `baseUrl` */
  recordingServiceUrl?: string;
  /** @deprecated use `resolveAuthToken` */
  getAuthToken?: () => Promise<string | null>;
  /** @deprecated use `timings.maxChunkAttempts` */
  maxChunkAttempts?: number;
  /** @deprecated use `timings.autoRetryIntervalMs` */
  autoRetryIntervalMs?: number;
  /** @deprecated use `timings.networkCheckIntervalMs` */
  networkCheckIntervalMs?: number;
  /** @deprecated use `timings.presignedTtlMs` */
  presignedTtlMs?: number;
}

/**
 * Install all service-worker event handlers and the retry engine. Call once at the top of
 * your worker entry.
 */
export function createRecordingWorker(options: RecordingWorkerOptions = {}): void {
  if (options.schema) setRecordingDbSchema(options.schema);

  // The recording-service URL the page pinned onto the worker's script URL (see
  // registerRecordingWorker). Read from self.location so a Background-Sync-woken worker has the
  // correct backend even after termination, when no page is around to (re)send SET_CONFIG.
  const urlFromLocation = (): string | undefined => {
    try {
      const search = (sw as any).location?.search as string | undefined;
      if (!search) return undefined;
      return new URLSearchParams(search).get('recordingServiceUrl') ?? undefined;
    } catch {
      return undefined;
    }
  };

  let recordingServiceUrl =
    options.baseUrl ?? options.recordingServiceUrl ?? urlFromLocation() ?? DEFAULT_BASE_URL;
  const endpoints: RecordingEndpoints = { ...DEFAULT_ENDPOINTS, ...options.endpoints };
  const operations: OperationRegistry = options.operations ?? recordingOperationRegistry;
  const processChunk = options.processChunk ?? processRecordingChunk;
  const maxChunkAttempts =
    options.timings?.maxChunkAttempts ?? options.maxChunkAttempts ?? DEFAULT_TIMINGS.maxChunkAttempts;
  const autoRetryIntervalMs =
    options.timings?.autoRetryIntervalMs ?? options.autoRetryIntervalMs ?? DEFAULT_TIMINGS.autoRetryIntervalMs;
  const networkCheckIntervalMs =
    options.timings?.networkCheckIntervalMs ??
    options.networkCheckIntervalMs ??
    DEFAULT_TIMINGS.networkCheckIntervalMs;
  const uploadContentType = options.uploadContentType ?? DEFAULT_UPLOAD_CONTENT_TYPE;
  const presignedTtlMs =
    options.timings?.presignedTtlMs ?? options.presignedTtlMs ?? DEFAULT_TIMINGS.presignedTtlMs;

  const getAuthToken =
    (options.resolveAuthToken ? () => options.resolveAuthToken!(db) : options.getAuthToken) ??
    (async () => (await db.getCurrentAuthToken())?.token ?? null);

  const isOnline = () => sw.navigator?.onLine !== false;

  // Build a fresh operation context per drain pass so `baseUrl` reflects the latest
  // recordingServiceUrl (it can change at runtime via SET_CONFIG). The worker's
  // (url, init) authedFetch is adapted to the context's RequestSpec shape.
  const buildContext = (): OperationContext => ({
    baseUrl: recordingServiceUrl,
    endpoints,
    timings: { maxChunkAttempts, presignedTtlMs, autoRetryIntervalMs, networkCheckIntervalMs },
    uploadContentType,
    authedFetch: (spec) =>
      authenticatedFetch(spec.url, {
        method: spec.method,
        headers: spec.headers,
        body: spec.body ?? undefined
      }),
    db,
    blobStorage
  });

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

  // Chunk/request processing (the recording-service operations) live in
  // ../offlineQueue/recordingOperations and run against an OperationContext from
  // buildContext() above. The engine skeleton below owns the drain loop, retry/attempt
  // bookkeeping, Background Sync arming, and client notifications.

  async function checkDependencies(request: QueuedRequest): Promise<boolean> {
    if (!request.dependencies || request.dependencies.length === 0) return true;
    for (const depId of request.dependencies) {
      const dep = await db.getRequest(depId);
      if (!dep || dep.status !== 'COMPLETED') return false;
    }
    return true;
  }

  // ---- Retry orchestration -----------------------------------------------------------

  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  /**
   * (Re)arm a one-shot Background Sync so a *closed* page still drains later. This is the
   * only event that wakes a terminated worker on reconnect, so we re-arm it whenever work
   * is left behind (deferred to a client, or still pending after a pass).
   */
  async function armBackgroundSync(): Promise<void> {
    try {
      await (sw.registration as any)?.sync?.register('retry-queue');
    } catch {
      // Background Sync unavailable — the online/fetch handlers remain as best-effort fallbacks.
    }
  }

  let retrying = false;

  /**
   * One pass over every PENDING chunk, then every PENDING request. Chunk uploads are driven
   * here (processRecordingChunk also marks their PRESIGNED_URL/UPLOAD_CHUNK requests COMPLETED), so the
   * request loop skips those types rather than mis-handling them as "unsupported".
   * Returns how many ops it advanced and how many remain PENDING.
   */
  async function drainOnce(): Promise<{ progressed: number; remaining: number }> {
    let progressed = 0;
    const ctx = buildContext();

    for (const chunk of await db.getChunksByStatus('PENDING')) {
      if (!isOnline()) break;
      const fresh = await db.getChunk(chunk.pathIdentifier, chunk.chunkIndex);
      if (!fresh || fresh.status !== 'PENDING') continue;
      fresh.status = 'IN_PROGRESS';
      await db.updateChunk(fresh);
      try {
        await processChunk(ctx, fresh);
        progressed++;
        await notifyClients({
          type: 'CHUNK_UPLOADED',
          chunkIndex: chunk.chunkIndex,
          pathIdentifier: chunk.pathIdentifier
        });
      } catch (error) {
        const reload = await db.getChunk(chunk.pathIdentifier, chunk.chunkIndex);
        if (reload) {
          if (!isNetworkError(error)) reload.attempts++;
          reload.status = reload.attempts >= maxChunkAttempts ? 'FAILED' : 'PENDING';
          await db.updateChunk(reload);
          if (reload.status === 'FAILED') {
            await markChunkRequestsFailed(ctx, reload, String((error as any)?.message ?? error));
          }
        }
      }
    }

    const requests = (await db.getRequestsByStatus('PENDING')).sort((a, b) => {
      const pa = a.priority ?? priorityFor(operations, a.type);
      const pb = b.priority ?? priorityFor(operations, b.type);
      return pa !== pb ? pa - pb : a.createdAt - b.createdAt;
    });
    for (const request of requests) {
      if (!isOnline()) break;
      // PRESIGNED_URL/UPLOAD_CHUNK are chunk-driven (see the chunk loop above).
      if (isChunkDriven(operations, request.type)) continue;
      const fresh = await db.getRequest(request.id);
      if (!fresh || fresh.status !== 'PENDING') continue;
      if (!(await checkDependencies(fresh))) continue;
      try {
        await processRecordingRequest(ctx, fresh, operations);
        progressed++;
        await notifyClients({ type: 'REQUEST_COMPLETED', requestId: request.id, requestType: request.type });
        // Once the recording is completed on the server, purge its now-redundant queue data
        // (chunks/blobs/requests/metadata); the resilience log is kept for the report.
        if (fresh.type === 'COMPLETE_RECORDING' && fresh.data?.pathIdentifier) {
          await db.clearRecordingData(fresh.data.pathIdentifier, { keepResilienceLog: true });
        }
      } catch (error: any) {
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

    const remaining =
      (await db.getChunksByStatus('PENDING')).length + (await db.getRequestsByStatus('PENDING')).length;
    return { progressed, remaining };
  }

  /**
   * Drain the queue to completion (or until no further progress) *within the caller's event
   * lifetime* — never via a post-event timer, which a terminated worker would never run.
   * Returns the number of still-PENDING operations: callers fired from the `sync` event reject
   * when this is > 0 so the browser re-fires the sync (durable, survives worker termination).
   *
   * Returns -1 when it did not run to completion (offline, already running, or deferred to an
   * open page) — the caller should not treat that as "queue drained".
   */
  async function runRetryQueue(): Promise<number> {
    if (!isOnline() || retrying) return -1;
    retrying = true;
    try {
      // Defer to the page when it's open and driving the queue (avoids double-processing),
      // but re-arm a background sync so the worker still takes over once the page closes.
      // includeUncontrolled: a freshly-loaded page runs its OfflineQueueManager even before
      // the worker claims it, so treat any open window of this origin as "the page has it".
      const clients = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (clients.length > 0) {
        await notifyClients({ type: 'SW_READY', message: 'Service Worker deferring to open client' });
        await armBackgroundSync();
        return -1;
      }

      let totalProgressed = 0;
      let remaining = 0;
      const maxPasses = 8;
      for (let pass = 0; pass < maxPasses; pass++) {
        const result = await drainOnce();
        totalProgressed += result.progressed;
        remaining = result.remaining;
        if (remaining === 0) break;
        if (result.progressed === 0) break; // no progress this pass — let Background Sync retry later
        if (!isOnline()) break;
        await delay(autoRetryIntervalMs);
      }

      await notifyClients({
        type: 'SYNC_COMPLETE',
        successCount: totalProgressed,
        chunkSuccessCount: totalProgressed,
        requestSuccessCount: totalProgressed,
        remaining
      });

      return remaining;
    } catch (error) {
      console.error('[SW] Error during retry:', error);
      return -1;
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
        const remaining = await runRetryQueue();
        // Arm Background Sync so the queue still drains after the worker is terminated,
        // whether work is left over (remaining > 0) or we deferred/were offline (-1).
        if (remaining !== 0) await armBackgroundSync();
      })
    );
  });

  sw.addEventListener('sync', (event: any) => {
    if (event.tag !== 'retry-queue') return;
    event.waitUntil(
      (async () => {
        const remaining = await runRetryQueue();
        if (remaining > 0) {
          // Real work still pending after draining: reject so the browser re-fires the sync
          // (with its own backoff). Durable across worker termination, unlike an in-worker timer.
          throw new Error(`retry-queue: work remaining (${remaining})`);
        }
        if (remaining < 0) {
          // Deferred to an open page / offline / busy — resolve this firing but keep a fresh
          // sync armed (resets backoff) so we still take over once the page closes / reconnects.
          await armBackgroundSync();
        }
        // remaining === 0: queue fully drained — let the sync settle.
      })()
    );
  });

  // Best-effort extra trigger; unreliable for a terminated worker, so Background Sync above
  // remains the source of truth for the closed-page reconnect path.
  sw.addEventListener('online' as any, () => {
    runRetryQueue()
      .then((remaining) => (remaining !== 0 ? armBackgroundSync() : undefined))
      .catch((e) => console.error('[SW] Retry failed after coming online:', e));
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
          const remaining = await runRetryQueue();
          if (remaining !== 0) await armBackgroundSync();
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
      runRetryQueue()
        .then((remaining) => {
          if (remaining !== 0) armBackgroundSync();
          event.ports?.[0]?.postMessage({ success: true });
        })
        .catch((error) => event.ports?.[0]?.postMessage({ success: false, error: error.message }));
    }
  });
}
