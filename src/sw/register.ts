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

  const registration = await navigator.serviceWorker.register(scriptUrl, {
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

function postToWorker(message: any): Promise<boolean> {
  return new Promise((resolve) => {
    const controller =
      typeof navigator !== 'undefined' && navigator.serviceWorker
        ? navigator.serviceWorker.controller
        : null;
    if (!controller) {
      resolve(false);
      return;
    }
    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => resolve(!!event.data?.success);
    controller.postMessage(message, [channel.port2]);
  });
}
