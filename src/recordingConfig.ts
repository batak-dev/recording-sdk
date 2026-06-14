/**
 * `defineRecordingConfig` — the single config facade (Phase 3).
 *
 * Assembles schema (engine stores + consumer domain stores), codecs, the operation
 * registry, endpoints, timings, and auth into one validated, side-effect-free object that
 * BOTH the page and the service-worker entry import. It does not open the DB or touch the
 * network, so the same resolved object is safe to share across contexts.
 *
 * Back-compat: every field is optional and defaults to the built-in recording-service
 * contract, so `defineRecordingConfig()` reproduces today's behaviour.
 */
import {
  mergeStores,
  ENGINE_STORES,
  RECORDING_DOMAIN_STORES,
  ENGINE_SCHEMA_VERSION,
  DEFAULT_DB_NAME,
  type SchemaDescriptor,
  type StoreDescriptor
} from './storage/schema';
import { CODEC_PRESETS } from './config';
import type { RecorderCodecConfig } from './types';
import {
  recordingOperationRegistry,
  processRecordingChunk,
  DEFAULT_ENDPOINTS,
  DEFAULT_BASE_URL,
  DEFAULT_UPLOAD_CONTENT_TYPE
} from './offlineQueue/recordingOperations';
import {
  DEFAULT_TIMINGS,
  type OperationRegistry,
  type OperationContext,
  type RecordingEndpoints,
  type EngineTimings
} from './offlineQueue/operations';
import type { StoredChunk } from './offlineQueue/types';
import type { ITransport } from './transport/types';
import type { IAuthTokenProvider } from './auth/types';

type EngineDb = typeof import('./offlineQueue/db');
type ChunkProcessor = (ctx: OperationContext, chunk: StoredChunk) => Promise<void>;

export interface RecordingConfig {
  /** Backend base URL. */
  baseUrl?: string;
  /** IndexedDB name. */
  dbName?: string;
  /**
   * Consumer domain stores, merged with the engine-owned stores. Defaults to the built-in
   * recording-service domain stores (metadata / presigned cache / auth-token cache).
   */
  stores?: StoreDescriptor[];
  /** Bump when `stores` change so existing DBs upgrade (combined with the engine version). */
  schemaVersion?: number;
  /** Named codec presets. Defaults to the built-in VP8/VP9/AV1 presets. */
  codecs?: Record<string, RecorderCodecConfig>;
  /** Operation registry. Defaults to the built-in recording-service operations. */
  operations?: OperationRegistry;
  /** Per-chunk processor (engine owns the loop). Defaults to the recording-service one. */
  processChunk?: ChunkProcessor;
  /** Resolve a bearer token from engine storage; runs in page AND service worker. */
  resolveAuthToken?: (db: EngineDb) => Promise<string | null>;
  /** REST endpoint URL builders. Merged over the recording-service defaults. */
  endpoints?: Partial<RecordingEndpoints>;
  /** Timing knobs. Merged over the engine defaults. */
  timings?: Partial<EngineTimings>;
  /** Content-Type for the object-store PUT upload. */
  uploadContentType?: string;
  /** Page-only: lifecycle transport (prepare/salt/complete/review). Never enters the worker. */
  transport?: ITransport;
  /** Page-only: auth bookkeeping (cache token, validate session). */
  authProvider?: IAuthTokenProvider;
}

export interface ResolvedRecordingConfig {
  baseUrl: string;
  schema: SchemaDescriptor;
  codecs: Record<string, RecorderCodecConfig>;
  operations: OperationRegistry;
  processChunk: ChunkProcessor;
  resolveAuthToken?: (db: EngineDb) => Promise<string | null>;
  endpoints: RecordingEndpoints;
  timings: EngineTimings;
  uploadContentType: string;
  transport?: ITransport;
  authProvider?: IAuthTokenProvider;
}

/**
 * Validate + fill defaults + merge stores. Pure: no DB open, no network. Throws (via
 * {@link mergeStores}) if a consumer store collides with an engine-owned store.
 */
export function defineRecordingConfig(config: RecordingConfig = {}): ResolvedRecordingConfig {
  const stores = mergeStores(ENGINE_STORES, config.stores ?? RECORDING_DOMAIN_STORES);
  const version = Math.max(ENGINE_SCHEMA_VERSION, config.schemaVersion ?? 0);

  return {
    baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
    schema: { dbName: config.dbName ?? DEFAULT_DB_NAME, version, stores },
    codecs: config.codecs ?? CODEC_PRESETS,
    operations: config.operations ?? recordingOperationRegistry,
    processChunk: config.processChunk ?? processRecordingChunk,
    resolveAuthToken: config.resolveAuthToken,
    endpoints: { ...DEFAULT_ENDPOINTS, ...config.endpoints },
    timings: { ...DEFAULT_TIMINGS, ...config.timings },
    uploadContentType: config.uploadContentType ?? DEFAULT_UPLOAD_CONTENT_TYPE,
    transport: config.transport,
    authProvider: config.authProvider
  };
}
