# Configurable architecture (design)

Status: **proposal / Phase 0**. This document locks the public API shapes before any
code moves. Nothing here is implemented yet; it is the contract that Phases 1–6 build
toward. Type signatures are normative — review them here first, then implement.

---

## 1. Goal

Turn the SDK from a library that is *tightly coupled* to `recording-service` into a
backend-agnostic **engine** whose backend contract is supplied entirely by the consumer
— the Prisma/Drizzle relationship: the engine lives in the library, *your* schema and
*your* operations live in *your* repo.

After this change:

- The SDK contains **zero** knowledge of `/api/v0/all/recordings`, presigned URLs, salt
  exchange, or OCEAN/review DTOs.
- The consumer (the frontend) owns one `recording.config.ts` that defines the transport,
  the operations, the wire DTOs, the domain stores, the endpoints, and auth resolution.
- The service worker is generated from that same config and keeps a fixed internal
  structure.

### Non-goals

- Reimplementing the durable queue per consumer. The engine keeps ownership of the
  plumbing that makes durability work (see §3).
- Making the capture pipeline (WebCodecs / MediaPipe ROI segmentation / muxer /
  signed-chunk format) reconfigurable. It stays core; extension is via the existing
  callback/strategy seams only.

---

## 2. The two tiers

```
┌────────────────────────────────────────────────────────────────────┐
│ @batak-dev/recording-sdk  — ENGINE + CONTRACTS (backend-agnostic)   │
│                                                                      │
│  engine     queue state machine, dependency resolver, retry/backoff,│
│             priority ordering                                        │
│  engine     SW skeleton + background-sync orchestration (fixed)      │
│  engine     blob staging, resilience collector                       │
│  engine     internal stores (namespaced): pendingRequests,          │
│             blobStore, resilienceLog                                  │
│  capture    WebCodecs pipeline, MediaPipe ROI/segmentation, muxer,  │
│             signed-chunk  (core, non-reconfigurable)                 │
│  contracts  ITransport, IAuthTokenProvider, IQualityStrategy,       │
│             StoreDescriptor, OperationDefinition,                    │
│             defineRecordingConfig()                                   │
└────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────┐
│ frontend repo  — THE BACKEND CONTRACT (fully user-land)             │
│                                                                      │
│  services/recording.config.ts   ← defineRecordingConfig({...})      │
│    transport         the RecordingServiceTransport (moved here)      │
│    operations        START / PRESIGNED / UPLOAD / COMPLETE handlers │
│    stores            presignedUrlCache, authTokenCache,             │
│                      recordingMetadata, chunk shape                  │
│    wire DTOs         recordingServiceTypes.ts (moved here)           │
│    endpoints, timings                                                │
│    resolveAuthToken                                                  │
└────────────────────────────────────────────────────────────────────┘
```

### What physically leaves the SDK

| Today (in SDK)                                   | After (in frontend)                    |
| ------------------------------------------------ | -------------------------------------- |
| `transport/RecordingServiceTransport.ts`         | `recording.config.ts` → `transport`    |
| `transport/recordingServiceTypes.ts`             | `recording.config.ts` → wire DTOs      |
| recording-service logic in `requestHandlers.ts`  | `recording.config.ts` → `operations`   |
| recording-service logic in `sw/worker.ts`        | (deleted — unified into operations)    |
| domain stores in `storage/schema.ts`             | `recording.config.ts` → `stores`       |

The SDK keeps `ITransport`/`IAuthTokenProvider`/`IQualityStrategy` as **interfaces**, not
implementations.

---

## 3. The hard constraint: engine-owned plumbing stores

The queue's durability guarantee ("survives page close, drains via Background Sync") is
*implemented by* its persistence. If a consumer could redefine or remove those stores,
they would be reimplementing the engine and the guarantee would no longer hold.

Therefore the engine **keeps ownership** of its internal stores. Implemented in Phase 2 as
`ENGINE_STORES` in `storage/schema.ts` — the durable request queue, blob staging, the
resilience log, and the minimal chunk store:

```ts
export const ENGINE_STORE_NAMES: readonly string[] = ENGINE_STORES.map((s) => s.name);
// -> ['pendingRequests', 'pendingChunks', 'blobStore', 'resilienceLog']
```

**Decision (Phase 2):** engine stores keep their established names rather than gaining a
`__rec_` prefix. A prefix would orphan data in already-deployed IndexedDB databases (a field
migration), and the collision-prevention goal is met without it: `mergeStores(engine, user)`
**throws** if a consumer store reuses an engine-owned name (or duplicates another consumer
store). So the plumbing can never be silently overridden, with no migration cost.

