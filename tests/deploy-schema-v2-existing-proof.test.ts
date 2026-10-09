import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveExpectedApplicationShape } from "../scripts/deploy/application-schema-shape.ts";
import { REPOSITORY } from "../scripts/deploy/process.ts";
import { expectedWorkerSecrets } from "../scripts/deploy/realized-config.ts";
import {
  readCurrentAuditedMigrationSourceArtifact,
  runD1Schema,
} from "../scripts/deploy/schema.ts";
import {
  inspectV2ExistingMaintenancePublication,
  type V2ExistingMaintenanceWorkerState,
} from "../scripts/deploy/schema-v2-existing-transition.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import type { ProviderExecutorInspection } from "../scripts/deploy/worker.ts";
import { expectedExactBindingClosure } from "../scripts/deploy/worker-state.ts";

const selectedCommit = "a".repeat(40);
const privateSelectedCommit = "b".repeat(40);
const privatePredecessorCommit = "c".repeat(40);
const predecessorCommit = "af6dd0e6b38a23a075ee47f5d60d4d04173676ff";
const code = "export default { fetch() { return new Response('maintenance'); } };\n";
const digest = createHash("sha256").update(code).digest("hex");
const currentId = "00000000-0000-4000-8000-000000000088";
const predecessorId = "00000000-0000-4000-8000-000000000066";
const deploymentId = "00000000-0000-4000-8000-000000000089";
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
  publicOrigin: "https://api.integration.example.test",
  signing: { currentKeyId: "current" },
  takoformV2: {
    config: JSON.stringify({
      documentation: "https://docs.example.test/v2",
      authenticationDocumentation: "https://docs.example.test/auth",
    }),
  },
  schemaMaintenanceMode: "pre-v2-0088-quiesced",
  cloudflareProviderExecutor: {
    workerName: "takoserver-cpe-integration",
    dispatchNamespace: "takoserver-managed-integration",
    gatewayWorkerName: "takoserver-gateway-integration",
    managedBaseDomain: "managed.integration.example.test",
    providerInstallationId: "provider-installation",
    receiptAuthorityWorkerName: "takoserver-receipts-integration",
  },
} satisfies DeployTarget;

function deployment(id: string, versionId: string, created: string) {
  return { id, created_on: created, versions: [{ version_id: versionId, percentage: 100 }] };
}

function version(id: string, commit: string) {
  const expected = expectedExactBindingClosure(target);
  return {
    id,
    annotations: {
      "workers/message": `takoserver-worker:${commit}:${digest}`,
      "workers/triggered_by": "version_upload",
    },
    resources: {
      bindings: Object.entries(expected).flatMap(([name, requirement]) =>
        requirement === null ? [] : [{ name, type: requirement.type, ...requirement.fields }],
      ),
    },
  };
}

function moduleBytes(bytes: string = code) {
  return {
    main_module: "worker.js",
    modules: [
      {
        name: "worker.js",
        content_type: "application/javascript+module",
        content_base64: Buffer.from(bytes).toString("base64"),
      },
    ],
  };
}

function state(nativeCurrent: string = code): V2ExistingMaintenanceWorkerState {
  return {
    async workerDomains() {
      return [{ hostname: "api.integration.example.test", service: target.workerName }];
    },
    async workerDeployments() {
      return [
        deployment(deploymentId, currentId, "2026-10-08T01:00:00Z"),
        deployment("00000000-0000-4000-8000-000000000067", predecessorId, "2026-10-07T01:00:00Z"),
      ];
    },
    async workerVersion(_name, id) {
      return version(id, id === currentId ? selectedCommit : predecessorCommit);
    },
    async workerSecrets() {
      return expectedWorkerSecrets(target).map((name) => ({ name, type: "secret_text" }));
    },
    async workerVersionWithModules(_name, id) {
      return moduleBytes(id === currentId ? nativeCurrent : code);
    },
  };
}

