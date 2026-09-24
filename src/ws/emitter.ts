/**
 * A tiny typed event emitter.
 *
 * Node's `EventEmitter` is untyped at the payload level and its `error` event
 * throws when unhandled — neither is what a long-running feed wants. This is 40
 * lines, fully typed, and never throws on an unheard event.
 */

export type Listener<T> = (payload: T) => void

/** Returned by `on`/`once`; call it to detach. Idempotent. */
export type Unsubscribe = () => void

export class Emitter<Events extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof Events, Set<Listener<never>>>()

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): Unsubscribe {
    let set = this.listeners.get(event)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(event, set)
    }
    const erased = listener as Listener<never>
    set.add(erased)
    return () => {
      set.delete(erased)
    }
  }

  once<K extends keyof Events>(event: K, listener: Listener<Events[K]>): Unsubscribe {
    const off = this.on(event, (payload) => {
      off()
      listener(payload)
    })
    return off
  }

  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
    this.listeners.get(event)?.delete(listener as Listener<never>)
  }

  /**
   * Emit to every listener. A throwing listener must not take down the feed, so
   * exceptions are swallowed and reported through `onListenerError`.
   */
  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event)
    if (set === undefined) return
    for (const listener of [...set]) {
      try {
        ;(listener as Listener<Events[K]>)(payload)
      } catch (err) {
        this.onListenerError(String(event), err)
      }
    }
  }

  listenerCount<K extends keyof Events>(event: K): number {
    return this.listeners.get(event)?.size ?? 0
  }

  removeAllListeners(): void {
    this.listeners.clear()
  }

  /** Overridable hook; default is a console warning so a bug is never silent. */
  protected onListenerError(event: string, err: unknown): void {
    // eslint-disable-next-line no-console
    console.warn(`[variational-trading-api] listener for "${event}" threw:`, err)
  }
}
