# @batak-dev/recording-sdk

Extensible, resilient **WebCodecs video-recording SDK**: adaptive quality, AI background
effects, signed chunked upload, an offline IndexedDB queue with service-worker background sync,
and resilience telemetry.

Everything ships with batteries-included defaults tuned for the `recording-service` backend, and
every subsystem that talks to the outside world (backend transport, auth, network measurement,
quality thresholds, IndexedDB schema) is an injected seam — replace it to run this SDK against a
different backend or host system without forking the package.

> Requires a Chromium-based browser (WebCodecs, `MediaStreamTrackProcessor`, `OffscreenCanvas`).

## Install

```bash
npm install @batak-dev/recording-sdk
```

This package is published to GitHub Packages. Add to your `.npmrc`:

```
@ta:registry=https://npm.pkg.github.com
```

## Entry points

| Import | Contents |
| --- | --- |
| `@batak-dev/recording-sdk` | `VideoRecorder`, codec presets, crypto, signed-chunk format, network/quality, interfaces |
| `@batak-dev/recording-sdk/queue` | `OfflineQueueManager`, recording request handlers, enqueue helpers |
| `@batak-dev/recording-sdk/storage` | IndexedDB persistence (`db`), blob store, the shared schema |
| `@batak-dev/recording-sdk/network` | `NetworkMonitor`, quality presets, `IQualityStrategy` |
| `@batak-dev/recording-sdk/resilience` | `ResilienceCollector`, metrics, report types |
| `@batak-dev/recording-sdk/transport` | `ITransport` seam + default `RecordingServiceTransport` + API DTOs |
| `@batak-dev/recording-sdk/auth` | `IAuthTokenProvider` seam |
| `@batak-dev/recording-sdk/sw` | `registerRecordingWorker`, `configureRecordingWorker`, `triggerBackgroundSync` (page-side) |
| `@batak-dev/recording-sdk/sw/worker` | `createRecordingWorker()` factory (bundle into your own worker entry) |
| `@batak-dev/recording-sdk/sw.default.js` | Prebuilt zero-config worker file (`dist/sw.default.js`) |

## How the pieces fit together

```
VideoRecorder                                        OfflineQueueManager
 camera/mic → VideoEncoder/AudioEncoder                ├─ requestHandlers.ts (PREPARE/GET_SALT run
 → ChunkMuxer (webm-muxer) → sign chunk (HMAC)          │   inline; START_RECORDING/PRESIGNED_URL/
 → onChunkReady(chunk) ────────────────────────────────►│   UPLOAD_CHUNK/COMPLETE_RECORDING queued)
      ▲                                                 ├─ IndexedDB (pendingRequests, pendingChunks,
      │ bitrate / frameRate / background preset         │   blobStore, presignedUrlCache, ...)
 NetworkMonitor ──classify()──► IQualityStrategy         └─ ITransport ──► your backend

                                                     ServiceWorker (createRecordingWorker)
                                                       reads/writes the SAME IndexedDB, drains in the
                                                       background via Background Sync once the page
                                                       that started the recording is closed
```

The page (`OfflineQueueManager`) and the service worker are two independent drainers of the same
IndexedDB queue — they heartbeat each other so only one is active at a time (see
`CLIENT_DRAINING` / `clientHeartbeatTtlMs`).

## Defaults reference

This is what you get with zero configuration — useful both for understanding current behaviour
and for knowing exactly what to override.

### 1. Codec presets (`codecKey`)

| Key | Video codec | Muxer video codec | Audio codec |
| --- | --- | --- | --- |
| `vp8_opus` | `vp8` | `V_VP8` | Opus |
| `vp9_opus` | `vp09.00.10.08` | `V_VP9` | Opus |
| `av1_opus` (default) | `av01.0.08M.08` | `V_AV1` | Opus |

`CODEC_PRESETS` is a plain `Record<string, RecorderCodecConfig>` — add your own key/value and pass
it as `codecKey`, or pass a full `RecorderCodecConfig` inline (any key not in the record throws).

### 2. Capture defaults

