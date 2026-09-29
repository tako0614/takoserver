import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalDigest } from "../src/json.ts";
import {
  createSelfhostProvider,
  SELFHOST_PROVIDER_HANDLER_SURFACE,
} from "../src/providers/selfhost.ts";
import {
  deriveRuntimeImplementationCatalog,
  providerResourceOperationHandlers,
} from "../src/public-worker-implementation.ts";
import { SELFHOST_IDENTITY_CAPABILITY_KINDS } from "../src/selfhost-composition.ts";
import { yurucommuLifecycleCapabilityManifest } from "../src/takoform/implementation-catalog.ts";

/**
 * The self-host Form implementation identity is derived, not restated, and one
 * of its inputs is the handler surface of the Provider that will run. These
 * cases bind that input to the self-host implementation instead of the public
 * Worker's adapter.
 */

const SELFHOST_CAPABILITIES = yurucommuLifecycleCapabilityManifest(
  SELFHOST_IDENTITY_CAPABILITY_KINDS,
);
const SELFHOST_IMPLEMENTATION_PAYLOAD_DIGEST = await canonicalDigest({
  kind: "takoserver.selfhost-form-implementation@v1",
  capabilities: SELFHOST_CAPABILITIES,
});
const COMPLETE_LIFECYCLE = ["create", "read", "update", "delete", "import", "observe"] as const;

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "takoserver-selfhost-handler-surface-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function composeProvider() {
  return createSelfhostProvider({
    offerings: [],
    dataRoot: root,
    runtime: {
      async inspectModule(input) {
        return { outcome: "valid", exportedHandlers: [...input.declaredHandlers] };
      },
      async write() {},
      async remove() {},
      async reload() {},
      async has() {
        return false;
      },
    },
    artifacts: {
      async manifest() {
        return null;
      },
      async blob() {
        return null;
      },
    },
  });
}

describe("self-host provider handler surface", () => {
  test("declares the lifecycle handlers the composed self-host Provider realizes", () => {
    const forced = providerResourceOperationHandlers(
      composeProvider() as unknown as Readonly<Record<string, unknown>>,
    );
    expect(forced).toEqual([...COMPLETE_LIFECYCLE]);
    expect(providerResourceOperationHandlers(SELFHOST_PROVIDER_HANDLER_SURFACE)).toEqual(forced);
  });

  test("derives handler evidence from the surface it is given, not another Host's adapter", async () => {
    // A surface without `adopt` cannot claim `import`. The self-host admission
    // derives its evidence through this exact input.
    const withoutAdopt = {
      apply() {},
      delete() {},
      observe() {},
    };
    const catalog = await deriveRuntimeImplementationCatalog({
      implementationPayloadDigest: SELFHOST_IMPLEMENTATION_PAYLOAD_DIGEST,
      capabilities: SELFHOST_CAPABILITIES,
      handlerSurface: withoutAdopt,
    });
    const namespaced = catalog.entries.find((entry) => entry.formRef.kind === "EdgeKVNamespace");
    if (!namespaced) throw new Error("EdgeKVNamespace catalog entry is missing");
    expect(namespaced.operations).not.toContain("import");
    expect(namespaced.operations).toEqual(["create", "read", "delete", "observe"]);
  });
});
