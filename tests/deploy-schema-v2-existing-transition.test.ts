import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { deriveExpectedApplicationShape } from "../scripts/deploy/application-schema-shape.ts";
import {
  readCurrentAuditedMigrationSourceArtifact,
  runD1Schema,
} from "../scripts/deploy/schema.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";

const source = readCurrentAuditedMigrationSourceArtifact();
const commit = "a".repeat(40);
const target = {
  kind: "takoserver.deploy-target@v2",
  environment: "integration",
  accountId: "a".repeat(32),
  workerName: "takoserver-api-integration",
  d1: {
    databaseName: "takoserver-runtime-integration",
    databaseId: "00000000-0000-4000-8000-000000000088",
  },
  r2: { bucketName: "takoserver-objects-integration" },
  cloudflareProviderExecutor: {
    workerName: "takoserver-cpe-integration",
    dispatchNamespace: "takoserver-managed-integration",
    gatewayWorkerName: "takoserver-gateway-integration",
    managedBaseDomain: "managed.integration.example.test",
    providerInstallationId: "provider-installation",
    receiptAuthorityWorkerName: "takoserver-receipts-integration",
  },
  publicOrigin: "https://api.integration.example.test",
  signing: { currentKeyId: "current" },
  takoformV2: {
    config: JSON.stringify({
      documentation: "https://docs.example.test/v2",
      authenticationDocumentation: "https://docs.example.test/v2/authentication",
    }),
  },
  schemaMaintenanceMode: "pre-v2-0088-quiesced",
} satisfies DeployTarget;

function state(count: number) {
  const shape = deriveExpectedApplicationShape(source.files.slice(0, count));
  return {
    applied: source.names.slice(0, count),
    shape,
    shapeDigest: `sha256:${createHash("sha256").update(shape).digest("hex")}`,
  };
}

describe("existing integration v2 0066 to 0088 selected wave", () => {
  const status = {
    action: "status",
    environment: "integration",
    commit,
    throughMigration: "0088",
  } as const;
  const reader = (
    count: number,
    epochState: "absent" | "closed" | "open" = count < 68 ? "absent" : "closed",
    v2ResourceCount = 0,
  ) => ({
    async read() {
      return state(count);
    },
    async v2ExistingSnapshot() {
      return { epochState, providerInvocationCount: 0, v2ResourceCount };
    },
  });
  const statusOptions = (
    count: number,
    epochState: "absent" | "closed" | "open" = count < 68 ? "absent" : "closed",
    v2ResourceCount = 0,
  ) => ({
    reader: reader(count, epochState, v2ResourceCount),
    // This is a status fixture, not an operator's ambient Wrangler login.
    cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "fixture-token" },
  });
  test("status selects the audited 0066 predecessor without raising the default ceiling", async () => {
    const result = await runD1Schema(status, target, statusOptions(66));
    expect(result).toMatchObject({
      fromMigration: "0066_cloudflare_managed_actor_kv_capability_claims.sql",
      throughMigration: "0088_v2_worker_sqlite_external_drain.sql",
      pendingMigrations: source.names.slice(66, 88),
      readyForApply: false,
    });
    expect(result.pendingMigrations).not.toContain(source.names[88]);
  });

  test("canonical partial prefixes remain status-only without publication proof", async () => {
    for (const count of [67, 68, 69, 75, 86, 87]) {
      const result = await runD1Schema(status, target, statusOptions(count));
      expect(result).toMatchObject({
        appliedMigrations: source.names.slice(0, count),
        pendingMigrations: source.names.slice(count, 88),
        readyForApply: false,
      });
      expect(result.pendingMigrations).not.toContain(source.names[88]);
    }
  });

  test("an opened 0068 epoch or accepted v2 data prevents the existing-target wave", async () => {
    await expect(runD1Schema(status, target, statusOptions(69, "open"))).rejects.toThrow(
      "closed 0068",
    );
    await expect(runD1Schema(status, target, statusOptions(87, "closed", 1))).rejects.toThrow(
      "no affected v2 data",
    );
  });

  test("production and an ordinary integration target cannot select 0088", async () => {
    const { schemaMaintenanceMode: _mode, ...ordinaryTarget } = target;
    await expect(runD1Schema(status, ordinaryTarget)).rejects.toThrow("maintenance target");
    await expect(
      runD1Schema(
        { ...status, environment: "production" },
        { ...target, environment: "production" },
      ),
    ).rejects.toThrow("maintenance target");
  });
});
