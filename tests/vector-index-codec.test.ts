import { describe, expect, test } from "bun:test";
import {
  parseVectorIndexConfig,
  parseVectorIndexInput,
  type VectorIndexConfig,
  VectorIndexInvalidSpecError,
} from "../src/vector-index-codec.ts";

const rawConfig = {
  dimension: 3,
  metric: "cosine",
  filterKeys: ["spaceId", "chunkIndex"],
} as const;

const config = parseVectorIndexConfig(rawConfig);

function invalidSpec(call: () => unknown): void {
  expect(call).toThrow(VectorIndexInvalidSpecError);
  try {
    call();
  } catch (error) {
    expect(error).toMatchObject({ code: "invalid_spec" });
  }
}

describe("VectorIndex configuration codec", () => {
  test("canonicalises the immutable config and materialises omitted filterKeys", () => {
    const canonical = parseVectorIndexConfig({
      dimension: 3,
      metric: "cosine",
      filterKeys: ["z", "a"],
    });
    expect(canonical).toEqual({ dimension: 3, metric: "cosine", filterKeys: ["a", "z"] });
    expect(Object.isFrozen(canonical)).toBe(true);
    expect(Object.isFrozen(canonical.filterKeys)).toBe(true);

    const withoutKeys = parseVectorIndexConfig({ dimension: 1, metric: "cosine" });
    expect(withoutKeys.filterKeys).toEqual([]);
    expect(Object.isFrozen(withoutKeys.filterKeys)).toBe(true);
  });

  test("enforces dimension, cosine, identifier, cardinality, and duplicate limits", () => {
    for (const dimension of [0, -1, 1.5, 1_537, Number.POSITIVE_INFINITY]) {
      invalidSpec(() => parseVectorIndexConfig({ dimension, metric: "cosine" }));
    }
    invalidSpec(() => parseVectorIndexConfig({ dimension: 3, metric: "dotproduct" }));
    invalidSpec(() =>
      parseVectorIndexConfig({ dimension: 3, metric: "cosine", filterKeys: undefined }),
    );
    invalidSpec(() => parseVectorIndexConfig({ dimension: 3, metric: "cosine", extra: true }));
    invalidSpec(() =>
      parseVectorIndexConfig({
        dimension: 3,
        metric: "cosine",
        filterKeys: ["a", "a"],
      }),
    );
    invalidSpec(() =>
      parseVectorIndexConfig({
        dimension: 3,
        metric: "cosine",
        filterKeys: ["9bad"],
      }),
    );
    invalidSpec(() =>
      parseVectorIndexConfig({
        dimension: 3,
        metric: "cosine",
        filterKeys: ["a", "b", "c", "d", "e", "f", "g", "h", "i"],
      }),
    );
  });
});

