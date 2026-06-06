/**
 * Minimal browser-safe EventEmitter.
 *
 * Replaces Node's `events` module so the SDK has zero Node built-in dependencies
 * and runs unmodified in browsers, web workers, and service workers.
 * API-compatible with the subset used across the SDK (on/once/off/emit/removeAllListeners).
 */
export type Listener = (...args: any[]) => void;

export class EventEmitter {
  private _listeners: Map<string, Set<Listener>> = new Map();

  on(event: string, listener: Listener): this {
    let set = this._listeners.get(event);
    if (!set) {
      set = new Set();
      this._listeners.set(event, set);
    }
    set.add(listener);
    return this;
  }

  addListener(event: string, listener: Listener): this {
    return this.on(event, listener);
  }

  once(event: string, listener: Listener): this {
    const wrapper: Listener = (...args) => {
      this.off(event, wrapper);
      listener(...args);
    };
    return this.on(event, wrapper);
  }

  off(event: string, listener: Listener): this {
    this._listeners.get(event)?.delete(listener);
    return this;
  }

  removeListener(event: string, listener: Listener): this {
    return this.off(event, listener);
  }

  emit(event: string, ...args: any[]): boolean {
    const set = this._listeners.get(event);
    if (!set || set.size === 0) return false;
    // Iterate a copy so listeners can safely add/remove during emit.
    for (const listener of [...set]) {
      try {
        listener(...args);
      } catch (err) {
        console.error(`[EventEmitter] listener for "${event}" threw:`, err);
      }
    }
    return true;
  }

  removeAllListeners(event?: string): this {
    if (event) this._listeners.delete(event);
    else this._listeners.clear();
    return this;
  }

  listenerCount(event: string): number {
    return this._listeners.get(event)?.size ?? 0;
  }
}
