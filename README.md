# @ta/recording-sdk

Extensible, resilient **WebCodecs video-recording SDK**: adaptive quality, AI background
effects, signed chunked upload, an offline IndexedDB queue with service-worker background sync,
and resilience telemetry.

Everything ships with batteries-included defaults, and every subsystem is replaceable through
injected adapters (network monitor, quality strategy, storage schema, backend transport, auth
provider).

> Requires a Chromium-based browser (WebCodecs, `MediaStreamTrackProcessor`, `OffscreenCanvas`).

## Install

```bash
npm install @ta/recording-sdk
```

This package is published to GitHub Packages. Add to your `.npmrc`:

```
@ta:registry=https://npm.pkg.github.com
```

## Entry points

| Import | Contents |
| --- | --- |
| `@ta/recording-sdk` | `VideoRecorder`, codec presets, crypto, signed-chunk format, network/quality, interfaces |
| `@ta/recording-sdk/queue` | `OfflineQueueManager`, recording request handlers, enqueue helpers |
| `@ta/recording-sdk/storage` | IndexedDB persistence + blob store (the shared schema) |
| `@ta/recording-sdk/network` | `NetworkMonitor`, quality presets |
| `@ta/recording-sdk/resilience` | `ResilienceCollector`, metrics |
| `@ta/recording-sdk/transport` | `ITransport` seam + default `RecordingServiceTransport` + API DTOs |
| `@ta/recording-sdk/auth` | `IAuthTokenProvider` seam |
| `@ta/recording-sdk/sw` | `registerRecordingWorker`, `configureRecordingWorker`, `triggerBackgroundSync` |
| `@ta/recording-sdk/sw/worker` | `createRecordingWorker()` factory (bundle into your own worker entry) |

## Quick start

```ts
import { VideoRecorder } from '@ta/recording-sdk';

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

## Offline queue + transport

```ts
import { OfflineQueueManager, setupRequestHandlers } from '@ta/recording-sdk/queue';
import type { ITransport } from '@ta/recording-sdk/transport';
import type { IAuthTokenProvider } from '@ta/recording-sdk/auth';

// Default transport targets the recording-service presigned-URL REST contract.
// Pass any axios-compatible client (e.g. Nuxt's `$api`) + the service base URL.
import { RecordingServiceTransport } from '@ta/recording-sdk/transport';

const transport: ITransport = new RecordingServiceTransport($api, {
  baseURL: recordingServiceUrl
});
const authProvider: IAuthTokenProvider = myAuthAdapter;  // refresh token / validate session

const queue = new OfflineQueueManager({ authProvider });
setupRequestHandlers(queue, transport);
```

## Service worker

A service worker drives offline retry / background sync. Because a runtime worker cannot
`import` from `node_modules`, the SDK ships two paths:

**Zero-config** — serve the prebuilt worker at your origin root and register it. It is an ES
module worker (Chromium), so register with `{ type: 'module' }`:

```ts
import { registerRecordingWorker } from '@ta/recording-sdk/sw';

// copy node_modules/@ta/recording-sdk/dist/sw.default.js to /sw.js at build time
await registerRecordingWorker('/sw.js', { recordingServiceUrl });
```

**Custom** — write your own worker entry, inject adapters, and let your bundler emit a
self-contained worker file:

```ts
// sw-entry.ts  (bundled to /sw.js by your build)
import { createRecordingWorker } from '@ta/recording-sdk/sw/worker';

createRecordingWorker({
  recordingServiceUrl,
  schema: myCustomSchema,      // optional: same SchemaDescriptor as the main thread
  getAuthToken: async () => token
});
```

## Extensibility seams

The following are injected interfaces — omit them to use the bundled default implementation, or
pass your own to fully replace the behaviour:

- **`ITransport`** (`/transport`) — the backend the queue uploads to. Default
  `RecordingServiceTransport` targets the recording-service presigned-URL contract.
- **`IAuthTokenProvider`** (`/auth`) — refresh/persist the auth token and detect session changes.
  No default — the host supplies it.
- **`INetworkMonitor`** (`/network`) — throughput measurement + quality reporting. Default
  `NetworkMonitor`; inject via the recorder's `createNetworkMonitor` option.
- **`IQualityStrategy`** (`/network`) — throughput→quality classification and preset resolution.
  Default `DefaultQualityStrategy` (thresholds 3000/1500/500 kbps); pass custom thresholds or a
  full strategy via the recorder's `qualityStrategy` option.
- **`SchemaDescriptor`** (`/storage`) — data-driven IndexedDB schema shared by the main thread and
  the service worker. Extend `DEFAULT_SCHEMA` and register via `setRecordingDbSchema()`.

## Development

```bash
npm install
npm run typecheck
npm run build      # tsup -> dist/ (ESM + .d.ts per entry)
npm test           # vitest
```
