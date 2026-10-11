import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deploymentVariables,
  expectedWorkerSecrets,
  writeWorkerConfig,
} from "../scripts/deploy/realized-config.ts";
import { parseDeployTarget } from "../scripts/deploy/target.ts";
import {
  assertTargetComposes,
  workerCompositionEnv,
} from "../scripts/deploy/worker-composition.ts";

const config = `{"documentation":"https://docs.example.invalid/v2","authenticationDocumentation":"https://docs.example.invalid/auth","workerBundle":{"targetKey":"worker-target","heldArtifacts":[]}}`;

function descriptor(environment: "integration" | "rehearsal" | "production" = "integration") {
  return {
    kind: "takoserver.deploy-target@v2",
    environment,
    accountId: "a".repeat(32),
    workerName: `takoserver-api-${environment}`,
    d1: {
      databaseName: `takoserver-runtime-${environment}`,
      databaseId: "00000000-0000-4000-8000-000000000000",
    },
    r2: { bucketName: `takoserver-objects-${environment}` },
    publicOrigin: `https://takoserver-api-${environment}.example.workers.dev`,
    signing: { currentKeyId: `takoserver-${environment}-2026-10` },
    // The artifact Form config needs 0081, so it selects the fresh 0088 payload.
    takoformV2: { config, storageLineage: "v2-0088" },
  };
}

test("v2 target preserves exact public JSON bytes and inventories only the cursor secret name", async () => {
  const selected = parseDeployTarget(descriptor(), "test target", "integration");
  expect(selected.takoformV2?.config).toBe(config);
  expect(selected.takoformV2?.storageLineage).toBe("v2-0088");
  expect(
    (deploymentVariables(selected).vars as Record<string, string>).TAKOSERVER_TAKOFORM_V2_CONFIG,
  ).toBe(config);
  expect(expectedWorkerSecrets(selected)).toEqual([
    "TAKOSERVER_SIGNING_KEY",
    "TAKOSERVER_TAKOFORM_V2_CURSOR_KEY",
  ]);
  expect(workerCompositionEnv(selected)).toMatchObject({ TAKOSERVER_TAKOFORM_V2_CONFIG: config });
  await expect(assertTargetComposes("preflight", selected)).resolves.toBeUndefined();
  const root = mkdtempSync(join(tmpdir(), "takoserver-v2-realized-"));
  try {
    const path = writeWorkerConfig(selected, {
      path: join(root, "realized.json"),
      main: "worker.js",
      commit: "a".repeat(40),
    });
    const realized = JSON.parse(readFileSync(path, "utf8")) as {
      readonly vars: Record<string, string>;
      readonly secrets: { readonly required: readonly string[] };
    };
    expect(realized.vars.TAKOSERVER_TAKOFORM_V2_CONFIG).toBe(config);
    expect(realized.vars).not.toHaveProperty("TAKOSERVER_TAKOFORM_V2_CURSOR_KEY");
    expect(realized.secrets.required).toEqual(expectedWorkerSecrets(selected));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an artifact Form config on the historical 0075 lineage refuses to compose before upload", async () => {
  const historical = parseDeployTarget(
    { ...descriptor(), takoformV2: { config } },
    "historical lineage target",
    "integration",
  );
  await expect(assertTargetComposes("preflight", historical)).rejects.toThrow(
    "configured v2 artifact Forms require the complete 0081 schema",
  );
  const withoutArtifacts = parseDeployTarget(
    {
      ...descriptor(),
      takoformV2: {
        config: JSON.stringify({
          documentation: "https://docs.example.invalid/v2",
          authenticationDocumentation: "https://docs.example.invalid/auth",
        }),
      },
    },
    "historical lineage target without artifact Forms",
    "integration",
  );
  await expect(assertTargetComposes("preflight", withoutArtifacts)).resolves.toBeUndefined();
  // A maintenance Host never starts Forms, so the 0081 rule does not apply to it.
  const maintenance = parseDeployTarget(
    { ...descriptor(), takoformV2: { config }, schemaMaintenanceMode: "pre-v2-0088-quiesced" },
    "maintenance target",
    "integration",
  );
  await expect(assertTargetComposes("preflight", maintenance)).resolves.toBeUndefined();
});

test("invalid, secret-bearing, or non-integration v2 descriptors refuse without echoing input", () => {
  for (const invalid of [
    "not-json-private-marker",
    JSON.stringify({ documentation: "https://docs.example.invalid/v2" }),
    JSON.stringify({
      documentation: "https://docs.example.invalid/v2",
      authenticationDocumentation: "https://docs.example.invalid/auth",
      cursorSigningKey: "private-marker",
    }),
  ]) {
    let error: unknown;
    try {
      parseDeployTarget(
        { ...descriptor(), takoformV2: { config: invalid } },
        "test",
        "integration",
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("takoformV2.config");
    expect(String(error)).not.toContain("private-marker");
  }
  for (const environment of ["rehearsal", "production"] as const) {
    expect(() => parseDeployTarget(descriptor(environment), "test", environment)).toThrow(
      "integration-only",
    );
  }
  expect(() =>
    parseDeployTarget(
      { ...descriptor(), schemaMaintenanceMode: "pre-0058-quiesced" },
      "test",
      "integration",
    ),
  ).toThrow("maintenance");
});