Everything else — `presignedUrlCache`, `authTokenCache`, `recordingMetadata` (Phase 2:
`RECORDING_DOMAIN_STORES`), and the *backend-specific fields* of a chunk — is **domain**
data declared by the consumer in config.

> Note: `pendingChunks` is a gray area. The engine needs to know *that* chunks exist to
> drive the upload loop, but their backend-specific fields (presigned URL, signature) are
> domain data. Resolution: the engine defines the **minimal chunk store** (keyPath +
> status index) as an engine store; the consumer extends its record shape via the
> operation data types (§5). The store is engine-owned; the payload is user-typed.

---

## 4. `defineRecordingConfig`

One call assembles the whole contract. Generic over the consumer's operation map so
request `data` is fully typed end to end.

```ts
import type { SchemaDescriptor, StoreDescriptor } from './storage/schema';
import type { ITransport } from './transport/types';
import type { OperationDefinition, OperationMap } from './offlineQueue/operations';

export interface RecordingConfig<Ops extends OperationMap> {
  // ---- PORTABLE (bundled into BOTH the page and the generated sw.js) ----

  /** Consumer domain stores. Merged with engine-internal stores at DB-open time. */
  stores?: StoreDescriptor[];

  /** Bump when `stores` change so existing DBs upgrade. */
  schemaVersion?: number;

  /** Named codec presets. Replaces the SDK's hard-coded CODEC_PRESETS. */
  codecs?: Record<string, RecorderCodecConfig>;

  /** The operation registry — replaces the closed RequestType union. */
  operations: Ops;

  /** Resolve a bearer token from engine storage; runs in page AND sw. */
  resolveAuthToken?: (db: EngineDb) => Promise<string | null>;

  /** URL builders + timing knobs the operations and SW skeleton read. */
  endpoints?: Record<string, (...args: string[]) => string>;
  timings?: Partial<EngineTimings>;

  // ---- PAGE-ONLY (never bundled into the sw.js) ----

  /** Lifecycle calls the page drives directly (prepare/salt/complete/review). */
  transport?: ITransport;

  /** Page-side auth bookkeeping (cache token, validate session). */
  authProvider?: IAuthTokenProvider;
}

export interface EngineTimings {
  maxChunkAttempts: number;      // default 5
  presignedTtlMs: number;        // default 10 * 60_000
  autoRetryIntervalMs: number;   // default 10_000
  networkCheckIntervalMs: number;// default 30_000
}

/** The assembled, validated config. Imported by both the page and the SW entry. */
export interface ResolvedRecordingConfig<Ops extends OperationMap> {
  schema: SchemaDescriptor;            // engine stores merged with config.stores
  codecs: Record<string, RecorderCodecConfig>;
  operations: Ops;
  resolveAuthToken: (db: EngineDb) => Promise<string | null>;
  endpoints: Record<string, (...args: string[]) => string>;
  timings: EngineTimings;
  transport?: ITransport;
  authProvider?: IAuthTokenProvider;
}

export function defineRecordingConfig<Ops extends OperationMap>(
  config: RecordingConfig<Ops>
): ResolvedRecordingConfig<Ops>;
```

`defineRecordingConfig` is pure and side-effect free: it validates, fills defaults, and
merges stores. It does **not** open the DB or touch the network — so the exact same
resolved object can be imported by the page and by the service-worker entry.

> **Implemented in Phase 3** (`src/recordingConfig.ts`). The shipped `RecordingConfig`
> also carries `baseUrl`, `dbName`, `processChunk` (the per-chunk processor — engine owns
> the loop, this is the backend-specific body), and `uploadContentType`. Not generic over
> `Ops` yet (the registry is `OperationRegistry`); end-to-end `data` typing via `Ops` is a
> later refinement. Worker-safe defaults (`DEFAULT_ENDPOINTS`, `DEFAULT_BASE_URL`,
> `DEFAULT_UPLOAD_CONTENT_TYPE` in `recordingOperations.ts`; `DEFAULT_TIMINGS` in
> `operations.ts`) live outside `config.ts` so the service-worker build never pulls in the
> DOM-referencing codec module.

### Store merge

```ts
function mergeStores(
  engine: StoreDescriptor[],   // the 3 reserved + minimal chunk store
  user: StoreDescriptor[],     // config.stores
): StoreDescriptor[];
// Throws if a user store name starts with the reserved '__rec_' prefix
// or duplicates an engine store name.
```

