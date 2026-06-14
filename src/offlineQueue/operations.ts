/**
 * Operation execution contracts (Phase 1).
 *
 * The neutral seam that lets one set of operation implementations run in BOTH the page
 * and the service worker. Today only the service worker consumes it (see
 * {@link ./recordingOperations}); the main-thread queue still calls {@link ITransport}
 * directly and converges onto these contracts in a later phase, once the host supplies a
 * main-thread `authedFetch`.
 *
 * An operation body is written against {@link OperationContext} only — it must never close
 * over a page http client or touch the DOM, so the same code is valid in a
 * ServiceWorkerGlobalScope.
 */

import { Priority } from './types';
import type { QueuedRequest, RequestType } from './types';

/** A single HTTP request an operation wants performed (auth applied by the context). */
export interface RequestSpec {
  url: string;
  method?: 'GET' | 'POST' | 'PUT';
  headers?: Record<string, string>;
  body?: BodyInit | null;
}

/**
 * REST endpoint URL builders. Backend-specific; the default values target the
 * recording-service contract (see the service-worker factory). Isolating them here keeps
 * the literal `/api/v0/...` paths out of the engine skeleton.
 */
export interface RecordingEndpoints {
  start: (baseUrl: string, pathIdentifier: string) => string;
  complete: (baseUrl: string, pathIdentifier: string) => string;
  presigned: (baseUrl: string, pathIdentifier: string) => string;
}

/** Timing knobs shared by the engine skeleton and the operations. */
export interface EngineTimings {
  /** Max upload attempts before a chunk is marked FAILED. */
  maxChunkAttempts: number;
  /** How long a freshly fetched presigned URL is considered valid. */
  presignedTtlMs: number;
  /** Delay before re-running the retry loop while operations remain. */
  autoRetryIntervalMs: number;
  /** Minimum gap between fetch-triggered pending checks. */
  networkCheckIntervalMs: number;
}

/** Built-in engine timing defaults. Worker-safe (no DOM imports). */
export const DEFAULT_TIMINGS: EngineTimings = {
  maxChunkAttempts: 5,
  presignedTtlMs: 10 * 60 * 1000,
  autoRetryIntervalMs: 10000,
  networkCheckIntervalMs: 30000
};

/**
 * Everything an operation is allowed to use. Built per drain pass by the host context
 * (page or service worker), so `baseUrl` reflects the latest SET_CONFIG value.
 */
export interface OperationContext {
  /** Backend base URL (mutable across the worker's life via SET_CONFIG). */
  baseUrl: string;
  endpoints: RecordingEndpoints;
  timings: EngineTimings;
  /** Content-Type used for the object-store PUT upload. */
  uploadContentType: string;
  /** Authed fetch: injects the bearer token and maps 401/403 to typed errors. */
  authedFetch(spec: RequestSpec): Promise<Response>;
  /** Engine persistence + blob staging (the same singleton modules in both contexts). */
  db: typeof import('./db');
  blobStorage: typeof import('./blobStorage');
}

/**
 * One entry in the operation registry — the data-driven replacement for the hard-coded
 * `RequestType` switch statements. Defining the operation set as data (rather than a
 * closed union) is what lets a consumer add/replace operations in a later phase.
 */
export interface OperationDefinition<Data = any> {
  /** Queue priority (CRITICAL/HIGH/MEDIUM/LOW). */
  priority: Priority;
  /**
   * `'request'` (default) ops are dispatched by the request loop via {@link handle}.
   * `'chunk'` ops are driven by the engine's chunk loop instead and carry no `handle`
   * (today: PRESIGNED_URL + UPLOAD_CHUNK).
   */
  kind?: 'request' | 'chunk';
  /** Max attempts before the op is marked FAILED. Defaults to the engine timing. */
  maxAttempts?: number;
  /** Perform a `'request'` op. Runs identically on the page and in the service worker. */
  handle?(ctx: OperationContext, request: QueuedRequest<Data>): Promise<void>;
}

/** Map of operation name -> definition. Replaces the closed `RequestType` union. */
export type OperationRegistry = Record<string, OperationDefinition>;

/** Priority for a request type, falling back to MEDIUM for unknown/custom types. */
export function priorityFor(registry: OperationRegistry, type: RequestType): Priority {
  return registry[type]?.priority ?? Priority.MEDIUM;
}

/** Whether a type is driven by the engine chunk loop (and skipped by the request loop). */
export function isChunkDriven(registry: OperationRegistry, type: RequestType): boolean {
  return registry[type]?.kind === 'chunk';
}
