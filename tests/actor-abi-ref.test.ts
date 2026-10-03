import { expect, test } from "bun:test";
import { ACTOR_ABI_INTERFACE_REFS, parseActorAbiRef } from "../src/actor-abi-ref.ts";

test("Actor ABI refs resolve only as complete canonical frozen tuples", () => {
  for (const kind of ["legacy", "v2"] as const) {
    const expected = ACTOR_ABI_INTERFACE_REFS[kind];
    const parsed = parseActorAbiRef({ ...expected });
    expect(parsed?.kind).toBe(kind);
    expect(parsed?.ref).toBe(expected);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed?.ref)).toBe(true);
  }

  const changedInput = { ...ACTOR_ABI_INTERFACE_REFS.v2 };
  const selected = parseActorAbiRef(changedInput);
  changedInput.version = "2.0.1";
  expect(selected?.ref).toBe(ACTOR_ABI_INTERFACE_REFS.v2);
  expect(selected?.ref.version).toBe("2.0.0");
});

test("Actor ABI ref parsing accepts legacy non-enumerable data and refuses untrusted shapes", () => {
  const expected = ACTOR_ABI_INTERFACE_REFS.v2;
  const nonEnumerable = Object.defineProperties({}, {
    apiVersion: { value: expected.apiVersion },
    name: { value: expected.name },
    version: { value: expected.version },
    schemaDigest: { value: expected.schemaDigest },
  });
  expect(parseActorAbiRef(nonEnumerable)?.ref).toBe(expected);

  let getterCalls = 0;
  const accessor = { ...expected };
  Object.defineProperty(accessor, "schemaDigest", {
    get() {
      getterCalls += 1;
      return expected.schemaDigest;
    },
  });
  expect(parseActorAbiRef(accessor)).toBeNull();
  expect(getterCalls).toBe(0);
  expect(parseActorAbiRef({ ...expected, extra: true })).toBeNull();
  expect(parseActorAbiRef({ ...expected, [Symbol("extra")]: true })).toBeNull();
  expect(parseActorAbiRef({ ...expected, version: "2.0.1" })).toBeNull();
  expect(parseActorAbiRef({ ...expected, schemaDigest: `sha256:${"a".repeat(64)}` })).toBeNull();
});

test("Actor ABI ref parsing snapshots Proxy own keys only once", () => {
  const target = { ...ACTOR_ABI_INTERFACE_REFS.v2 };
  let ownKeysCalls = 0;
  const changing = new Proxy(target, {
    ownKeys(value) {
      ownKeysCalls += 1;
      return ownKeysCalls === 1
        ? Reflect.ownKeys(value)
        : ["apiVersion", "name", "version", Symbol("changed")];
    },
  });
  expect(parseActorAbiRef(changing)?.kind).toBe("v2");
  expect(ownKeysCalls).toBe(1);
});
