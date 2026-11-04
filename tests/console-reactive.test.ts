import { expect, test } from "bun:test";
import { effect, signal } from "../console/src/reactive.ts";

/** Observe the actual signal reader Set without exposing a production debug API. */
function observedSignal<Value>(initial: Value) {
  const NativeSet = globalThis.Set;
  let readerCount = () => -1;
  class ObservedSet<Member> extends NativeSet<Member> {
    constructor(values?: Iterable<Member> | null) {
      super(values);
      readerCount = () => this.size;
    }
  }
  try {
    globalThis.Set = ObservedSet;
    return { value: signal(initial), readerCount: () => readerCount() };
  } finally {
    globalThis.Set = NativeSet;
  }
}

const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));

test("an effect stops subscribing to a branch it no longer reads", async () => {
  const branch = signal(true);
  const left = observedSignal(1);
  const right = observedSignal(2);
  const seen: number[] = [];
  const stop = effect(() => seen.push(branch() ? left.value() : right.value()));
  expect(seen).toEqual([1]);
  branch.set(false);
  await tick();
  expect(seen).toEqual([1, 2]);
  expect(left.readerCount()).toBe(0);
  expect(right.readerCount()).toBe(1);
  left.value.set(3);
  await tick();
  expect(seen).toEqual([1, 2]);
  right.value.set(4);
  await tick();
  expect(seen).toEqual([1, 2, 4]);
  stop();
});

test("disposing removes every signal subscription and is idempotent", async () => {
  const first = observedSignal(1);
  const second = observedSignal(2);
  let calls = 0;
  const stop = effect(() => {
    first.value();
    second.value();
    calls += 1;
  });
  expect([first.readerCount(), second.readerCount()]).toEqual([1, 1]);
  stop();
  stop();
  expect([first.readerCount(), second.readerCount()]).toEqual([0, 0]);
  first.value.set(3);
  second.value.set(4);
  await tick();
  expect(calls).toBe(1);
});

test("disposing a queued effect prevents its run and retained subscriptions", async () => {
  const held = observedSignal(0);
  let calls = 0;
  const stop = effect(() => {
    held.value();
    calls += 1;
  });
  held.value.set(1);
  stop();
  await tick();
  expect(calls).toBe(1);
  expect(held.readerCount()).toBe(0);
});

test("repeated short-lived observers leave no retained reader callbacks", () => {
  const held = observedSignal(0);
  for (let index = 0; index < 100; index++) {
    const stop = effect(() => {
      held.value();
    });
    stop();
  }
  expect(held.readerCount()).toBe(0);
});

test("nested effects restore the outer subscription context", async () => {
  const outerFirst = observedSignal(0);
  const inner = observedSignal(0);
  const outerLast = observedSignal(0);
  let stopInner: (() => void) | undefined;
  let outerCalls = 0;
  let innerCalls = 0;
  const stopOuter = effect(() => {
    outerFirst.value();
    if (!stopInner)
      stopInner = effect(() => {
        inner.value();
        innerCalls += 1;
      });
    outerLast.value();
    outerCalls += 1;
  });
  stopOuter();
  expect([outerFirst.readerCount(), inner.readerCount(), outerLast.readerCount()]).toEqual([
    0, 1, 0,
  ]);
  inner.value.set(1);
  outerLast.value.set(1);
  await tick();
  expect([outerCalls, innerCalls]).toEqual([1, 2]);
  stopInner?.();
  expect(inner.readerCount()).toBe(0);
});

test("an initial effect failure releases its otherwise unreachable subscription", () => {
  const held = observedSignal(0);
  expect(() =>
    effect(() => {
      held.value();
      throw new Error("synthetic effect failure");
    }),
  ).toThrow("synthetic effect failure");
  expect(held.readerCount()).toBe(0);
});

test("disposing during a rerun cannot register later reads", async () => {
  const trigger = observedSignal(false);
  const later = observedSignal(0);
  let stop = () => {};
  stop = effect(() => {
    if (trigger.value()) {
      stop();
      later.value();
    }
  });
  trigger.value.set(true);
  await tick();
  expect([trigger.readerCount(), later.readerCount()]).toEqual([0, 0]);
});

test("dependency cleanup preserves microtask batching and one live subscription", async () => {
  const held = observedSignal(0);
  const seen: number[] = [];
  const stop = effect(() => seen.push(held.value()));
  held.value.set(1);
  held.value.set(2);
  held.value.set(3);
  await tick();
  expect(seen).toEqual([0, 3]);
  expect(held.readerCount()).toBe(1);
  stop();
  expect(held.readerCount()).toBe(0);
});

test("a rerun failure releases its subscription without scheduling a retry", () => {
  const held = observedSignal(0);
  let calls = 0;
  const stop = effect(() => {
    calls += 1;
    if (held.value() > 0) throw new Error("synthetic rerun failure");
  });
  const originalQueue = globalThis.queueMicrotask;
  const queued: VoidFunction[] = [];
  try {
    globalThis.queueMicrotask = (callback) => {
      queued.push(callback);
    };
    held.value.set(1);
  } finally {
    globalThis.queueMicrotask = originalQueue;
  }
  expect(queued).toHaveLength(1);
  expect(() => queued[0]?.()).toThrow("synthetic rerun failure");
  expect(held.readerCount()).toBe(0);
  held.value.set(2);
  expect(calls).toBe(2);
  stop();
});
