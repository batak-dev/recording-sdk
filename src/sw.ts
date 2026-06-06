/**
 * `@ta/recording-sdk/sw` — page-side service-worker registration helpers.
 *
 * The worker factory itself lives at `@ta/recording-sdk/sw/worker` (it targets the
 * service-worker global scope and is meant to be bundled into your worker entry).
 */
export * from './sw/register';