The final `SchemaDescriptor.version` is `max(ENGINE_SCHEMA_VERSION, config.schemaVersion ?? 0)`,
so engine upgrades and consumer upgrades both force `onupgradeneeded`.

---

## 5. Operations — one definition, two execution contexts

This is the core unification. Today there are **two** request engines:

- `offlineQueue/requestHandlers.ts` — runs on the main thread, calls `ITransport` (axios).
- `sw/worker.ts` — runs in the service worker, re-implements the same state machine with
  raw `fetch` and hard-coded JSON shapes.

They collapse into **one** registry of operation definitions written against a neutral
`OperationContext` that both contexts provide. The recording-service operations move to
the consumer; the SDK only defines the contract and the engine that iterates it.

```ts
import type { Priority } from './types';

/** Map of operation name -> the shape of its queued `data` payload. */
export type OperationMap = Record<string, OperationDefinition<any>>;

export interface OperationDefinition<Data> {
  /** Queue priority (CRITICAL/HIGH/MEDIUM/LOW). */
  priority: Priority;

  /**
   * Whether this op is enqueued + retried by the engine. `false` = a synchronous
   * setup call the page makes directly and never persists (today: PREPARE, GET_SALT).
   */
  queued: boolean;

  /** Max attempts before the op is marked FAILED. Defaults to engine timing. */
  maxAttempts?: number;

  /**
   * Perform the operation. Runs identically on the page and in the service worker.
   * MUST NOT close over the page's http client or touch the DOM — only `ctx`.
   */
  handle(ctx: OperationContext, request: QueuedRequest<Data>): Promise<void>;
}

/** Everything an operation is allowed to use. Provided by both the page and the SW. */
export interface OperationContext {
  /** Authed fetch: injects the bearer token from resolveAuthToken, maps 401/403. */
  authedFetch(spec: RequestSpec): Promise<Response>;

  /** Engine persistence (chunks, metadata accessors, request CRUD). */
  db: EngineDb;
  blobStorage: BlobStorage;

  /** Endpoint builders + timings from the resolved config. */
  endpoints: Record<string, (...args: string[]) => string>;
  timings: EngineTimings;

  /** Outcome signals the engine acts on. */
  markCompleted(requestId: string): Promise<void>;
  markFailed(requestId: string, error: unknown): Promise<void>;
  emit(event: string, payload?: unknown): void;

  /** True when navigator.onLine !== false (page or SW global). */
  isOnline(): boolean;
}

export interface RequestSpec {
  url: string;
  method?: 'GET' | 'POST' | 'PUT';
  headers?: Record<string, string>;
  body?: BodyInit;
}

export interface QueuedRequest<Data = unknown> {
  id: string;
  type: string;            // was the closed RequestType union; now any op name
  data: Data;              // typed via OperationMap
  status: RequestStatus;
  attempts: number;
  maxAttempts: number;
  createdAt: number;
  updatedAt: number;
  priority: Priority;
  dependencies?: string[];
  error?: string;
}
```

### Why this is safe in both contexts

`authedFetch` is the only I/O primitive. The page supplies one backed by its token
source; the SW supplies one backed by `db.getCurrentAuthToken()` and the
`AUTH_TOKEN_UNAVAILABLE / AUTH_TOKEN_EXPIRED` mapping that `sw/worker.ts` does today. The
operation body is written once and is unaware of which context it runs in. `ITransport`
is page-only and used solely for the **non-queued** lifecycle calls (prepare, salt,
complete-as-RPC, review) — never inside `handle`.

### Engine ownership of the chunk loop

`processChunk` (the presigned-fetch-then-PUT dance) stays an engine concern because the
chunk loop has subtle ordering vs. the request loop (see `drainOnce`). But the
*backend-specific bits* — how to fetch a presigned URL, what header the PUT needs — come
from the consumer's `PRESIGNED_URL` / `UPLOAD_CHUNK` operation definitions and
`uploadContentType`/`endpoints`. The engine calls into the op; the op talks to the
backend.

---

## 6. Service-worker generation

`createRecordingWorker` keeps its **fixed skeleton** (install/activate/sync/fetch/online/
message handlers, the `drainOnce`/`runRetryQueue` orchestration, Background-Sync arming).
The only thing that changes is that it takes the resolved config instead of ad-hoc
options:

```ts
export function createRecordingWorker(config: RecordingWorkerOptions): void;
```

