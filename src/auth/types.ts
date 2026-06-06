/**
 * Auth token provider seam.
 *
 * The offline queue and service worker need a fresh auth token to retry queued
 * requests, and a way to detect that the signed-in session changed. The SDK does
 * not own authentication — the host application injects an implementation.
 *
 * Both methods are optional: when no provider (or method) is supplied, the queue
 * degrades gracefully (it still retries `NEEDS_AUTH` requests and assumes the
 * session is valid).
 */
export interface IAuthTokenProvider {
  /**
   * Refresh/persist the current auth token so background workers can read it
   * (typically writes it into the SDK's IndexedDB auth-token cache).
   */
  cacheCurrentToken?(): Promise<void>;

  /**
   * Return false when the active session no longer matches the one that enqueued
   * the persisted requests (e.g. a different user signed in).
   */
  validateSession?(): Promise<boolean>;
}