| Setting | Default |
| --- | --- |
| `videoConfig` | `1280×720`, `30fps`, `2.5 Mbps` (bitrate is overridden by the active quality preset once recording starts) |
| `audioConfig` | `48kHz`, mono, `128 Kbps` |
| `chunkDurationMs` | `10000` (10s segments) |
| `enableAdaptiveQuality` | `false` (fixed quality unless turned on) |
| `fixedQuality` | `'excellent'` (used when adaptive is off) |
| `networkMonitorInterval` | `3000` ms |
| `keyframeIntervalSeconds` | `2`, capped at `chunkDurationMs / 2` so every chunk has ≥2 keyframes |

### 3. Adaptive network quality

Classification (`DefaultQualityStrategy`, `NetworkMonitor` → averaged upload throughput in kbps):

| Quality | Threshold |
| --- | --- |
| `excellent` | ≥ 3000 kbps |
| `good` | ≥ 1500 kbps |
| `fair` | ≥ 500 kbps |
| `poor` | below 500 kbps |
| `offline` | forced when `navigator.onLine` is `false` (encoder settings mirror `poor`) |

Presets resolved per quality (`QUALITY_PRESETS`):

| Quality | Video bitrate | Audio bitrate | Frame rate | Background effect |
| --- | --- | --- | --- | --- |
| excellent | 2.5 Mbps | 128 Kbps | 30 | none |
| good | 1.5 Mbps | 96 Kbps | 30 | grayscale |
| fair | 800 Kbps | 64 Kbps | 24 | grayscale + pixelated (37.5% scale) |
| poor | 400 Kbps | 32 Kbps | 15 | grayscale + pixelated (17.5% scale) |
| offline | 400 Kbps | 32 Kbps | 15 | same as poor (keeps queued chunks small while disconnected) |

Measurement mechanics (`NetworkMonitor`): prefers the Network Information API's `downlink`
(estimates upload as 40% of reported download) when available; otherwise — or when `forceProbe` is
set — it `POST`s a 50KB blob to `${probeUrl}/api/v0/public/probe` and times it (no `probeUrl` ⇒
assumes a flat 1.5 Mbps rather than fabricating a number). Keeps the last
10 measurements and classifies on their average; a callback fires only when the classified level
changes, but `onMeasurement`/`onNetworkSample` fires on every sample (used for resilience
telemetry).

### 4. Recording-service transport (default `ITransport`)

`RecordingServiceTransport` is the bundled adapter for the `recording-service` REST contract. It
takes any axios-compatible `IHttpClient` (`{ get, post }`) plus a `baseURL` — no `import.meta.env`
reads, no framework assumption.

| Method | Endpoint |
| --- | --- |
| `prepareRecording` | `POST /api/v0/all/recordings/prepare` |
| `getSalt` | `POST /api/v0/all/recordings/:id/salt` |
| `startRecording` | `POST /api/v0/all/recordings/:id/start` |
| `getPresignedURL` | `POST /api/v0/all/recordings/:id/presigned` |
| `completeRecording` | `POST /api/v0/all/recordings/:id/complete` |
| `getRecording` | `GET /api/v0/all/recordings/:id` |
| `getResumeContext` | `GET /api/v0/all/recordings/:id/resume-context` |
| `getChunkStats` | `GET /api/v0/public/chunks/stats/:id` |
| `getVideoReview` | `GET /api/v0/all/recordings/by-reference/:referenceId/review` |
| `retryProcessing` | `POST /api/v0/all/recordings/:id/retry` |
| `uploadChunk` | raw `fetch(presignedUrl, { method: 'PUT' })` — **bypasses** the injected `IHttpClient` (and its interceptors) so auth headers etc. never leak onto the object-store URL. Content-Type defaults to `video/webm` (`uploadContentType` option). |

Only `startRecording`, `getPresignedURL`, `uploadChunk`, `completeRecording` are required by
`ITransport` / the offline queue; the rest are extra recording-service surface for consumers that
drive the full lifecycle (prepare/salt/review/retry) directly.

### 5. Offline queue engine (`OfflineQueueManager`)