describe("VectorIndex mutation input codec", () => {
  test("canonicalises namespace, binary32 vectors, and omitted metadata", () => {
    const input = parseVectorIndexInput(
      "upsert",
      {
        namespace: "space:s",
        vectors: [{ id: "one", values: [1.337, 0, -2], metadata: { chunkIndex: 1, spaceId: "s" } }],
      },
      config,
    );
    expect(input).toMatchObject({ namespace: "space:s", vectors: [{ id: "one" }] });
    expect(input.vectors[0]?.values).toEqual([Math.fround(1.337), 0, -2]);
    expect(Object.keys(input.vectors[0]?.metadata ?? {})).toEqual(["chunkIndex", "spaceId"]);
    expect(Object.isFrozen(input)).toBe(true);
    expect(Object.isFrozen(input.vectors)).toBe(true);
    expect(Object.isFrozen(input.vectors[0])).toBe(true);
    expect(Object.isFrozen(input.vectors[0]?.values)).toBe(true);

    const defaults = parseVectorIndexInput(
      "upsert",
      { vectors: [{ id: "default", values: [1, 0, 0] }] },
      config,
    );
    expect(defaults.namespace).toBe("");
    expect(defaults.vectors[0]?.metadata).toEqual({});
    expect(Object.isFrozen(defaults.vectors[0]?.metadata)).toBe(true);
  });

  test("converts only finite binary32 values and rejects zero norm or dimension mismatch", () => {
    invalidSpec(() =>
      parseVectorIndexInput("upsert", { vectors: [{ id: "zero", values: [0, -0, 0] }] }, config),
    );
    invalidSpec(() =>
      parseVectorIndexInput(
        "upsert",
        { vectors: [{ id: "wide", values: [3.5e38, 0, 0] }] },
        config,
      ),
    );
    invalidSpec(() =>
      parseVectorIndexInput(
        "upsert",
        { vectors: [{ id: "nan", values: [Number.NaN, 0, 0] }] },
        config,
      ),
    );
    invalidSpec(() =>
      parseVectorIndexInput("upsert", { vectors: [{ id: "wrong", values: [1, 0] }] }, config),
    );
    invalidSpec(() =>
      parseVectorIndexInput(
        "upsert",
        { vectors: [{ id: "underflow", values: [Number.MIN_VALUE, 0, 0] }] },
        config,
      ),
    );
  });

  test("validates closed batches and duplicate IDs before returning any canonical batch", () => {
    invalidSpec(() =>
      parseVectorIndexInput(
        "upsert",
        {
          vectors: [
            { id: "first", values: [1, 0, 0] },
            { id: "first", values: [0, 1, 0] },
          ],
        },
        config,
      ),
    );
    invalidSpec(() => parseVectorIndexInput("upsert", { vectors: [] }, config));
    invalidSpec(() =>
      parseVectorIndexInput(
        "upsert",
        { vectors: [{ id: "x", values: [1, 0, 0], extra: 1 }] },
        config,
      ),
    );
    invalidSpec(() =>
      parseVectorIndexInput(
        "upsert",
        { vectors: [{ id: "x", values: [1, 0, 0], metadata: undefined }] },
        config,
      ),
    );
  });

  test("enforces Unicode code-point, NUL, and namespace-star limits", () => {
    const emoji128 = "😀".repeat(128);
    const accepted = parseVectorIndexInput(
      "upsert",
      { namespace: emoji128, vectors: [{ id: emoji128, values: [1, 0, 0] }] },
      config,
    );
    expect(accepted.namespace).toBe(emoji128);
    expect(accepted.vectors[0]?.id).toBe(emoji128);
    for (const value of ["😀".repeat(129), "bad\u0000id", "bad\ud800"]) {
      invalidSpec(() =>
        parseVectorIndexInput("upsert", { vectors: [{ id: value, values: [1, 0, 0] }] }, config),
      );
    }
    invalidSpec(() =>
      parseVectorIndexInput(
        "upsert",
        { namespace: `contains*star`, vectors: [{ id: "x", values: [1, 0, 0] }] },
        config,
      ),
    );
    invalidSpec(() =>
      parseVectorIndexInput(
        "upsert",
        { namespace: `contains\u0000nul`, vectors: [{ id: "x", values: [1, 0, 0] }] },
        config,
      ),
    );
    invalidSpec(() =>
      parseVectorIndexInput(
        "upsert",
        { namespace: undefined, vectors: [{ id: "x", values: [1, 0, 0] }] },
        config,
      ),
    );
  });

  test("requires non-empty unique ID arrays for get and delete", () => {
    for (const operation of ["get", "delete"] as const) {
      const parsed = parseVectorIndexInput(operation, { ids: ["a", "b"] }, config);
      expect(parsed.namespace).toBe("");
      expect(parsed.ids).toEqual(["a", "b"]);
      invalidSpec(() => parseVectorIndexInput(operation, { ids: [] }, config));
      invalidSpec(() => parseVectorIndexInput(operation, { ids: ["a", "a"] }, config));
      invalidSpec(() => parseVectorIndexInput(operation, { ids: ["a"], unknown: true }, config));
    }
  });
});

