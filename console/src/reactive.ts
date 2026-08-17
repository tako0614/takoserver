/**
 * The smallest reactive core that a console actually needs.
 *
 * A dashboard is a few dozen values that change and a lot of markup that has to
 * agree with them. That is a real problem and it deserves a real answer, but it
 * is not a large one: a signal that remembers who read it, and an effect that
 * re-runs when what it read changes. Everything in this console is built from
 * those two, which is why there is no framework here to keep current.
 */

type Subscriber = () => void;

let listening: Subscriber | null = null;

export interface Signal<Value> {
  (): Value;
  set(value: Value): void;
  update(change: (current: Value) => Value): void;
}

export function signal<Value>(initial: Value): Signal<Value> {
  let current = initial;
  const readers = new Set<Subscriber>();

  const read = (() => {
    if (listening) readers.add(listening);
    return current;
  }) as Signal<Value>;

  read.set = (value: Value): void => {
    if (Object.is(value, current)) return;
    current = value;
    // The set is copied before running, because a subscriber may subscribe
    // again — or stop — while the notification is still going out.
    for (const reader of [...readers]) reader();
  };
  read.update = (change) => {
    read.set(change(current));
  };
  return read;
}

/**
 * Runs `body` now, and again whenever a signal it read has changed.
 *
 * Re-runs are batched onto a microtask so a handler that moves three values
 * repaints once. Each run re-registers its reads from scratch, so a branch that
 * stops being taken stops waking the effect.
 */
export function effect(body: () => void): () => void {
  let disposed = false;
  let queued = false;

  const run = (): void => {
    if (disposed) return;
    const previous = listening;
    listening = wake;
    try {
      body();
    } finally {
      listening = previous;
    }
  };

  const wake = (): void => {
    if (queued || disposed) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      run();
    });
  };

  run();
  return () => {
    disposed = true;
  };
}

/** A value derived from other signals, recomputed when they move. */
export function derived<Value>(compute: () => Value): () => Value {
  const held = signal<Value>(undefined as unknown as Value);
  effect(() => {
    held.set(compute());
  });
  return held;
}

/**
 * A request whose lifecycle the UI can render: pending, failed, or loaded.
 *
 * Every screen here shows all three, because "no data yet" and "this account
 * has none" and "we could not ask" look identical if a console only models the
 * happy one, and a person cannot tell which of the three they are looking at.
 */
export type Async<Value> =
  | { readonly state: "loading" }
  | { readonly state: "error"; readonly error: Error }
  | { readonly state: "ready"; readonly value: Value };

export interface Resource<Value> {
  readonly get: () => Async<Value>;
  readonly reload: () => void;
}

export function resource<Value>(load: () => Promise<Value>): Resource<Value> {
  const held = signal<Async<Value>>({ state: "loading" });
  let generation = 0;

  const run = (): void => {
    const mine = ++generation;
    held.set({ state: "loading" });
    load().then(
      (value) => {
        // A reload that started later has already answered; this one is stale
        // and must not overwrite it.
        if (mine === generation) held.set({ state: "ready", value });
      },
      (error: unknown) => {
        if (mine === generation) {
          held.set({
            state: "error",
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      },
    );
  };

  run();
  return { get: held, reload: run };
}