Request lifecycle (recording-service-shaped, see the caveat in [Recipe B](#b-adapting-to-your-own-backend--system)):

```
PREPARE, GET_SALT          →  synchronous, called directly, never queued
START_RECORDING (CRITICAL) →  queued
PRESIGNED_URL   (HIGH)     →  queued, one per chunk
UPLOAD_CHUNK    (HIGH)     →  queued, depends on its PRESIGNED_URL request
COMPLETE_RECORDING (LOW)   →  queued, depends on every UPLOAD_CHUNK for the session
```

| Setting | Default |
| --- | --- |
| `MAX_CONCURRENT_OPERATIONS` | 2 |
| `MAX_RETRY_ATTEMPTS` | 5 |
| Retry backoff | `1s × 2^(attempt-1)`, capped at `30s` |
| Presigned-URL cache | 10 minutes; reused if it still has ≥1 minute of validity left |
| Orphan recovery | any request/chunk left `IN_PROGRESS` by a crashed page/worker is reclaimed to `PENDING` once, at the next drainer's startup |

### 6. IndexedDB schema

`DEFAULT_SCHEMA` (`db: RecordingOfflineDB`, version `6`):

| Store | Key | Purpose |
| --- | --- | --- |
| `pendingRequests` | `id` | Queue engine's `QueuedRequest` records |
| `pendingChunks` | `[pathIdentifier, chunkIndex]` | Per-chunk upload status |
| `recordingMetadata` | `pathIdentifier` | Session-level progress/resume checkpoint |
| `presignedUrlCache` | `[pathIdentifier, chunkIndex]` | TTL cache of presigned upload URLs |
| `blobStore` | `id` | Transient chunk blob bytes (deleted once uploaded) |
| `authTokenCache` | `userId` | Token(s) the service worker reads to authenticate requests |
| `resilienceLog` | `pathIdentifier` | Crash-safe event log used by `ResilienceCollector` |

`applySchema` is additive/subtractive only: on a version bump it creates stores present in your
descriptor but missing from the DB, and deletes stores present in the DB but missing from your
descriptor — it never alters an *existing* store's `keyPath` or adds an index to one (IndexedDB
can't change a live store's `keyPath` without deleting and recreating it, which would drop its
data). The built-in store names above are also hardcoded throughout `db.ts` / `requestHandlers.ts`
/ `sw/worker.ts` (`STORES = STORE_NAMES`, not read from the active schema), so they can't be
renamed either. In practice "customizing the schema" means adding your own stores alongside the
built-in ones — see [step 4 of Recipe B](#4-extend-the-indexeddb-schema-optional).

### 7. Service worker (`createRecordingWorker`)

| Setting | Default |
| --- | --- |
| `recordingServiceUrl` | `option` → `?recordingServiceUrl=` on the worker's own script URL (pinned there by `registerRecordingWorker`, see `/sw`) → `http://localhost:8082` |
| `endpoints` | same three recording-service paths as `RecordingServiceTransport` (start/complete/presigned) |
| `maxChunkAttempts` | 5 |
| `autoRetryIntervalMs` | 10000 ms between drain passes within one wake-up (max 8 passes) |
| `networkCheckIntervalMs` | 30000 ms minimum gap between `fetch`-triggered pending checks |
| `clientHeartbeatTtlMs` | 8000 ms — defers to an open page only while it's actively heartbeating |
| `uploadContentType` | `video/webm` |
| `presignedTtlMs` | 10 minutes |

Lifecycle: `install` → `skipWaiting`; `activate` → claim clients + drain once + arm Background Sync
if work remains; `sync` (tag `retry-queue`) → drain, rejecting to force a browser re-fire if work is
still pending (durable across worker termination); `fetch` → best-effort opportunistic drain check;
`message` → `SET_CONFIG` / `CLIENT_DRAINING` / `TRIGGER_SYNC` handshake with the page.

### 8. Resilience telemetry

`ResilienceCollector` accumulates a time-series of events (quality changes, throughput samples,
chunk lifecycle, request retries, network on/off) into IndexedDB as you go, and `buildReport()` /
`loadPersistedReport()` compute a summary (switch rate, chunk delivery rate, retry-success rate,
MTTR, a composite Recording Resilience Score) — optional, wire it up via the recorder's
`onNetworkSample` and the queue manager's events; see `src/resilience/types.ts` for the full event
and report shapes.

## Extensibility seams

| Seam | Interface | Inject via | Default | Replace when |
| --- | --- | --- | --- | --- |
| Backend transport | `ITransport` (`/transport`) | `setupRequestHandlers(queue, transport)` | `RecordingServiceTransport` | your backend isn't recording-service |
| Auth | `IAuthTokenProvider` (`/auth`) | `new OfflineQueueManager({ authProvider })` | none (queue assumes session is always valid, still retries `NEEDS_AUTH`) | you need token refresh / session-change detection |
| Network measurement | `INetworkMonitor` (`/network`) | `RecorderOptions.createNetworkMonitor` | `NetworkMonitor` (Network Info API / upload probe) | you have a better bandwidth signal (WebRTC stats, server-reported) |
| Quality classification + presets | `IQualityStrategy` (`/network`) | `RecorderOptions.qualityStrategy` | `DefaultQualityStrategy` (thresholds above) | different thresholds, bitrates, or background-effect behaviour |
| IndexedDB schema | `SchemaDescriptor` (`/storage`) | `setRecordingDbSchema()` (call before first DB access) | `DEFAULT_SCHEMA` | you need to add your own store(s) alongside the built-in ones (additive only — see [§6](#6-indexeddb-schema)) |
| Service-worker REST paths | `RecordingWorkerEndpoints` | `createRecordingWorker({ endpoints })` | recording-service's 3 paths | same wire shape (`{chunk_index}` → `{presigned_url}`), different host/paths |
| Service-worker auth | `getAuthToken` | `createRecordingWorker({ getAuthToken })` | reads the newest valid token from `authTokenCache` | your token isn't in the SDK's IndexedDB cache |
| Codec | `RecorderCodecConfig` | `RecorderOptions.codecKey`, or add to `CODEC_PRESETS` | `av1_opus` | different codec / container needs |

All of these are optional — omit any of them and the bundled default is used.

## Recipe A: zero-config against recording-service

```ts
import { VideoRecorder } from '@batak-dev/recording-sdk';

const recorder = new VideoRecorder({
  codecKey: 'vp9_opus',
  chunkDurationMs: 10_000,
  enableAdaptiveQuality: true,
  pathIdentifier,
  salt,
  onChunkReady: (chunk) => upload(chunk),
});

const stream = await recorder.start();
videoEl.srcObject = stream;
// ...
await recorder.stop();
```

```ts
import { OfflineQueueManager, setupRequestHandlers } from '@batak-dev/recording-sdk/queue';
import { RecordingServiceTransport } from '@batak-dev/recording-sdk/transport';
import type { IAuthTokenProvider } from '@batak-dev/recording-sdk/auth';

// Any axios-compatible client (e.g. Nuxt's `$api`) + the recording-service base URL.
const transport = new RecordingServiceTransport($api, { baseURL: recordingServiceUrl });
const authProvider: IAuthTokenProvider = myAuthAdapter; // refresh token / validate session

const queue = new OfflineQueueManager({ authProvider });
setupRequestHandlers(queue, transport);
```

```ts
import { registerRecordingWorker } from '@batak-dev/recording-sdk/sw';

// copy node_modules/@batak-dev/recording-sdk/dist/sw.default.js to /sw.js at build time
await registerRecordingWorker('/sw.js', { recordingServiceUrl });
```

## Recipe B: adapting to your own backend / system

Start with what actually needs to change:

- **Only the host/paths differ, same wire shapes** (JSON `POST` bodies, `chunk_index` /
  `presigned_url` field names) — implement `ITransport` pointing at your host, and pass
  `endpoints` to `createRecordingWorker` for the same paths on the worker side. Cheapest option.
- **The wire shapes differ** (different field names, a non-presigned-URL upload flow, extra
  steps) — implement `ITransport` fully in your own shape-matching wrapper, and skip
  `createRecordingWorker`'s built-in REST calls: write your own worker entry against
  `@batak-dev/recording-sdk/storage` (`db`, `blobStorage`) directly, mirroring the drain loop in
  `src/sw/worker.ts` but calling your own endpoints.

### 1. Implement `ITransport`

```ts
import type { ITransport, GetPresignedUrlInput, PresignedUrlResult } from '@batak-dev/recording-sdk/transport';

export class MyBackendTransport implements ITransport {
  async startRecording(pathIdentifier: string): Promise<void> { /* ... */ }
  async getPresignedURL(pathIdentifier: string, data: GetPresignedUrlInput): Promise<PresignedUrlResult> {
    /* return { presigned_url, ...whateverElseYouWant } */
  }
  async uploadChunk(presignedUrl: string, blob: Blob): Promise<void> { /* ... */ }
  async completeRecording(pathIdentifier: string): Promise<any> { /* ... */ }
}
```

Pass it to `setupRequestHandlers(queue, new MyBackendTransport())` — the queue only ever calls
these four methods.

> **Caveat:** `OfflineQueueManager`'s `RequestType` union and `requestHandlers.ts` still assume
> recording-service's six-step lifecycle (`PREPARE`/`GET_SALT` synchronous, then
> `START_RECORDING` → `PRESIGNED_URL` → `UPLOAD_CHUNK` → `COMPLETE_RECORDING` queued, in that
> dependency order). If your system's lifecycle doesn't fit that shape (e.g. no signing/salt
> step, chunks addressed by something other than an index, no "complete" step), don't fight the
> built-in queue — use `@batak-dev/recording-sdk/storage` (`db`/`blobStorage`) directly and drive
> your own request/retry logic; the schema, blob store, and offline-first persistence are still
> reusable on their own.

### 2. Auth

```ts
const authProvider: IAuthTokenProvider = {
  async cacheCurrentToken() {
    const token = await myAuthClient.getFreshToken();
    await db.cacheAuthToken({ userId, token, expiresAt, sessionId, createdAt: Date.now() });
  },
  async validateSession() {
    return myAuthClient.currentSessionId === lastKnownSessionId;
  }
};
new OfflineQueueManager({ authProvider });
```

Both methods are optional; omit the provider entirely and the queue still retries `NEEDS_AUTH`
requests without refreshing anything.

### 3. Redefine "network quality" (optional)

```ts
import { DefaultQualityStrategy, type QualityThresholds } from '@batak-dev/recording-sdk/network';

const thresholds: QualityThresholds = { excellent: 5000, good: 2000, fair: 800 };
const qualityStrategy = new DefaultQualityStrategy(thresholds); // or a fully custom IQualityStrategy

new VideoRecorder({ qualityStrategy, enableAdaptiveQuality: true, /* ... */ });
```

Or replace the measurement itself (e.g. WebRTC stats instead of an upload probe) with
`createNetworkMonitor`, implementing `INetworkMonitor`.

### 4. Extend the IndexedDB schema (optional)

```ts
import { setRecordingDbSchema, DEFAULT_SCHEMA } from '@batak-dev/recording-sdk/storage';

setRecordingDbSchema({
  ...DEFAULT_SCHEMA,
  version: DEFAULT_SCHEMA.version + 1,
  stores: [...DEFAULT_SCHEMA.stores, { name: 'myCustomStore', keyPath: 'id' }]
});
```

Call this before the first DB access on **both** the main thread and the service worker (pass the
same `schema` to `createRecordingWorker`), and bump `version` whenever the store list changes —
`applySchema` creates stores newly present in the list and drops ones no longer listed.

This only lets you **add stores of your own** (e.g. an app-specific cache) — it does not let you
restructure the built-in ones (`pendingRequests`, `pendingChunks`, `blobStore`, etc.):
`applySchema` never touches the `keyPath`/indexes of a store that already exists, and the built-in
CRUD (`db.ts`, the request handlers, the SW) address those store names as hardcoded constants, not
through your schema. If you genuinely need a different shape for a built-in store (a different
`keyPath`, an extra index on `pendingChunks`, …), you're outside what `setRecordingDbSchema` is
for — you'd need to open the DB yourself with a custom `onupgradeneeded` that migrates the store
(delete + recreate + copy data), and likely fork the relevant `db.ts` functions to match, since the
bundled queue/SW code won't know about the new shape.

### 5. Service worker against your backend

If your wire shapes match (see above), just point the built-in worker elsewhere:

```ts
// sw-entry.ts — bundled to /sw.js by your build
import { createRecordingWorker } from '@batak-dev/recording-sdk/sw/worker';

createRecordingWorker({
  recordingServiceUrl: 'https://my-backend.example.com',
  endpoints: {
    start: (base, id) => `${base}/v2/sessions/${id}/start`,
    complete: (base, id) => `${base}/v2/sessions/${id}/finish`,
    presigned: (base, id) => `${base}/v2/sessions/${id}/upload-url`
  },
  getAuthToken: async () => myTokenStore.current,
  schema: myCustomSchema // if you extended it in step 4
});
```

If the wire shapes don't match, skip `createRecordingWorker` and write the drain loop yourself
against `db`/`blobStorage` — see `src/sw/worker.ts` for the reference implementation (chunk loop →
request loop → Background Sync arming) to mirror.

## Development

```bash
npm install
npm run typecheck
npm run build      # tsup -> dist/ (ESM + .d.ts per entry)
npm test           # vitest
```
