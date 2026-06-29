/**
 * Page-side service-worker helpers (DOM context).
 *
 * Registers the recording worker and provides the SET_CONFIG / TRIGGER_SYNC handshake the
 * worker expects. Pair with `createRecordingWorker()` (worker context) — either the prebuilt
 * `dist/sw.default.js` or a custom bundled worker entry.
 */
export interface RegisterRecordingWorkerOptions {
  /** Service-worker scope (default '/'). */
  scope?: string;
  /** Recording-service base URL, sent to the worker via SET_CONFIG after registration. */
  recordingServiceUrl?: string;
  /** Called with each message the worker posts back (CHUNK_UPLOADED, SYNC_COMPLETE, ...). */
  onMessage?: (data: any) => void;
  /** 'classic' (default) or 'module' if your worker entry is an ES module. */
  type?: WorkerType;
}

export async function registerRecordingWorker(
  scriptUrl: string,
  options: RegisterRecordingWorkerOptions = {}
): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;

  // Pin the recording-service URL onto the worker's own script URL. SET_CONFIG only lives in a
  // running worker's memory, so a Background-Sync-woken worker (page already closed) would
  // otherwise fall back to the built-in default and fail every backend call. The script URL is
  // persisted with the registration and exposed via self.location, so the worker recovers the
  // URL synchronously at startup even after termination. (configureRecordingWorker below still
  // sends SET_CONFIG for same-session runtime updates.)
  let registerUrl = scriptUrl;
  if (options.recordingServiceUrl) {
    const separator = scriptUrl.includes('?') ? '&' : '?';
    registerUrl = `${scriptUrl}${separator}recordingServiceUrl=${encodeURIComponent(options.recordingServiceUrl)}`;
  }

  const registration = await navigator.serviceWorker.register(registerUrl, {
    scope: options.scope ?? '/',
    type: options.type
  });

  if (options.onMessage) {
    navigator.serviceWorker.addEventListener('message', (event) => options.onMessage!(event.data));
  }

  if (options.recordingServiceUrl) {
    await configureRecordingWorker(options.recordingServiceUrl);
  }

  return registration;
}

/** Send/refresh the recording-service base URL to the active worker (SET_CONFIG). */
export function configureRecordingWorker(recordingServiceUrl: string): Promise<boolean> {
  return postToWorker({ type: 'SET_CONFIG', recordingServiceUrl });
}

/** Ask the worker to drain the queue now, registering a Background Sync as a fallback. */
export async function triggerBackgroundSync(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return false;
  try {
    const registration = (await navigator.serviceWorker.ready) as any;
    if (registration?.sync?.register) {
      await registration.sync.register('retry-queue');
    }
  } catch {
    // Background Sync unavailable — fall through to the direct message.
  }
  return postToWorker({ type: 'TRIGGER_SYNC' });
}

async function postToWorker(message: any): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return false;
  // Prefer the controller, but fall back to the registration's active worker. `controller` is
  // null when this page isn't yet controlled — right after a SW update, or on a reload before
  // claim — in which case posting via the controller would silently drop the message (so a
  // TRIGGER_SYNC to drain the queue would never reach the worker). The active worker receives
  // the message either way.
  let target: ServiceWorker | null = navigator.serviceWorker.controller;
  if (!target) {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      target = reg?.active ?? null;
    } catch {
      target = null;
    }
  }
  if (!target) return false;
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => resolve(!!event.data?.success);
    target!.postMessage(message, [channel.port2]);
  });
}
