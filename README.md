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
| `@ta/recording-sdk/transport` | `ITransport` backend seam |
| `@ta/recording-sdk/auth` | `IAuthTokenProvider` seam |

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

const transport: ITransport = myRecordingBackend;        // default: recording-service REST
const authProvider: IAuthTokenProvider = myAuthAdapter;  // refresh token / validate session

const queue = new OfflineQueueManager({ authProvider });
setupRequestHandlers(queue, transport);
```

## Extensibility seams

The following are injected interfaces — omit them to use the bundled default implementation, or
pass your own to fully replace the behaviour:

- **`ITransport`** (`/transport`) — the backend the queue uploads to. Default targets the
  recording-service presigned-URL contract.
- **`IAuthTokenProvider`** (`/auth`) — refresh/persist the auth token and detect session changes.
  No default — the host supplies it.

> Roadmap: `INetworkMonitor`, `IQualityStrategy`, and a data-driven `IStorageAdapter` schema are
> being promoted to the same injected-adapter pattern (today they are configurable concrete
> defaults), along with the `createRecordingWorker()` service-worker factory.

## Development

```bash
npm install
npm run typecheck
npm run build      # tsup -> dist/ (ESM + .d.ts per entry)
npm test           # vitest
```