const provider: ProviderExecutorInspection = {
  status: "stale",
  ready: false,
  managedExact: true,
  routeLess: true,
  schemaReady: false,
  dependencies: {
    ready: false,
    receiptAuthorityReady: false,
    receiptAuthorityVersionId: null,
    managedWorkerGatewayReady: false,
    managedWorkerGatewayVersionId: null,
  },
  versionId: "00000000-0000-4000-8000-000000000091",
  deploymentId: "00000000-0000-4000-8000-000000000092",
  previousVersionId: "00000000-0000-4000-8000-000000000093",
  commit: privateSelectedCommit,
  bundleDigestHex: digest,
  moduleDigestHex: digest,
  maintenance: {
    mode: "pre-v2-0088-quiesced",
    accountId: target.accountId,
    databaseId: target.d1.databaseId,
    databaseName: target.d1.databaseName,
    workerName: target.cloudflareProviderExecutor.workerName,
    activeVersionId: "00000000-0000-4000-8000-000000000091",
    activeDeploymentId: "00000000-0000-4000-8000-000000000092",
    previousVersionId: "00000000-0000-4000-8000-000000000093",
    selectedSourceCommit: privateSelectedCommit,
    selectedModuleDigestHex: digest,
    predecessorSourceCommit: privatePredecessorCommit,
    predecessorVersionId: "00000000-0000-4000-8000-000000000093",
    observedNonCodeDigestHex: "f".repeat(64),
  },
};

function input(nativeCurrent = code) {
  return {
    phase: "preflight" as const,
    target,
    selectedCommit,
    providerExecutorSourceCommit: privateSelectedCommit,
    selectedBuiltModuleDigestHex: digest,
    buildHistorical: async () => digest,
    state: state(nativeCurrent),
    providerExecutorQualification: {
      async read() {
        return provider;
      },
    },
    run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  };
}

describe("0088 exact non-serving publication proof", () => {
  test("accepts the same native bytes as both selected and historical builds", async () => {
    const proof = await inspectV2ExistingMaintenancePublication(input());
    expect(proof).toMatchObject({
      publicVersionId: currentId,
      publicPredecessorVersionId: predecessorId,
      publicModuleDigestHex: digest,
    });
    expect(proof.provider.maintenance?.selectedSourceCommit).toBe(privateSelectedCommit);
    expect(proof.provider.maintenance?.selectedSourceCommit).not.toBe(selectedCommit);
  });

  test("rejects a private CPE source vector inconsistent within its own repo", async () => {
    const maintenance = provider.maintenance;
    if (maintenance === undefined) throw new Error("fixture maintenance is missing");
    await expect(
      inspectV2ExistingMaintenancePublication({
        ...input(),
        providerExecutorQualification: {
          async read() {
            return {
              ...provider,
              maintenance: {
                ...maintenance,
                selectedSourceCommit: selectedCommit,
              },
            };
          },
        },
      }),
    ).rejects.toThrow("private CPE maintenance publication is not exact");
  });

  test("rejects a different owner-selected private source despite exact public bytes", async () => {
    await expect(
      inspectV2ExistingMaintenancePublication({
        ...input(),
        providerExecutorSourceCommit: "d".repeat(40),
      }),
    ).rejects.toThrow("private CPE maintenance publication is not exact");
  });

  test("refuses selected native bytes drift despite matching annotation", async () => {
    await expect(
      inspectV2ExistingMaintenancePublication(input(`${code}// drift\n`)),
    ).rejects.toThrow("native bytes differ");
  });

  test("refuses historical source outside the repository-compatible entry boundary", async () => {
    await expect(
      inspectV2ExistingMaintenancePublication({
        ...input(),
        run: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
      }),
    ).rejects.toThrow("pre-v2 entry source");
  });
});