> **Implemented in Phase 3.** Rather than a strict `ResolvedRecordingConfig` parameter,
> `createRecordingWorker` takes `RecordingWorkerOptions` — which structurally accepts a
> whole `ResolvedRecordingConfig` (preferred: `createRecordingWorker(config)`) *and* still
> honors the legacy flat options (`recordingServiceUrl`, `getAuthToken`, `maxChunkAttempts`,
> …) as deprecated aliases. This keeps the no-arg `dist/sw.default.js` and any existing
> custom worker entry working. The worker now reads `operations` + `processChunk` from the
> config (defaulting to the recording-service registry / chunk processor) instead of
> importing them hard-coded.

The consumer's `sw-entry.ts`:

```ts
import { createRecordingWorker } from '@batak-dev/recording-sdk/sw';
import config from './recording.config';   // the SAME module the page imports

createRecordingWorker(config);
```

`recording-sdk init-sw` scaffolds this entry plus the bundler glue. The
closed-page-resume contract is preserved verbatim: the `recordingServiceUrl` (now any
endpoint base) is still pinned onto the worker script URL and recovered from
`self.location` so a Background-Sync-woken worker has the right backend after termination,
and `SET_CONFIG` still updates it for same-session runtime changes. The per-pass
`remaining` value and the `sync`-event rejection-on-remaining contract are unchanged.

---

## 7. Codecs

`CODEC_PRESETS` and the `codecKey: 'vp8_opus' | 'vp9_opus' | 'av1_opus'` union become a
consumer-provided map plus a plain string key:

```ts
// RecorderOptions
codecKey?: string;                               // was a fixed union
// VideoRecorder resolves against config.codecs ?? built-in fallback presets
```

The three built-in presets stay shipped as an exported default map so a consumer that
doesn't care keeps working with zero config.

---

## 8. Migration / phasing

| Phase | Deliverable                                                                 | Status |
| ----- | -------------------------------------------------------------------------- | ------ |
| 0     | **This document.** Lock the API shapes.                                     | ✅ done |
| 1     | Unify the two request engines behind one `OperationContext` core, in-SDK, no behavior change. | ✅ done |
| 2     | Operation registry replaces the closed `RequestType` union; generic request `data`; store-merge in schema. | ✅ done |
| 3     | `defineRecordingConfig` + `createRecordingWorker(config)`.                  | ✅ done |
| 4     | Recording-service consolidated into the separable `/presets` entry; config-driven worker; frontend cut authored as a guide (not yet applied — see below). | ◑ SDK done; frontend pending publish |
| 5     | Open codecs (`codecs` map + string `codecKey`).                            | ✅ done |
| 6     | `recording-sdk init-sw` scaffolder + consumer docs + examples.             | ✅ done |

Phases 1–3 keep everything working in-SDK so the Phase 4 extraction is a pure relocation,
not a rewrite.

**Phase 4 reality.** The frontend depends on the *published* SDK (a real `node_modules` copy,
not a link), so it can't use `defineRecordingConfig` / `/presets` until a new version is
published and the dep bumped. The SDK-side work is done (recording-service is now the
separable `/presets` preset, nothing deleted, fully back-compat). The frontend cut is written
up in [`migration-frontend.md`](migration-frontend.md) and deliberately **not** applied to the
live frontend yet (it would break against the installed old SDK). Publishing is an
outward-facing step left to a human.

### Regression-sensitive areas (Phase 1)

- Closed-page resume: the worker recovers its endpoint base from `self.location` (script
  URL query param), not just `SET_CONFIG`. Must survive the rewrite.
- The `remaining` / `sync`-rejection contract in `runRetryQueue` (rejecting re-fires the
  Background Sync; resolving settles it). Must survive the rewrite.
- The shared-muxer-buffer corruption fix on the capture side is untouched by this work but
  is adjacent; do not regress chunk byte boundaries.

---

## 9. Open questions

- `pendingChunks`: engine-owned minimal store + user-typed payload (§3). Confirm the split
  point — specifically whether `presignedUrl`/`presignedUrlExpiresAt` live on the chunk
  record (engine store, user-typed field) or in the separate `presignedUrlCache` domain
  store. Today both exist; we should pick one in Phase 2.
- Whether `resilienceLog` is truly engine-owned or a domain store. It is an SDK feature
  (resilience telemetry), so it stays engine-owned for now, but the *report shape* may
  want a consumer hook.
- Codec validation: should `defineRecordingConfig` validate codec strings against
  `VideoEncoder.isConfigSupported` at runtime, or stay a pure pass-through? Leaning
  pure pass-through (validation belongs at `start()`).
