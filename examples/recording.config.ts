/**
 * Example: app config using the built-in recording-service preset.
 *
 * Copy into your app (e.g. `services/recording.config.ts`) and adapt. This is the single
 * place your backend contract is defined — the SDK is just the engine. The same resolved
 * object is imported by the page and by your service-worker entry (see `sw-entry.ts`).
 *
 * Requires `@batak-dev/recording-sdk` with `defineRecordingConfig` + the `/presets` entry.
 */
import { defineRecordingConfig } from '@batak-dev/recording-sdk';
import {
  recordingServicePreset,
  RecordingServiceTransport,
  type IHttpClient
} from '@batak-dev/recording-sdk/presets';

/**
 * `api` is any axios-compatible client (e.g. Nuxt's `$api`); `baseURL` is your backend.
 * The transport is page-only (drives prepare/salt/complete/review) and never enters the
 * service worker, so it is fine that it closes over the page's http client.
 */
export function buildRecordingConfig(api: IHttpClient, baseURL: string) {
  return defineRecordingConfig({
    // Start from the built-in recording-service contract (operations, domain stores,
    // endpoints, chunk processor)...
    ...recordingServicePreset({ baseURL }),
    // ...and add the page-only lifecycle transport.
    transport: new RecordingServiceTransport(api, { baseURL })
  });
}