describe("VectorIndex metadata and query input codec", () => {
  test("accepts only flat scalar metadata and applies the canonical UTF-8 byte limit", () => {
    const canonical = parseVectorIndexInput(
      "upsert",
      {
        vectors: [
          {
            id: "metadata",
            values: [1, 0, 0],
            metadata: { z: null, a: "ok", bool: true, number: -0 },
          },
        ],
      },
      config,
    );
    expect(Object.keys(canonical.vectors[0]?.metadata ?? {})).toEqual(["a", "bool", "number", "z"]);
    expect(canonical.vectors[0]?.metadata.number).toBe(0);

    const exactly8192 = "x".repeat(8_184);
    parseVectorIndexInput(
      "upsert",
      { vectors: [{ id: "limit", values: [1, 0, 0], metadata: { a: exactly8192 } }] },
      config,
    );
    invalidSpec(() =>
      parseVectorIndexInput(
        "upsert",
        { vectors: [{ id: "limit", values: [1, 0, 0], metadata: { a: `${exactly8192}x` } }] },
        config,
      ),
    );
    invalidSpec(() =>
      parseVectorIndexInput(
        "upsert",
        { vectors: [{ id: "nested", values: [1, 0, 0], metadata: { a: {} } }] },
        config,
      ),
    );
    invalidSpec(() =>
      parseVectorIndexInput(
        "upsert",
        { vectors: [{ id: "array", values: [1, 0, 0], metadata: { a: [] } }] },
        config,
      ),
    );
    invalidSpec(() =>
      parseVectorIndexInput(
        "upsert",
        { vectors: [{ id: "surrogate", values: [1, 0, 0], metadata: { a: "\ud800" } }] },
        config,
      ),
    );
    invalidSpec(() =>
      parseVectorIndexInput(
        "upsert",
        {
          vectors: [
            { id: "nonfinite", values: [1, 0, 0], metadata: { a: Number.POSITIVE_INFINITY } },
          ],
        },
        config,
      ),
    );
    invalidSpec(() =>
      parseVectorIndexInput(
        "upsert",
        {
          vectors: [
            {
              id: "properties",
              values: [1, 0, 0],
              metadata: Object.fromEntries(
                Array.from({ length: 65 }, (_, index) => [`a${index}`, index]),
              ),
            },
          ],
        },
        config,
      ),
    );
  });

  test("validates declared, type-sensitive filter terms and exact query flags", () => {
    const query = parseVectorIndexInput(
      "query",
      {
        values: [1, 0, 0],
        topK: 3,
        filter: { chunkIndex: 1, spaceId: "s" },
        returnMetadata: true,
        returnValues: false,
      },
      config,
    );
    expect(query).toEqual({
      namespace: "",
      values: [1, 0, 0],
      topK: 3,
      filter: { chunkIndex: 1, spaceId: "s" },
      returnMetadata: true,
      returnValues: false,
    });
    expect(Object.keys(query.filter)).toEqual(["chunkIndex", "spaceId"]);

    const defaults = parseVectorIndexInput("query", { values: [1, 0, 0], topK: 1 }, config);
    expect(defaults.filter).toEqual({});
    expect(defaults.returnMetadata).toBe(false);
    expect(defaults.returnValues).toBe(false);
    for (const topK of [0, 101, 1.5, "1"]) {
      invalidSpec(() => parseVectorIndexInput("query", { values: [1, 0, 0], topK }, config));
    }
    invalidSpec(() =>
      parseVectorIndexInput(
        "query",
        { values: [1, 0, 0], topK: 1, filter: { unknown: "x" } },
        config,
      ),
    );
    invalidSpec(() =>
      parseVectorIndexInput("query", { values: [1, 0, 0], topK: 1, returnMetadata: 1 }, config),
    );
    invalidSpec(() =>
      parseVectorIndexInput("query", { values: [1, 0, 0], topK: 1, returnValues: null }, config),
    );
  });
});

test("the parser accepts a canonical config value without changing it", () => {
  const canonical: VectorIndexConfig = parseVectorIndexConfig(rawConfig);
  const input = parseVectorIndexInput("query", { values: [0, 1, 0], topK: 1 }, canonical);
  expect(input.values).toEqual([0, 1, 0]);
  expect(canonical).toEqual(config);
});

test("rejects an operation outside the closed interface", () => {
  invalidSpec(() =>
    parseVectorIndexInput(
      "insert" as unknown as "upsert",
      { vectors: [{ id: "x", values: [1, 0, 0] }] },
      config,
    ),
  );
});
