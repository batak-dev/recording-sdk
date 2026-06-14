# Using the SDK

The SDK is a **backend-agnostic engine**: it owns the durable offline queue, retry,
service-worker background sync, and the WebCodecs capture pipeline (adaptive quality, ROI
background segmentation, signed chunked upload). Your **backend contract** — the transport,
the operations (request types), the domain stores, the endpoints — lives in *your* app, in
one config built with `defineRecordingConfig`. This is the Prisma/Drizzle relationship: the
engine is in the library; the schema is in your code.

## Install

```bash
npm install @batak-dev/recording-sdk
```

## The config

`defineRecordingConfig` assembles one resolved object that **both** the page and the
service-worker entry import. It is pure (no DB open, no network), so the same object is safe
to share across contexts.

### Quickest start — the built-in recording-service preset

```ts
import { defineRecordingConfig } from '@batak-dev/recording-sdk';
import { recordingServicePreset, RecordingServiceTransport } from '@batak-dev/recording-sdk/presets';

const config = defineRecordingConfig({
  ...recordingServicePreset({ baseURL: 'https://api.example.com' }),
  transport: new RecordingServiceTransport(api, { baseURL: 'https://api.example.com' })
});
```

See [`examples/recording.config.ts`](../examples/recording.config.ts).

### Custom backend — define everything yourself

Provide your own `operations`, `processChunk`, `stores`, `endpoints`, and
`resolveAuthToken`. Nothing recording-service-specific is pulled in. See
[`examples/custom-backend.config.ts`](../examples/custom-backend.config.ts).

```ts
const config = defineRecordingConfig({
  baseUrl: 'https://api.example.com',
  endpoints: { start, complete, presigned },
  operations,        // your OperationRegistry
  processChunk,      // your per-chunk processor
  stores,            // your domain stores (merged with engine plumbing stores)
  resolveAuthToken: async (db) => (await db.getCurrentAuthToken())?.token ?? null
});
```

## Operations (request types)

An operation is one entry in the registry — the data-driven replacement for the old fixed
request-type union:

```ts
import { Priority, type OperationRegistry } from '@batak-dev/recording-sdk/queue';

const operations: OperationRegistry = {
  START_RECORDING: { priority: Priority.CRITICAL, kind: 'request', handle: async (ctx, req) => { /* ... */ } },
  PRESIGNED_URL:   { priority: Priority.HIGH, kind: 'chunk' },   // engine chunk-loop driven
  UPLOAD_CHUNK:    { priority: Priority.HIGH, kind: 'chunk' },
  COMPLETE_RECORDING: { priority: Priority.LOW, kind: 'request', handle: async (ctx, req) => { /* ... */ } }
};
```

- `handle(ctx, request)` uses only `ctx` (`authedFetch`, `db`, `blobStorage`, `endpoints`,
  `timings`, ...) so the **same code runs on the page and in the service worker**. It must
  never close over a page http client or touch the DOM.
- `kind: 'chunk'` ops are driven by the engine's chunk loop (`processChunk`) and carry no
  `handle`.
- Custom operation names are allowed — `RequestType` is open.

## Stores

The engine owns its plumbing stores (`pendingRequests`, `pendingChunks`, `blobStore`,
`resilienceLog`) — they are the durability guarantee and can't be redefined. Your **domain**
stores are declared in `config.stores` and merged in. `mergeStores` **throws** if you reuse
an engine-owned name or duplicate a store, so the plumbing can never be silently overridden.
Bump `schemaVersion` when your stores change.

## Codecs

```ts
new VideoRecorder({ codecKey: 'av1_opus' });                 // built-in: vp8_opus | vp9_opus | av1_opus
new VideoRecorder({ codecs: { my_codec: { /* ... */ } }, codecKey: 'my_codec' }); // your own
```

## Service worker

The worker keeps a **fixed internal structure** (event wiring, retry/drain orchestration,
Background Sync). Only your config flows in.

- **Zero-config:** serve the prebuilt `dist/sw.default.js` and register it:
  ```ts
  import { registerRecordingWorker } from '@batak-dev/recording-sdk/sw';
  registerRecordingWorker('/sw.js', { recordingServiceUrl, type: 'module' });
  ```
  (Uses the recording-service defaults.)

- **Custom config:** scaffold an entry, bundle it, serve it:
  ```bash
  npx recording-sdk init-sw public/sw-entry.ts
  ```
  The entry imports your shared `recording.config` and calls `createRecordingWorker(config)`.
  See [`examples/sw-entry.ts`](../examples/sw-entry.ts). The `recordingServiceUrl` you pass at
  registration is pinned onto the worker script URL so a Background-Sync-woken worker (page
  closed) still has the right backend after termination.

## Architecture

For the full design (engine vs. capability tiers, the operation-context model, store
ownership), see [`docs/architecture.md`](architecture.md).
