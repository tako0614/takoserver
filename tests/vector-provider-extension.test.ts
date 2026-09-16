import { expect, test } from "bun:test";
import * as root from "@takoserver/core";
import type {
  VectorIndexConfig,
  VectorIndexIndex,
  VectorIndexScope,
  VectorIndexStore,
} from "@takoserver/core/provider-extension";
import * as providerExtension from "@takoserver/core/provider-extension";
import type { VectorIndexConfig as ExpectedVectorIndexConfig } from "../src/vector-index-codec.ts";
import {
  VectorIndexInvalidSpecError as ExpectedVectorIndexInvalidSpecError,
  parseVectorIndexConfig as expectedParseVectorIndexConfig,
} from "../src/vector-index-codec.ts";
import type {
  VectorIndexIndex as ExpectedVectorIndexIndex,
  VectorIndexScope as ExpectedVectorIndexScope,
  VectorIndexStore as ExpectedVectorIndexStore,
} from "../src/vector-index-store.ts";
import {
  VectorIndexStoreError as ExpectedVectorIndexStoreError,
  createVectorIndexStore as expectedCreateVectorIndexStore,
} from "../src/vector-index-store.ts";

const VECTOR_EXTENSION_VALUES = [
  "createVectorIndexStore",
  "parseVectorIndexConfig",
  "VectorIndexInvalidSpecError",
  "VectorIndexStoreError",
] as const;

test("provider-extension exposes the shared VectorIndex source identities", () => {
  expect(providerExtension.createVectorIndexStore).toBe(expectedCreateVectorIndexStore);
  expect(providerExtension.parseVectorIndexConfig).toBe(expectedParseVectorIndexConfig);
  expect(providerExtension.VectorIndexInvalidSpecError).toBe(ExpectedVectorIndexInvalidSpecError);
  expect(providerExtension.VectorIndexStoreError).toBe(ExpectedVectorIndexStoreError);

  for (const name of VECTOR_EXTENSION_VALUES) {
    expect(name in providerExtension).toBe(true);
    expect(name in root).toBe(false);
  }

  expect("VectorIndexConfigInput" in providerExtension).toBe(false);
  expect("VectorIndexOperationError" in providerExtension).toBe(false);
  expect("VectorIndexMetadata" in providerExtension).toBe(false);
});

test("provider-extension VectorIndex type imports resolve", () => {
  const scope = {
    tenantId: "tenant",
    resourceUid: "resource-uid",
  } satisfies VectorIndexScope;
  const config = {
    dimension: 2,
    metric: "cosine",
    filterKeys: [],
  } satisfies VectorIndexConfig;
  const index = {
    ...scope,
    config,
    recordLimit: 1,
  } satisfies VectorIndexIndex;
  const store = undefined as unknown as VectorIndexStore;

  const sourceTypes = {
    config,
    index,
    scope,
    store,
  } satisfies {
    readonly config: ExpectedVectorIndexConfig;
    readonly index: ExpectedVectorIndexIndex;
    readonly scope: ExpectedVectorIndexScope;
    readonly store: ExpectedVectorIndexStore;
  };

  expect(sourceTypes.scope).toEqual(scope);
  expect(sourceTypes.index).toEqual(index);
});
