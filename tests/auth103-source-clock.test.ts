import { expect, test } from "bun:test";
import {
  AUTH103_CLOCK_RECIPE,
  createAuth103SourceClock,
  readAuth103SourceClock,
} from "../src/auth103-source-clock.ts";

test("Root source Clock produces a real finite system Date and immutable original definition", () => {
  const before = Date.now();
  const clock = createAuth103SourceClock();
  const value = clock();
  const after = Date.now();
  expect(value).toBeInstanceOf(Date);
  expect(value.getTime()).toBeGreaterThanOrEqual(before);
  expect(value.getTime()).toBeLessThanOrEqual(after);
  expect(Object.isFrozen(clock)).toBe(true);
  const original = readAuth103SourceClock(clock);
  expect(original?.clock).toBe(clock);
  expect(original?.recipe).toBe(AUTH103_CLOCK_RECIPE);
  expect(Object.isFrozen(original)).toBe(true);
  expect(Object.isFrozen(original?.recipe)).toBe(true);
});

test("a matching Clock callback or recipe DTO is not an original source", () => {
  expect(readAuth103SourceClock(() => new Date())).toBeNull();
  expect(
    readAuth103SourceClock({ clock: () => new Date(), recipe: AUTH103_CLOCK_RECIPE }),
  ).toBeNull();
  expect(readAuth103SourceClock({ ...AUTH103_CLOCK_RECIPE, qualified: true })).toBeNull();
  const original = createAuth103SourceClock();
  expect(readAuth103SourceClock(original.bind(undefined))).toBeNull();
});

test("the static reader never invokes an alleged Clock or its properties", () => {
  let invoked = 0;
  const fake = new Proxy(
    () => {
      invoked++;
      throw new Error("untrusted callback");
    },
    {
      get() {
        invoked++;
        throw new Error("untrusted getter");
      },
    },
  );
  expect(readAuth103SourceClock(fake)).toBeNull();
  expect(invoked).toBe(0);
});

test("each noarg construction retains its own exact Clock on the one implementation source", () => {
  const first = createAuth103SourceClock();
  const second = createAuth103SourceClock();
  const a = readAuth103SourceClock(first);
  const b = readAuth103SourceClock(second);
  expect(first).not.toBe(second);
  expect(a).not.toBe(b);
  expect(a?.clock).toBe(first);
  expect(b?.clock).toBe(second);
  expect(a?.recipe).toBe(b?.recipe);
  expect(Object.hasOwn(a!, "policyRef")).toBe(false);
});
