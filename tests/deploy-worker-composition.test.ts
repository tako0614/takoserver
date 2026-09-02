import { describe, expect, test } from "bun:test";
import { DeployError } from "../scripts/deploy/errors.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import {
  assertTargetComposes,
  workerCompositionEnv,
} from "../scripts/deploy/worker-composition.ts";
import {
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
    workerEndpointSuffix: "hosted.workers.dev",
    edgeSupplies: edgeSuppliesFixture(input.edgeResourceClasses),
    objectBucketSupplies: objectBucketSuppliesFixture(input.objectResourceClasses),
  } satisfies DeployTarget;
}

describe("Worker composition preflight", () => {
  test("accepts a target whose supply halves share one exact SupplyContract", async () => {
    await assertTargetComposes("preflight", target());
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
      workerEndpointSuffix: _suffix,
      ...plain
    } = target();
    await assertTargetComposes("preflight", plain);
    expect(workerCompositionEnv(plain)).toEqual({});
  });

  test("passes the derived plain-text bindings and placeholder secrets only", () => {
    const env = workerCompositionEnv(target()) as Readonly<Record<string, string>>;
    expect(Object.keys(env).sort()).toEqual([
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_API_TOKEN",
      "TAKOSERVER_EDGE_SUPPLIES",
      "TAKOSERVER_OBJECT_BUCKET_SUPPLIES",
      "TAKOSERVER_WORKER_ENDPOINT_SUFFIX",
    ]);
    // The credential is a stand-in: composition only tests presence and pairing.
    expect(env.CLOUDFLARE_API_TOKEN).toBe("deploy-preflight-placeholder");
    expect(JSON.parse(env.TAKOSERVER_EDGE_SUPPLIES as string)).toMatchObject({
      supplyContract: { id: "cloudflare.staging-supply" },
    });
  });
});