async function runApplyFixture(
  options: {
    readonly acknowledgement?: "ok" | "failed" | "thrown";
    readonly afterCount?: number;
    readonly driftAtProofRead?: number;
    readonly onDispatch?: () => void;
    readonly providerExecutorSourceCommit?: string;
  } = {},
) {
  const maintenance = provider.maintenance;
  if (maintenance === undefined) throw new Error("fixture maintenance is missing");
  const root = mkdtempSync(join(tmpdir(), "takoserver-v2-existing-wave-"));
  copyFileSync(join(REPOSITORY, "wrangler.jsonc"), join(root, "wrangler.jsonc"));
  const source = readCurrentAuditedMigrationSourceArtifact();
  let count = 66;
  let applyCount = 0;
  let proofReadCount = 0;
  const shape = (applied: number) => {
    const value = deriveExpectedApplicationShape(source.files.slice(0, applied));
    return {
      applied: source.names.slice(0, applied),
      shape: value,
      shapeDigest: `sha256:${createHash("sha256").update(value).digest("hex")}`,
    };
  };
  const run = async (command: readonly string[]) => {
    const key = command.join(" ");
    if (key === "git rev-parse HEAD")
      return { exitCode: 0, stdout: `${selectedCommit}\n`, stderr: "" };
    if (key === "git branch --show-current")
      return { exitCode: 0, stdout: "candidate/v2-0088\n", stderr: "" };
    if (key === "git status --porcelain=v1 -z --untracked-files=all")
      return { exitCode: 0, stdout: "", stderr: "" };
    if (command[0] === "git" && command[1] === "-C" && command[3] === "rev-parse")
      return { exitCode: 0, stdout: `${predecessorCommit}\n`, stderr: "" };
    if (command[0] === "git" && command[1] === "-C" && command[3] === "status")
      return { exitCode: 0, stdout: "", stderr: "" };
    if (command[0] === "git" && command[1] === "merge-base")
      return { exitCode: 0, stdout: "", stderr: "" };
    if (command.includes("--dry-run")) {
      const out = command[command.indexOf("--outdir") + 1];
      if (!out) throw new Error("missing dry-run output directory");
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, "index.js"), code);
      return { exitCode: 0, stdout: "built", stderr: "" };
    }
    if (key === "bun run check:migrations") return { exitCode: 0, stdout: "green", stderr: "" };
    if (command.includes("migrations") && command.includes("apply")) {
      applyCount++;
      options.onDispatch?.();
      count = options.afterCount ?? 88;
      if (options.acknowledgement === "thrown") throw new Error("provider response lost");
      return {
        exitCode: options.acknowledgement === "failed" ? 1 : 0,
        stdout: "applied",
        stderr: "",
      };
    }
    throw new Error(`unexpected test command: ${key}`);
  };
  try {
    const result = await runD1Schema(
      {
        action: "apply",
        environment: "integration",
        commit: selectedCommit,
        throughMigration: "0088",
      },
      target,
      {
        run,
        reader: {
          async read() {
            return shape(count);
          },
          async v2ExistingSnapshot(_phase, appliedCount) {
            return {
              epochState: appliedCount < 68 ? ("absent" as const) : ("closed" as const),
              providerInvocationCount: 0,
              v2ResourceCount: 0,
            };
          },
        },
        outputDirectory: join(root, "work"),
        leaseRoot: join(root, "leases"),
        cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "fixture-token" },
        review: "reviewer@example.test",
        v2ExistingMaintenance: {
          historicalSourceRoot: root,
          providerExecutorSourceCommit:
            options.providerExecutorSourceCommit ?? privateSelectedCommit,
          publicWorkerState: state(),
          providerExecutorQualification: {
            async read() {
              proofReadCount++;
              return proofReadCount >= (options.driftAtProofRead ?? Number.POSITIVE_INFINITY)
                ? {
                    ...provider,
                    maintenance: {
                      ...maintenance,
                      observedNonCodeDigestHex: "e".repeat(64),
                    },
                  }
                : provider;
            },
          },
        },
      },
    );
    return { result, applyCount, proofReadCount, source };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("one selected existing-target apply reconciles its exact 0088 readback without a second dispatch", async () => {
  const { result, applyCount, proofReadCount, source } = await runApplyFixture();
  expect(result).toMatchObject({
    throughMigration: "0088_v2_worker_sqlite_external_drain.sql",
    appliedMigrations: source.names.slice(0, 88),
  });
  expect(applyCount).toBe(1);
  expect(proofReadCount).toBe(6);
});

test("a thrown provider ACK is reconciled only by complete authoritative readback", async () => {
  const { result, applyCount } = await runApplyFixture({ acknowledgement: "thrown" });
  expect(result).toMatchObject({
    providerAcknowledgement: "provider-error-recovered-by-authoritative-readback",
  });
  expect(applyCount).toBe(1);
  await expect(runApplyFixture({ acknowledgement: "thrown", afterCount: 69 })).rejects.toThrow(
    "partially applied",
  );
});

test("a last-edge CPE publication change refuses before the migration dispatch", async () => {
  let dispatches = 0;
  await expect(
    runApplyFixture({ driftAtProofRead: 5, onDispatch: () => dispatches++ }),
  ).rejects.toThrow("maintenance proof changed");
  expect(dispatches).toBe(0);
});

test("the composed writer refuses a wrong private CPE source without dispatch", async () => {
  let dispatches = 0;
  await expect(
    runApplyFixture({
      providerExecutorSourceCommit: "d".repeat(40),
      onDispatch: () => dispatches++,
    }),
  ).rejects.toThrow("private CPE maintenance publication is not exact");
  expect(dispatches).toBe(0);
});
