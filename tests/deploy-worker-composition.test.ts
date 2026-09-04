import { describe, expect, test } from "bun:test";
import { DeployError } from "../scripts/deploy/errors.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import {
  assertTargetComposes,
  workerCompositionEnv,
} from "../scripts/deploy/worker-composition.ts";
import {
  cloudflareProviderExecutorTarget,
  EDGE_ONLY_RESOURCE_CLASSES,
  edgeSuppliesFixture,
  objectBucketSuppliesFixture,
} from "./helpers/hosted-supply-fixtures.ts";

function target(
  input: {
    readonly edgeResourceClasses?: readonly string[];
    readonly objectResourceClasses?: readonly string[];
  } = {},
): DeployTarget {
  return {
    kind: "takoserver.deploy-target@v2",
    environment: "integration",
    accountId: "a".repeat(32),
    workerName: "takoserver-api-integration",
    d1: {
      databaseName: "takoserver-runtime-integration",
      databaseId: "00000000-0000-4000-8000-000000000000",
    },
    r2: { bucketName: "takoserver-objects-integration" },
    publicOrigin: "https://api.integration.example.test",
    signing: { currentKeyId: "key-current" },
    cloudflareProviderExecutor: cloudflareProviderExecutorTarget(),
    edgeSupplies: edgeSuppliesFixture(input.edgeResourceClasses),
    objectBucketSupplies: objectBucketSuppliesFixture(input.objectResourceClasses),
  } satisfies DeployTarget;
}

describe("Worker composition preflight", () => {
  test("accepts metered Cloudflare supplies only through the private executor capability", async () => {
    await expect(assertTargetComposes("preflight", target())).resolves.toBeUndefined();
    expect(workerCompositionEnv(target())).toMatchObject({
      CLOUDFLARE_PROVIDER_EXECUTOR: {},
    });
  });

  test("refuses a target that declares one contract twice with different content", async () => {
    // The live incident: the edge half omitted `storage.object`, the
    // object-bucket half required it, and both halves named the same contract.
    const refusal = await assertTargetComposes("preflight", {
      ...target({ edgeResourceClasses: EDGE_ONLY_RESOURCE_CLASSES }),
    }).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(DeployError);
    const error = refusal as DeployError;
    expect(error.phase).toBe("preflight");
    // The runtime's own words, verbatim.
    expect(error.message).toContain("Cloudflare supply contract is ambiguous");
    expect(error.detail).toContain("TypeError: Cloudflare supply contract is ambiguous");
  });

  test("composes a supply-free target without inventing provider reach", async () => {
    const {
      edgeSupplies: _edge,
      objectBucketSupplies: _objects,
      cloudflareProviderExecutor: _executor,
      ...plain
    } = target();
    await assertTargetComposes("preflight", plain);
    expect(workerCompositionEnv(plain)).toEqual({});
  });

  test("passes only non-secret supply facts and the typed executor capability", () => {
    const env = workerCompositionEnv(target());
    expect(Object.keys(env).sort()).toEqual([
      "CLOUDFLARE_PROVIDER_EXECUTOR",
      "TAKOSERVER_EDGE_SUPPLIES",
      "TAKOSERVER_MANAGED_BASE_DOMAIN",
      "TAKOSERVER_OBJECT_BUCKET_SUPPLIES",
    ]);
    expect(env.CLOUDFLARE_PROVIDER_EXECUTOR).toBeDefined();
    expect(JSON.parse(env.TAKOSERVER_EDGE_SUPPLIES as string)).toMatchObject({
      supplyContract: { id: "cloudflare.staging-supply" },
    });
  });
});
