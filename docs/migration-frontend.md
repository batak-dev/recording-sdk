# Frontend migration (the Phase 4 cut)

The frontend (`ta/frontend`) consumes the **published** `@batak-dev/recording-sdk`. The
configurable-backend rework adds new exports (`defineRecordingConfig`, the `/presets` entry,
the operation registry) that do not exist in the installed version. So the frontend cannot
be rewired until a new SDK version is published and the dependency bumped.

**This migration is intentionally NOT applied to the live frontend yet** — doing so against
the installed (old) SDK would break its typecheck/build. The steps below are the cut.

## Status quo (still works, unchanged)

- `services/recordingService.ts` → `new RecordingServiceTransport($api, { baseURL })`
- `plugins/serviceWorker.client.ts` → registers `public/sw.js` (copied from
  `dist/sw.default.js` by the `sync:sw` script)
- `pages/**` → `setupRequestHandlers(queueManager, recordingService)`, `enqueueChunkUpload`, …

The default `sw.default.js` still targets the recording-service contract, so nothing breaks
when the SDK is upgraded — the migration below is opt-in.

## Steps

1. **Publish** the new SDK version (new `defineRecordingConfig` + `/presets`). *(Outward-facing
   — done deliberately, not automatically.)*
2. **Bump** `@batak-dev/recording-sdk` in `frontend/package.json` and reinstall.
3. **Add** `frontend/services/recording.config.ts` — the single place the backend contract
   lives. Start from [`examples/recording.config.ts`](../examples/recording.config.ts):
   ```ts
   import { defineRecordingConfig } from '@batak-dev/recording-sdk';
   import { recordingServicePreset, RecordingServiceTransport, type IHttpClient } from '@batak-dev/recording-sdk/presets';

   export function buildRecordingConfig(api: IHttpClient, baseURL: string) {
     return defineRecordingConfig({
       ...recordingServicePreset({ baseURL }),
       transport: new RecordingServiceTransport(api, { baseURL })
     });
   }
   ```
4. **Rewire `useRecordingService`** to return `buildRecordingConfig($api, baseURL)` (or keep
   returning `.transport` for the existing call sites and expose `.operations` for the queue).
5. **Pass `operations`** to the queue manager so priorities come from the config:
   ```ts
   const config = buildRecordingConfig($api, baseURL);
   const queueManager = new OfflineQueueManager({ /* ... */, operations: config.operations });
   setupRequestHandlers(queueManager, config.transport!);
   ```
6. **(Optional) Custom service worker.** Only needed if you customise operations/stores beyond
   the preset. Scaffold `npx recording-sdk init-sw public/sw-entry.ts`, point it at
   `recording.config`, bundle it (a small Nuxt/Vite build step or `tsup`) to `public/sw.js`,
   and replace the `sync:sw` copy step. If you stay on the preset, keep `sw.default.js`.
7. **Verify** by running the frontend: a real recording (online), an offline→online drain, and
   a page-close→Background-Sync drain. These exercise the regression-sensitive paths
   (`urlFromLocation`/`SET_CONFIG` recovery; the `remaining`/sync-rejection contract).

## Later: fully remove recording-service from the SDK core

Once the frontend owns its `recording.config.ts`, the recording-service preset can move out
of the SDK package entirely (into the frontend or a separate adapter package), leaving the
SDK exporting only the engine + contracts. Until then it ships as the `/presets` entry so the
zero-config path keeps working.
