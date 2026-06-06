/**
 * `@ta/recording-sdk/queue` — resilient offline request queue.
 *
 * Persists recording requests/chunks to IndexedDB, resolves dependencies, retries
 * with exponential backoff, and coordinates with the service worker for background
 * sync. The recording-specific request handlers ship as the default adapter; the
 * queue core (priority/dependency/retry engine) is reusable on its own.
 */
export * from './offlineQueue';
export type { ITransport } from './transport/types';
export type { IAuthTokenProvider } from './auth/types';
