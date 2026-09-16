import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  EDGE_VECTOR_WORKER_FACADE_KIND,
  EDGE_VECTOR_WORKER_FACADE_SAFE_INTRINSICS,
  renderEdgeVectorWorkerFacadeSource,
} from "../src/providers/edge-vector-worker-facade-source.ts";

const MINIMAL_PRELUDE = `
const SafeApply = Reflect.apply;
const SafeArrayIsArray = Array.isArray;
const SafeArrayPrototype = Array.prototype;
const SafeError = Error;
const SafeMathFround = Math.fround;
const SafeNumberIsFinite = Number.isFinite;
const SafeNumberIsSafeInteger = Number.isSafeInteger;
const SafeObject = Object;
const SafeObjectCreate = Object.create;
const SafeObjectDefineProperty = Object.defineProperty;
const SafeObjectFreeze = Object.freeze;
const SafeObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const SafeObjectGetPrototypeOf = Object.getPrototypeOf;
const SafeObjectHasOwn = Object.hasOwn;
const SafeObjectSetPrototypeOf = Object.setPrototypeOf;
const SafeObjectPrototype = Object.prototype;
const SafeOwnKeys = Reflect.ownKeys;
const SafeReflect = Reflect;
const SafeJSONStringify = JSON.stringify;
const SafeStringCharCodeAt = String.prototype.charCodeAt;
const SafeSymbol = Symbol;
const SafeTextEncoder = TextEncoder;
const SafeTextEncoderEncode = TextEncoder.prototype.encode;
const SafeTypedArrayByteLengthGet = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength",
).get;
`;

interface GeneratedFacade {
  readonly createEdgeVectorAdapter: (
    invoke: (
      operation: string,
      input: unknown,
      project: (value: unknown) => unknown,
    ) => Promise<unknown>,
  ) => {
    readonly get: (input: unknown) => Promise<unknown>;
  };
}

test("the edge.vector source fragment is transport-neutral and standalone", async () => {
  const source = renderEdgeVectorWorkerFacadeSource();
  expect(EDGE_VECTOR_WORKER_FACADE_KIND).toBe("edge.vector@0.1.0");
  expect(Object.isFrozen(EDGE_VECTOR_WORKER_FACADE_SAFE_INTRINSICS)).toBe(true);
  expect(source).toContain("function createEdgeVectorAdapter(invoke)");
  expect(source).not.toMatch(/url|rpc|binding|planeRequest|rawPromise/i);

  const root = await mkdtemp(join(tmpdir(), "takoserver-edge-vector-facade-"));
  const modulePath = join(root, "facade.mjs");
  try {
    await Bun.write(
      modulePath,
      `${MINIMAL_PRELUDE}\n${source}\nexport { createEdgeVectorAdapter };`,
    );
    const generated = (await import(
      `${pathToFileURL(modulePath).href}?test=${crypto.randomUUID()}`
    )) as GeneratedFacade;

    let projectCalls = 0;
    let transportReturned = false;
    const invoke = (_operation: string, input: unknown, project: (value: unknown) => unknown) => {
      expect(Object.getPrototypeOf(input)).toBeNull();
      expect(Object.isFrozen(input)).toBe(true);
      const raw = {
        vectors: [{ id: "one", namespace: "docs", values: [1, 0, 0], metadata: {} }],
      };
      const projected = project(raw);
      projectCalls += 1;
      expect(transportReturned).toBe(false);
      return Promise.resolve(projected);
    };

    const adapter = generated.createEdgeVectorAdapter(invoke);
    expect(Object.isFrozen(adapter)).toBe(true);
    const pending = adapter.get({ namespace: "docs", ids: ["one"] });
    transportReturned = true;
    const result = (await pending) as {
      readonly vectors: readonly [
        {
          readonly id: string;
          readonly namespace: string;
          readonly values: readonly number[];
          readonly metadata: Record<string, never>;
        },
      ];
    };

    expect(projectCalls).toBe(1);
    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(Object.isFrozen(result)).toBe(true);
    expect(result).toEqual({
      vectors: [{ id: "one", namespace: "docs", values: [1, 0, 0], metadata: {} }],
    });
    expect(Object.getPrototypeOf(result.vectors)).toBe(Array.prototype);
    expect(Object.isFrozen(result.vectors)).toBe(true);
    expect(Object.getPrototypeOf(result.vectors[0])).toBeNull();
    expect(Object.isFrozen(result.vectors[0])).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
