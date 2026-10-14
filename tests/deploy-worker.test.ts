import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveExpectedApplicationShape } from "../scripts/deploy/application-schema-shape.ts";
import { DeployError } from "../scripts/deploy/errors.ts";
import { readMigrationArtifact } from "../scripts/deploy/migrations.ts";
import type { CommandResult } from "../scripts/deploy/process.ts";
import { expectedWorkerSecrets } from "../scripts/deploy/realized-config.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import type {
  ProviderExecutorInspection,
  WorkerStripeModeRealmReader,
} from "../scripts/deploy/worker.ts";
import {
  authoritySensitiveWorkerPaths,
  probeMoneyCutoverProductOrFrozen,
  probeProduct,
  probeSchemaMaintenance,
  providerExecutorAllowsPublication,
  runWorker,
  type WorkerMigrationReader,
  type WorkerProcess,
  type WorkerState,
  workerMoneyUnitSchemaReady,
  workerSchemaAllowsPending,
} from "../scripts/deploy/worker.ts";
import {
  authorityImplementationClosure,
  declaredAuthorityModulePaths,
  publicFormIdentityAuthorityPaths,
} from "../scripts/deploy/worker-authority-paths.ts";
import { expectedExactBindingClosure } from "../scripts/deploy/worker-state.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import { INTEGRATION_E2E_ORGANIZATION_ID } from "../src/integration-e2e-credential-authority.ts";
import { STRIPE_MODE_REALM_SCHEMA_QUERY } from "../src/stripe-mode-realm.ts";
import { objectBucketSuppliesFixture } from "./helpers/hosted-supply-fixtures.ts";
import {
  completeIntegrationStorageState,
  integrationStorageVerificationOptions,
} from "./helpers/integration-storage-generation-verification.ts";

const COMMIT = "a".repeat(40);
const LIVE_COMMIT = "b".repeat(40);
const BUNDLE = "export default {fetch(){return new Response('ok')}};\n";
const SELECTED_NATIVE_CONFIG = JSON.parse(
  readFileSync(join(import.meta.dir, "../wrangler.jsonc"), "utf8"),
) as { observability: unknown; triggers: { crons: string[] } };
const VERSION_BEFORE = "00000000-0000-4000-8000-000000000001";
const VERSION_AFTER = "00000000-0000-4000-8000-000000000002";
const V2_DEPLOYMENT_AFTER = "00000000-0000-4000-8000-000000000012";
const VERSION_UNRELATED = "00000000-0000-4000-8000-000000000003";
const VERSION_UNRELATED_PREVIOUS = "00000000-0000-4000-8000-000000000004";
const OTHER_COMMIT = "d".repeat(40);
const CANONICAL_STRIPE_REALM_SCHEMA = (() => {
  const db = new Database(":memory:");
  const migration = MIGRATIONS.find((item) => item.name === "0098_stripe_mode_realm.sql");
  if (!migration) throw new Error("missing 0098 Stripe mode realm source migration");
  db.exec(migration.sql);
  const rows = db.query(STRIPE_MODE_REALM_SCHEMA_QUERY).all() as {
    type: string;
    name: string;
    sql: string;
  }[];
  db.close();
  return rows;
})();
const ARTIFACT_BLOB_IO_COMPATIBILITY_PENDING = [
  "0037_worker_runtime_input_preparation_v2.sql",
  "0038_selfhost_edge_kv.sql",
  "0039_takoform_live_native_claim_across_tenants.sql",
  "0040_selfhost_queues_and_schedules.sql",
  "0041_selfhost_object_buckets.sql",
  "0042_worker_endpoint_origin_reservation_space_id.sql",
  "0043_artifact_blob_io_fences.sql",
] as const;

const target = {
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
} satisfies DeployTarget;

const v2StorageName = `takoserver-i-${"f".repeat(32)}`;
const v2Target = {
  ...target,
  d1: { databaseName: v2StorageName, databaseId: "00000000-0000-4000-8000-000000000075" },
  r2: { bucketName: v2StorageName },
  takoformV2: {
    config: JSON.stringify({
      documentation: "https://docs.example.test/v2",
      authenticationDocumentation: "https://docs.example.test/v2/authentication",
    }),
  },
} satisfies DeployTarget;

const schemaMaintenanceTarget = {
  ...target,
  schemaMaintenanceMode: "pre-0058-quiesced",
} satisfies DeployTarget;

const canonicalMigrations = readMigrationArtifact().names;
const canonicalMoneyShape = deriveExpectedApplicationShape(readMigrationArtifact().files);
const canonicalMoneyShapeDigest = `sha256:${createHash("sha256").update(canonicalMoneyShape).digest("hex")}`;
const canonical0092Shape = deriveExpectedApplicationShape(
  readMigrationArtifact().files.slice(0, 92),
);
const canonical0092ShapeDigest = `sha256:${createHash("sha256").update(canonical0092Shape).digest("hex")}`;
const canonicalMoneyPolicy = [
  {
    ledger_unit: "usd-micros-v2",
    historical_usage_unit: "microcent-v1",
    cash_unit: "usd-cents-v1",
  },
];
const exact0057 = canonicalMigrations.slice(0, 57);

const executorTarget = {
  ...target,
  objectBucketSupplies: objectBucketSuppliesFixture(),
  cloudflareProviderExecutor: {
    workerName: "takoserver-cloudflare-provider-executor-integration",
    dispatchNamespace: "takoserver-managed-workers-integration",
    gatewayWorkerName: "takoserver-managed-worker-gateway-integration",
    managedBaseDomain: "workers.integration.example.test",
    providerInstallationId: "cloudflare.staging",
    receiptAuthorityWorkerName: "takoserver-object-receipts-integration",
  },
} satisfies DeployTarget;

const maintenanceExecutorTarget = {
  ...executorTarget,
  artifactBlobIoMode: "pre-0043-quiesced",
} satisfies DeployTarget;

function fixture(
  input: {
    readonly diff?: string;
    readonly dirty?: string;
    readonly applied?: readonly string[];
    readonly beforeMessage?: string | null;
    readonly beforeMessageAfterBuild?: string | null;
    readonly afterMessage?: string | null;
    readonly unrelatedMessage?: string | null;
    readonly current?: "before" | "after" | "unrelated";
    readonly advanceDuringBuild?: boolean;
    readonly secretsAfterBuild?: readonly unknown[];
    readonly legacyBeforeWithoutVersionMetadata?: boolean;
    readonly beforeVersionMetadataAfterBuild?: boolean;
    readonly afterWithoutVersionMetadata?: boolean;
    readonly replaceDeploymentDuringFinalInspection?: boolean;
    readonly selectedTarget?: DeployTarget;
    readonly local?: readonly string[];
    readonly auditedShape?: string;
    readonly stripeModePin?: "test" | "live" | null;
    readonly corruptStripeModeTriggers?: boolean;
    readonly changeStripeModeAfterBuild?: "test" | "live" | null;
    readonly loseVersionDeployAcknowledgment?: boolean;
  } = {},
): {
  readonly run: WorkerProcess;
  readonly calls: string[][];
  readonly state: WorkerState;
  readonly migrations: WorkerMigrationReader;
  readonly stripeModeRealm: WorkerStripeModeRealmReader;
} {
  const calls: string[][] = [];
  const selectedTarget: DeployTarget = input.selectedTarget ?? target;
  let current = input.current ?? "before";
  let built = false;
  let replacementObserved = false;
  let uploadMessage: string | null = null;
  let stripeModePin = input.stripeModePin === undefined ? "test" : input.stripeModePin;
  const run: WorkerProcess = async (command, options): Promise<CommandResult> => {
    calls.push([...command]);
    const key = command.join(" ");
    if (key === "git rev-parse HEAD") return ok(`${COMMIT}\n`);
    if (key === "git branch --show-current") return ok("feature/worker\n");
    if (key === "git status --porcelain=v1 -z --untracked-files=all") {
      return ok(input.dirty ?? "");
    }
    if (key === `git diff --name-only ${LIVE_COMMIT}..${COMMIT} --`) {
      return ok(input.diff ?? "src/catalog.ts\n");
    }
    if (key === "bun run check") return ok("green\n");
    if (command.includes("--dry-run")) {
      const out = command[command.indexOf("--outdir") + 1];
      if (!out) throw new Error("dry-run output missing");
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, "index.js"), BUNDLE);
      writeFileSync(join(out, "index.js.map"), "{}\n");
      writeFileSync(join(out, "README.md"), "generated by Wrangler\n");
      built = true;
      if (input.advanceDuringBuild === true) current = "after";
      if (input.changeStripeModeAfterBuild !== undefined) {
        stripeModePin = input.changeStripeModeAfterBuild;
      }
      return ok("Total Upload: 1 KiB\n");
    }
    if (command.includes("versions") && command.includes("upload")) {
      uploadMessage = command[command.indexOf("--message") + 1] ?? null;
      const outputPath = options?.env?.WRANGLER_OUTPUT_FILE_PATH;
      if (!outputPath) throw new Error("version upload output path missing");
      writeFileSync(
        outputPath,
        JSON.stringify({
          type: "version-upload",
          version: 1,
          worker_name: selectedTarget.workerName,
          worker_tag: null,
          version_id: VERSION_AFTER,
          preview_url: null,
          preview_alias_url: null,
          worker_name_overridden: false,
        }),
      );
      return ok("Uploaded\n");
    }
    if (command.includes("versions") && command.includes("deploy")) {
      const outputPath = options?.env?.WRANGLER_OUTPUT_FILE_PATH;
      if (!outputPath) throw new Error("version deploy output path missing");
      writeFileSync(
        outputPath,
        JSON.stringify({
          type: "version-deploy",
          version: 1,
          worker_name: selectedTarget.workerName,
          worker_tag: null,
          deployment_id: V2_DEPLOYMENT_AFTER,
          version_traffic: {},
        }),
      );
      current = "after";
      return input.loseVersionDeployAcknowledgment === true
        ? { exitCode: 1, stdout: "", stderr: "deployment acknowledgment lost" }
        : ok("Deployed\n");
    }
    if (command.includes("deploy") && command.includes("--no-bundle")) {
      uploadMessage = command[command.indexOf("--message") + 1] ?? null;
      current = "after";
      return ok("Uploaded\n");
    }
    throw new Error(`unexpected command: ${key}`);
  };
  const state: WorkerState = {
    async workerDomains() {
      return [{ hostname: "api.integration.example.test", service: selectedTarget.workerName }];
    },
    async workerDeployments() {
      if (current === "before") {
        if (replacementObserved) {
          return [deployment("deployment-before-replaced", VERSION_BEFORE, "2026-08-28T04:00:00Z")];
        }
        return [deployment("deployment-before", VERSION_BEFORE, "2026-08-28T01:00:00Z")];
      }
      if (current === "unrelated") {
        return [
          deployment("deployment-unrelated", VERSION_UNRELATED, "2026-08-28T03:00:00Z"),
          deployment(
            "deployment-unrelated-previous",
            VERSION_UNRELATED_PREVIOUS,
            "2026-08-28T02:00:00Z",
          ),
        ];
      }
      return [
        deployment(
          selectedTarget.takoformV2 ? V2_DEPLOYMENT_AFTER : "deployment-after",
          VERSION_AFTER,
          "2026-08-28T02:00:00Z",
        ),
        deployment("deployment-before", VERSION_BEFORE, "2026-08-28T01:00:00Z"),
      ];
    },
    async workerVersion(_worker, versionId) {
      const message =
        versionId === VERSION_BEFORE
          ? built && input.beforeMessageAfterBuild !== undefined
            ? input.beforeMessageAfterBuild
            : input.beforeMessage === undefined
              ? `takoserver-worker:${LIVE_COMMIT}:${"c".repeat(64)}`
              : input.beforeMessage
          : versionId === VERSION_AFTER
            ? input.afterMessage === undefined
              ? (uploadMessage ?? "missing")
              : input.afterMessage
            : input.unrelatedMessage === undefined
              ? `takoserver-worker:${OTHER_COMMIT}:${"e".repeat(64)}`
              : input.unrelatedMessage;
      const result =
        input.selectedTarget !== undefined &&
        message !== null &&
        /^takoserver-worker:[0-9a-f]{40}:[0-9a-f]{64}$/u.test(message) &&
        !(
          versionId === VERSION_BEFORE &&
          input.legacyBeforeWithoutVersionMetadata === true &&
          !(built && input.beforeVersionMetadataAfterBuild === true)
        )
          ? versionForTarget(versionId, message, selectedTarget)
          : version(
              versionId,
              message,
              versionId === VERSION_BEFORE &&
                input.legacyBeforeWithoutVersionMetadata === true &&
                !(built && input.beforeVersionMetadataAfterBuild === true)
                ? "legacy-pre-version-metadata"
                : versionId === VERSION_AFTER && input.afterWithoutVersionMetadata === true
                  ? "legacy-pre-version-metadata"
                  : "current",
              selectedTarget,
            );
      if (
        built &&
        versionId === VERSION_BEFORE &&
        input.replaceDeploymentDuringFinalInspection === true
      ) {
        replacementObserved = true;
      }
      return result;
    },
    async workerSecrets() {
      if (built && input.secretsAfterBuild !== undefined) return input.secretsAfterBuild;
      return expectedWorkerSecrets(selectedTarget).map((name) => ({ name, type: "secret_text" }));
    },
  };
  return {
    run,
    calls,
    state,
    migrations: {
      async read() {
        return {
          local: input.local ?? canonicalMigrations,
          applied: input.applied ?? canonicalMigrations,
          shape: input.auditedShape ?? canonicalMoneyShape,
          shapeDigest:
            input.auditedShape === undefined
              ? canonicalMoneyShapeDigest
              : `sha256:${createHash("sha256").update(input.auditedShape).digest("hex")}`,
          moneyUnitPolicy: canonicalMoneyPolicy,
        };
      },
    },
    stripeModeRealm: {
      async read() {
        return {
          schema: input.corruptStripeModeTriggers === true ? [] : CANONICAL_STRIPE_REALM_SCHEMA,
          pins: stripeModePin === null ? [] : [{ mode: stripeModePin }],
        };
      },
    },
  };
}

describe("split Takoserver Worker surfaces", () => {
  test("qualified 0094 publication distinguishes exact frozen refusal from readiness", async () => {
    const origin = "https://money.example.workers.dev";
    const frozen = async (_url: string) =>
      Response.json(
        {
          error: {
            code: "backend_unavailable",
            message: "Host is frozen for the wallet USD-micros writer transition",
            details: { reason: "money-cutover-freeze" },
          },
        },
        { status: 503, headers: { "cache-control": "no-store", "retry-after": "60" } },
      );
    expect(await probeMoneyCutoverProductOrFrozen(origin, frozen)).toMatchObject({
      status: 503,
      traffic: "money-frozen",
    });
    await expect(
      probeMoneyCutoverProductOrFrozen(origin, async () =>
        Response.json(
          {
            error: {
              code: "backend_unavailable",
              message: "wrong refusal",
              details: { reason: "money-cutover-freeze" },
            },
          },
          { status: 503, headers: { "cache-control": "no-store", "retry-after": "60" } },
        ),
      ),
    ).rejects.toThrow("exact guarded refusal");
  });
  test("transaction-fenced selected Host refuses 0095 until its trigger-restoring suffix", () => {
    const selected = {
      ...v2Target,
      takoformV2: { ...v2Target.takoformV2, storageLineage: "v2-0092" as const },
      moneyCutoverWriterPolicy: "transaction-fenced-usd-micros-v1" as const,
      moneyCutoverWriterEpoch: `sha256:${"a".repeat(64)}`,
    };
    expect(
      workerSchemaAllowsPending(selected, {
        local: canonicalMigrations,
        applied: canonicalMigrations,
        shape: canonicalMoneyShape,
        shapeDigest: canonicalMoneyShapeDigest,
      }),
    ).toBe(false);
  });
  test("pre-0098 status proves the active Host and stable subdomain are non-serving without reading partial D1", async () => {
    const selected = {
      ...v2Target,
      takoformV2: {
        ...v2Target.takoformV2,
        storageLineage: "v2-0088" as const,
        appliedSchemaLineage: "v2-0092" as const,
      },
      schemaMaintenanceMode: "pre-v2-0098-quiesced" as const,
    };
    const digest = "5dfe093447c1e4b6b1014ba8a4a85433d111ebc169be9bf4fe165b67ee14ca1d";
    const nativeBindings = versionForTarget(
      VERSION_BEFORE,
      `takoserver-worker:${COMMIT}:${digest}`,
      selected,
    ).resources.bindings;
    const current = fixture({
      selectedTarget: selected,
      beforeMessage: `takoserver-worker:${COMMIT}:${digest}`,
      applied: canonicalMigrations.slice(0, 95),
    });
    const nativeReads: string[] = [];
    const nativeState = {
      ...current.state,
      async workerVersionWithModules(_name: string, versionId: string) {
        nativeReads.push("module");
        return {
          id: versionId,
          main_module: "worker.js",
          modules: [
            {
              name: "worker.js",
              content_type: "application/javascript+module",
              content_base64: Buffer.from(BUNDLE).toString("base64"),
            },
          ],
          compatibility_date: "2026-08-17",
          compatibility_flags: ["nodejs_compat"],
        };
      },
      async workerSettings() {
        nativeReads.push("settings");
        return { bindings: nativeBindings, observability: SELECTED_NATIVE_CONFIG.observability };
      },
      async workerSchedules() {
        nativeReads.push("schedules");
        return SELECTED_NATIVE_CONFIG.triggers.crons;
      },
      async workerRoutes() {
        nativeReads.push("routes");
        return [];
      },
      async workerSubdomain() {
        nativeReads.push("subdomain");
        return { enabled: false, previewsEnabled: false };
      },
    };
    const status = await runWorker(
      {
        surface: "takoserver-worker",
        action: "status",
        environment: "integration",
        commit: COMMIT,
      },
      selected,
      {
        ...current,
        state: nativeState,
        migrations: {
          read: async () => {
            throw new Error("partial D1 must not be read");
          },
        },
        integrationStorageVerification: integrationStorageVerificationOptions(selected, {
          readState: async () => {
            throw new Error("partial D1 must not be read");
          },
        }),
        fetcher: async (url, init) => {
          expect(url).toBe(`${selected.publicOrigin}/healthz`);
          expect(init?.method).toBe("GET");
          return Response.json(
            {
              error: {
                code: "backend_unavailable",
                message: "Host is quiesced for the v2 0098 schema maintenance transition",
                details: { reason: "runtime-configuration" },
              },
            },
            { status: 503, headers: { "cache-control": "no-store", "retry-after": "60" } },
          );
        },
      },
    );
    expect(status).toMatchObject({
      kind: "takoserver.worker-status@v2",
      maintenance: "pre-v2-0098-quiesced",
      nativeNonServing: true,
      schemaUnproven: true,
      ready: false,
      schemaReady: false,
      versionId: VERSION_BEFORE,
      probe: { status: 503, traffic: "maintenance" },
    });
    expect(nativeReads).toEqual([
      "module",
      "settings",
      "schedules",
      "routes",
      "subdomain",
      "module",
      "settings",
      "schedules",
      "routes",
      "subdomain",
    ]);
    expect(current.calls.map((command) => command.slice(0, 3))).toEqual([
      ["git", "rev-parse", "HEAD"],
      ["git", "branch", "--show-current"],
      ["git", "status", "--porcelain=v1"],
      [expect.any(String), "versions", "upload"],
    ]);
    expect(current.calls[3]).toContain("--dry-run");
    for (const [label, state] of [
      [
        "observability",
        {
          ...nativeState,
          async workerSettings() {
            return { bindings: nativeBindings, observability: { enabled: false } };
          },
        },
      ],
      [
        "schedules",
        {
          ...nativeState,
          async workerSchedules() {
            return ["0 0 * * *"];
          },
        },
      ],
      [
        "placement",
        {
          ...nativeState,
          async workerSettings() {
            return {
              bindings: nativeBindings,
              observability: SELECTED_NATIVE_CONFIG.observability,
              placement: { mode: "smart" },
            };
          },
        },
      ],
      [
        "foreign metadata",
        {
          ...nativeState,
          async workerSettings() {
            return {
              bindings: nativeBindings,
              observability: SELECTED_NATIVE_CONFIG.observability,
              foreign_behavior: true,
            };
          },
        },
      ],
    ] as const) {
      let probed = false;
      await expect(
        runWorker(
          {
            surface: "takoserver-worker",
            action: "status",
            environment: "integration",
            commit: COMMIT,
          },
          selected,
          {
            ...current,
            state,
            fetcher: async () => {
              probed = true;
              throw new Error("foreign native closure must not be probed");
            },
          },
        ),
      ).rejects.toThrow(
        label === "foreign metadata"
          ? "unqualified provider metadata"
          : label === "observability"
            ? "selected profile"
            : label,
      );
      expect(probed).toBe(false);
    }
    await expect(
      runWorker(
        {
          surface: "takoserver-worker",
          action: "status",
          environment: "integration",
          commit: COMMIT,
        },
        selected,
        {
          ...current,
          state: {
            ...nativeState,
            async workerSubdomain() {
              return { enabled: false, previewsEnabled: true };
            },
          },
          fetcher: async () => {
            throw new Error("preview-enabled Host must not be probed");
          },
        },
      ),
    ).rejects.toThrow("subdomain");
    const { workerSubdomain: _missingSubdomain, ...withoutSubdomainReader } = nativeState;
    await expect(
      runWorker(
        {
          surface: "takoserver-worker",
          action: "status",
          environment: "integration",
          commit: COMMIT,
        },
        selected,
        {
          ...current,
          state: withoutSubdomainReader,
          fetcher: async () => {
            throw new Error("missing native subdomain reader must not be probed");
          },
        },
      ),
    ).rejects.toThrow("subdomain readers");
    await expect(
      runWorker(
        {
          surface: "takoserver-worker",
          action: "status",
          environment: "integration",
          commit: COMMIT,
        },
        selected,
        {
          ...current,
          state: {
            ...nativeState,
            async workerSubdomain() {
              return { enabled: false, previewsEnabled: undefined as never };
            },
          },
          fetcher: async () => {
            throw new Error("missing preview readback must not be probed");
          },
        },
      ),
    ).rejects.toThrow("subdomain");
    let observedSubdomains = 0;
    let maintenanceProbed = false;
    await expect(
      runWorker(
        {
          surface: "takoserver-worker",
          action: "status",
          environment: "integration",
          commit: COMMIT,
        },
        selected,
        {
          ...current,
          state: {
            ...nativeState,
            async workerSubdomain() {
              observedSubdomains += 1;
              return { enabled: false, previewsEnabled: observedSubdomains > 1 };
            },
          },
          fetcher: async () => {
            maintenanceProbed = true;
            return Response.json(
              {
                error: {
                  code: "backend_unavailable",
                  message: "Host is quiesced for the v2 0098 schema maintenance transition",
                  details: { reason: "runtime-configuration" },
                },
              },
              { status: 503, headers: { "cache-control": "no-store", "retry-after": "60" } },
            );
          },
        },
      ),
    ).rejects.toThrow("subdomain");
    expect(maintenanceProbed).toBe(true);
    expect(observedSubdomains).toBe(2);
  });

  test("pre-0098 native status accepts the exact workers.dev subdomain with previews disabled", async () => {
    const selected = {
      ...v2Target,
      publicOrigin: `https://${v2Target.workerName}.acct.workers.dev`,
      takoformV2: {
        ...v2Target.takoformV2,
        storageLineage: "v2-0088" as const,
        appliedSchemaLineage: "v2-0092" as const,
      },
      schemaMaintenanceMode: "pre-v2-0098-quiesced" as const,
    };
    const digest = "5dfe093447c1e4b6b1014ba8a4a85433d111ebc169be9bf4fe165b67ee14ca1d";
    const current = fixture({
      selectedTarget: selected,
      beforeMessage: `takoserver-worker:${COMMIT}:${digest}`,
    });
    const bindings = versionForTarget(
      VERSION_BEFORE,
      `takoserver-worker:${COMMIT}:${digest}`,
      selected,
    ).resources.bindings;
    const status = await runWorker(
      {
        surface: "takoserver-worker",
        action: "status",
        environment: "integration",
        commit: COMMIT,
      },
      selected,
      {
        ...current,
        state: {
          ...current.state,
          async workerDomains() {
            return [];
          },
          async workerAccountSubdomain() {
            return "acct";
          },
          async workerSubdomain() {
            return { enabled: true, previewsEnabled: false };
          },
          async workerVersionWithModules(_name, versionId) {
            return {
              id: versionId,
              main_module: "worker.js",
              modules: [
                {
                  name: "worker.js",
                  content_type: "application/javascript+module",
                  content_base64: Buffer.from(BUNDLE).toString("base64"),
                },
              ],
              compatibility_date: "2026-08-17",
              compatibility_flags: ["nodejs_compat"],
            };
          },
          async workerSettings() {
            return { bindings, observability: SELECTED_NATIVE_CONFIG.observability };
          },
          async workerSchedules() {
            return SELECTED_NATIVE_CONFIG.triggers.crons;
          },
          async workerRoutes() {
            return [];
          },
        },
        migrations: {
          read: async () => {
            throw new Error("partial D1 must not be read");
          },
        },
        fetcher: async () =>
          Response.json(
            {
              error: {
                code: "backend_unavailable",
                message: "Host is quiesced for the v2 0098 schema maintenance transition",
                details: { reason: "runtime-configuration" },
              },
            },
            { status: 503, headers: { "cache-control": "no-store", "retry-after": "60" } },
          ),
      },
    );
    expect(status).toMatchObject({ nativeNonServing: true, schemaUnproven: true, ready: false });
  });

  test("pre-0098 status refuses module and settings bindings that disagree with the active Version", async () => {
    const selected = {
      ...v2Target,
      takoformV2: {
        ...v2Target.takoformV2,
        storageLineage: "v2-0088" as const,
        appliedSchemaLineage: "v2-0092" as const,
      },
      schemaMaintenanceMode: "pre-v2-0098-quiesced" as const,
    };
    const digest = "5dfe093447c1e4b6b1014ba8a4a85433d111ebc169be9bf4fe165b67ee14ca1d";
    const current = fixture({
      selectedTarget: selected,
      beforeMessage: `takoserver-worker:${COMMIT}:${digest}`,
    });
    const exactBindings = versionForTarget(
      VERSION_BEFORE,
      `takoserver-worker:${COMMIT}:${digest}`,
      selected,
    ).resources.bindings;
    const driftedBindings = exactBindings.map((binding) =>
      binding.name === "TAKOSERVER_SCHEMA_MAINTENANCE_MODE"
        ? { ...binding, text: "normal" }
        : binding,
    );
    await expect(
      runWorker(
        {
          surface: "takoserver-worker",
          action: "status",
          environment: "integration",
          commit: COMMIT,
        },
        selected,
        {
          ...current,
          state: {
            ...current.state,
            async workerVersionWithModules(_name: string, versionId: string) {
              return {
                id: versionId,
                main_module: "worker.js",
                modules: [
                  {
                    name: "worker.js",
                    content_type: "application/javascript+module",
                    content_base64: Buffer.from(BUNDLE).toString("base64"),
                  },
                ],
                compatibility_date: "2026-08-17",
                compatibility_flags: ["nodejs_compat"],
                bindings: driftedBindings,
              };
            },
            async workerSettings() {
              return {
                workers_dev: false,
                preview_urls: false,
                compatibility_date: "2026-08-17",
                compatibility_flags: ["nodejs_compat"],
                bindings: driftedBindings,
                observability: SELECTED_NATIVE_CONFIG.observability,
              };
            },
            async workerSchedules() {
              return SELECTED_NATIVE_CONFIG.triggers.crons;
            },
            async workerRoutes() {
              return [];
            },
            async workerSubdomain() {
              return { enabled: false, previewsEnabled: false };
            },
          },
          migrations: {
            read: async () => {
              throw new Error("D1 must not be read");
            },
          },
          fetcher: async () =>
            Response.json(
              {
                error: {
                  code: "backend_unavailable",
                  message: "Host is quiesced for the v2 0098 schema maintenance transition",
                  details: { reason: "runtime-configuration" },
                },
              },
              { status: 503, headers: { "cache-control": "no-store", "retry-after": "60" } },
            ),
        },
      ),
    ).rejects.toThrow("native bindings differ");
    expect(current.calls.at(-1)).toContain("--dry-run");
  });

  test("pre-0098 status refuses a self-consistent native Version whose bundle differs from selected source", async () => {
    const selected = {
      ...v2Target,
      takoformV2: {
        ...v2Target.takoformV2,
        storageLineage: "v2-0088" as const,
        appliedSchemaLineage: "v2-0092" as const,
      },
      schemaMaintenanceMode: "pre-v2-0098-quiesced" as const,
    };
    const otherBundle = `${BUNDLE}// native drift\n`;
    const otherDigest = createHash("sha256").update(otherBundle).digest("hex");
    const current = fixture({
      selectedTarget: selected,
      beforeMessage: `takoserver-worker:${COMMIT}:${otherDigest}`,
    });
    let probed = false;
    await expect(
      runWorker(
        {
          surface: "takoserver-worker",
          action: "status",
          environment: "integration",
          commit: COMMIT,
        },
        selected,
        {
          ...current,
          state: {
            ...current.state,
            async workerVersionWithModules(_worker, versionId) {
              return {
                id: versionId,
                main_module: "worker.js",
                modules: [
                  {
                    name: "worker.js",
                    content_type: "application/javascript+module",
                    content_base64: Buffer.from(otherBundle).toString("base64"),
                  },
                ],
              };
            },
            async workerSettings() {
              return {};
            },
            async workerSchedules() {
              return SELECTED_NATIVE_CONFIG.triggers.crons;
            },
            async workerRoutes() {
              return [];
            },
            async workerSubdomain() {
              return { enabled: false, previewsEnabled: false };
            },
          },
          fetcher: async () => {
            probed = true;
            throw new Error("drifted Version must not be probed");
          },
        },
      ),
    ).rejects.toThrow("differs from the selected source bundle");
    expect(probed).toBe(false);
    expect(current.calls.at(-1)).toContain("--dry-run");
  });

  test("pre-0098 Host publication admits only the frozen 0092 shape under audited 0098 source", () => {
    const selected = {
      ...v2Target,
      takoformV2: {
        ...v2Target.takoformV2,
        storageLineage: "v2-0088" as const,
        appliedSchemaLineage: "v2-0092" as const,
      },
      schemaMaintenanceMode: "pre-v2-0098-quiesced" as const,
    };
    const exact = {
      local: canonicalMigrations,
      applied: canonicalMigrations.slice(0, 92),
      shape: canonical0092Shape,
      shapeDigest: canonical0092ShapeDigest,
    };
    expect(workerSchemaAllowsPending(selected, exact)).toBe(true);
    const { schemaMaintenanceMode: _maintenanceMode, ...normal } = selected;
    expect(workerSchemaAllowsPending(normal, exact)).toBe(false);
    for (const invalid of [
      { ...exact, applied: canonicalMigrations.slice(0, 91) },
      { ...exact, applied: canonicalMigrations.slice(0, 93) },
      { ...exact, local: canonicalMigrations.slice(0, 92) },
      { ...exact, shape: "[]" },
      { ...exact, shapeDigest: `sha256:${"0".repeat(64)}` },
      { ...exact, applied: [...canonicalMigrations.slice(0, 91), "0092_foreign.sql"] },
    ])
      expect(workerSchemaAllowsPending(selected, invalid)).toBe(false);
    expect(workerSchemaAllowsPending({ ...selected, environment: "production" }, exact)).toBe(
      false,
    );
    expect(
      workerSchemaAllowsPending(
        { ...selected, takoformV2: { ...selected.takoformV2, storageLineage: "v2-0092" } },
        exact,
      ),
    ).toBe(false);
    const { appliedSchemaLineage: _appliedLineage, ...fresh } = selected.takoformV2;
    expect(workerSchemaAllowsPending({ ...selected, takoformV2: fresh }, exact)).toBe(false);
  });

  test("pre-0098 publication and native status refuse a CPE without its own quiescence proof", async () => {
    const selected = {
      ...v2Target,
      takoformV2: {
        ...v2Target.takoformV2,
        storageLineage: "v2-0088" as const,
        appliedSchemaLineage: "v2-0092" as const,
      },
      schemaMaintenanceMode: "pre-v2-0098-quiesced" as const,
      cloudflareProviderExecutor: executorTarget.cloudflareProviderExecutor,
    };
    const ready = providerExecutorInspection(true);
    expect(providerExecutorAllowsPublication(selected, null)).toBe(false);
    expect(providerExecutorAllowsPublication(selected, ready)).toBe(false);
    expect(
      providerExecutorAllowsPublication(selected, {
        ...ready,
        ready: false,
        schemaReady: false,
        maintenance: {
          mode: "pre-v2-0088-quiesced",
          accountId: selected.accountId,
          databaseId: selected.d1.databaseId,
          databaseName: selected.d1.databaseName,
          workerName: selected.cloudflareProviderExecutor.workerName,
          activeVersionId: ready.versionId ?? "",
          activeDeploymentId: ready.deploymentId ?? "",
          previousVersionId: ready.previousVersionId ?? "",
          selectedSourceCommit: ready.commit ?? "",
          selectedModuleDigestHex: ready.moduleDigestHex ?? "",
          predecessorSourceCommit: OTHER_COMMIT,
          predecessorVersionId: ready.previousVersionId ?? "",
          observedNonCodeDigestHex: "7".repeat(64),
        },
      }),
    ).toBe(false);
    const current = fixture({ selectedTarget: selected });
    await expect(
      runWorker(
        {
          surface: "takoserver-worker",
          action: "status",
          environment: "integration",
          commit: COMMIT,
        },
        selected,
        {
          ...current,
          migrations: {
            read: async () => {
              throw new Error("CPE status must refuse before reading D1");
            },
          },
        },
      ),
    ).rejects.toThrow("owner-injected live qualification");
    expect(current.calls).toEqual([]);
  });

  test("pre-0098 public Host accepts only a CPE proof for its exact 0092 maintenance target", async () => {
    const selected = {
      ...v2Target,
      takoformV2: {
        ...v2Target.takoformV2,
        storageLineage: "v2-0088" as const,
        appliedSchemaLineage: "v2-0092" as const,
      },
      schemaMaintenanceMode: "pre-v2-0098-quiesced" as const,
      cloudflareProviderExecutor: executorTarget.cloudflareProviderExecutor,
    };
    const current = providerExecutorInspection(false);
    const inspection = {
      ...current,
      schemaReady: false,
      maintenance: {
        mode: "pre-v2-0098-quiesced" as const,
        storageLineage: "v2-0088" as const,
        appliedSchemaLineage: "v2-0092" as const,
        accountId: selected.accountId,
        databaseId: selected.d1.databaseId,
        databaseName: selected.d1.databaseName,
        workerName: selected.cloudflareProviderExecutor.workerName,
        activeVersionId: current.versionId ?? "",
        activeDeploymentId: current.deploymentId ?? "",
        previousVersionId: current.previousVersionId ?? "",
        selectedSourceCommit: current.commit ?? "",
        selectedModuleDigestHex: current.moduleDigestHex ?? "",
        observedNonCodeDigestHex: "7".repeat(64),
      },
    };
    expect(providerExecutorAllowsPublication(selected, inspection)).toBe(true);
    for (const altered of [
      { ...inspection, ready: true },
      { ...inspection, schemaReady: true },
      { ...inspection, managedExact: false },
      { ...inspection, routeLess: false },
      { ...inspection, dependencies: { ...inspection.dependencies, ready: false } },
      { ...inspection, status: "drift" as const },
      { ...inspection, maintenance: { ...inspection.maintenance, accountId: "b".repeat(32) } },
      {
        ...inspection,
        maintenance: { ...inspection.maintenance, databaseId: target.d1.databaseId },
      },
      { ...inspection, maintenance: { ...inspection.maintenance, workerName: target.workerName } },
      { ...inspection, maintenance: { ...inspection.maintenance, selectedSourceCommit: COMMIT } },
      {
        ...inspection,
        maintenance: { ...inspection.maintenance, activeVersionId: VERSION_BEFORE },
      },
      {
        ...inspection,
        maintenance: { ...inspection.maintenance, selectedModuleDigestHex: "f".repeat(64) },
      },
      { ...inspection, maintenance: { ...inspection.maintenance, observedNonCodeDigestHex: "" } },
    ])
      expect(providerExecutorAllowsPublication(selected, altered)).toBe(false);
    expect(
      providerExecutorAllowsPublication(
        { ...selected, takoformV2: { ...selected.takoformV2, storageLineage: "v2-0092" } },
        inspection,
      ),
    ).toBe(false);
    const { appliedSchemaLineage: _appliedLineage, ...withoutAppliedLineage } = selected.takoformV2;
    expect(
      providerExecutorAllowsPublication(
        { ...selected, takoformV2: withoutAppliedLineage },
        inspection,
      ),
    ).toBe(false);
    const { maintenance: _missingMaintenance, ...partial } = inspection;
    expect(providerExecutorAllowsPublication(selected, partial)).toBe(false);
    const { schemaMaintenanceMode: _maintenanceMode, ...normal } = selected;
    expect(providerExecutorAllowsPublication(normal, inspection)).toBe(false);
    const { observedNonCodeDigestHex: _missingNonCode, ...partialProof } = inspection.maintenance;
    expect(
      providerExecutorAllowsPublication(selected, {
        ...inspection,
        maintenance: partialProof,
      } as unknown as ProviderExecutorInspection),
    ).toBe(false);
    const currentStatus = fixture({ selectedTarget: selected });
    const qualificationReads = 0;
    await expect(
      runWorker(
        {
          surface: "takoserver-worker",
          action: "status",
          environment: "integration",
          commit: COMMIT,
        },
        selected,
        {
          ...currentStatus,
          migrations: {
            read: async () => {
              throw new Error("CPE status must not read partial D1");
            },
          },
        },
      ),
    ).rejects.toThrow("owner-injected live qualification");
    expect(qualificationReads).toBe(0);
    for (const malformed of [
      { ...inspection, unexpected: () => true },
      { ...inspection, dependencies: { ...inspection.dependencies, ready: "yes" } },
    ]) {
      const refusal = await runWorker(
        {
          surface: "takoserver-worker",
          action: "status",
          environment: "integration",
          commit: COMMIT,
        },
        selected,
        {
          ...currentStatus,
          providerExecutorQualification: {
            read: async () => malformed as unknown as ProviderExecutorInspection,
          },
          migrations: {
            read: async () => {
              throw new Error("malformed CPE status must not read D1");
            },
          },
        },
      ).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(DeployError);
      expect((refusal as DeployError).phase).toBe("preflight");
      expect((refusal as Error).message).toContain("value-free inspection");
    }
    expect(currentStatus.calls).toEqual([]);
  });

  test("publishes the Host-only 0092 predecessor solely as a non-serving pre-0098 successor", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-worker-pre-v2-0098-"));
    try {
      const selected = {
        ...v2Target,
        takoformV2: {
          ...v2Target.takoformV2,
          storageLineage: "v2-0088" as const,
          appliedSchemaLineage: "v2-0092" as const,
        },
        schemaMaintenanceMode: "pre-v2-0098-quiesced" as const,
      };
      const exact = {
        applied: canonicalMigrations.slice(0, 92),
        shape: canonical0092Shape,
        shapeDigest: canonical0092ShapeDigest,
      };
      const current = fixture({
        selectedTarget: selected,
        applied: exact.applied,
        auditedShape: exact.shape,
      });
      let reads = 0;
      const result = await runWorker(
        {
          surface: "takoserver-worker",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        selected,
        {
          ...current,
          outputDirectory: root,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "test-token" },
          integrationStorageVerification: integrationStorageVerificationOptions(selected, {
            readState: async () => {
              reads++;
              return exact;
            },
          }),
          fetcher: async () =>
            Response.json(
              {
                error: {
                  code: "backend_unavailable",
                  message: "Host is quiesced for the v2 0098 schema maintenance transition",
                  details: { reason: "runtime-configuration" },
                },
              },
              { status: 503, headers: { "cache-control": "no-store", "retry-after": "60" } },
            ),
        },
      );
      expect(result).toMatchObject({
        kind: "takoserver.worker-apply@v2",
        maintenance: "pre-v2-0098-quiesced",
        probe: { status: 503, traffic: "maintenance" },
      });
      expect(reads).toBe(3);
      expect(current.calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("real predecessor diff requires review for pre-0098 Host publication and lost-ACK status never reuploads", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-pre98-reviewed-diff-"));
    const git = (...args: string[]): string => {
      const result = spawnSync("git", ["-C", root, ...args], {
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Portable Test",
          GIT_AUTHOR_EMAIL: "portable@example.test",
          GIT_COMMITTER_NAME: "Portable Test",
          GIT_COMMITTER_EMAIL: "portable@example.test",
        },
      });
      if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
      return result.stdout;
    };
    try {
      mkdirSync(join(root, "src"));
      mkdirSync(join(root, "scripts/deploy"), { recursive: true });
      git("init", "-q");
      writeFileSync(join(root, "src/entry-worker.ts"), "export const mode = 'serving';\n");
      writeFileSync(join(root, "scripts/deploy/worker.ts"), "export const fence = 'old';\n");
      git("add", ".");
      git("-c", "commit.gpgsign=false", "commit", "-qm", "predecessor");
      const predecessor = git("rev-parse", "HEAD").trim();
      writeFileSync(
        join(root, "src/entry-worker.ts"),
        "export const mode = 'pre-v2-0098-quiesced';\n",
      );
      writeFileSync(join(root, "scripts/deploy/worker.ts"), "export const fence = 'reviewed';\n");
      git("add", ".");
      git("-c", "commit.gpgsign=false", "commit", "-qm", "selected");
      const selectedCommit = git("rev-parse", "HEAD").trim();
      const realDiff = git("diff", "--name-only", `${predecessor}..${selectedCommit}`, "--");
      expect(realDiff.trim().split("\n")).toEqual([
        "scripts/deploy/worker.ts",
        "src/entry-worker.ts",
      ]);
      const selected = {
        ...v2Target,
        takoformV2: {
          ...v2Target.takoformV2,
          storageLineage: "v2-0088" as const,
          appliedSchemaLineage: "v2-0092" as const,
        },
        schemaMaintenanceMode: "pre-v2-0098-quiesced" as const,
      };
      const exact = {
        applied: canonicalMigrations.slice(0, 92),
        shape: canonical0092Shape,
        shapeDigest: canonical0092ShapeDigest,
      };
      const maintenanceFetcher = async () =>
        Response.json(
          {
            error: {
              code: "backend_unavailable",
              message: "Host is quiesced for the v2 0098 schema maintenance transition",
              details: { reason: "runtime-configuration" },
            },
          },
          { status: 503, headers: { "cache-control": "no-store", "retry-after": "60" } },
        );
      const withRealDiff =
        (base: ReturnType<typeof fixture>): WorkerProcess =>
        async (command, options) =>
          command[0] === "git" && command[1] === "diff"
            ? { exitCode: 0, stdout: realDiff, stderr: "" }
            : base.run(command, options);
      const invocation = {
        surface: "takoserver-worker" as const,
        action: "apply" as const,
        environment: "integration" as const,
        commit: COMMIT,
      };
      const baseOptions = (current: ReturnType<typeof fixture>) => ({
        ...current,
        run: withRealDiff(current),
        outputDirectory: root,
        cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "test-token" },
        integrationStorageVerification: integrationStorageVerificationOptions(selected, {
          readState: async () => exact,
        }),
        fetcher: maintenanceFetcher,
      });
      const absentReviewer = fixture({
        selectedTarget: selected,
        applied: exact.applied,
        auditedShape: exact.shape,
      });
      await expect(
        runWorker(invocation, selected, { ...baseOptions(absentReviewer), review: "" }),
      ).rejects.toThrow("INDEPENDENT_REVIEW");
      expect(absentReviewer.calls.some((command) => command.join(" ") === "bun run check")).toBe(
        false,
      );
      expect(absentReviewer.calls.filter((command) => command.includes("upload"))).toHaveLength(0);
      const reviewed = fixture({
        selectedTarget: selected,
        applied: exact.applied,
        auditedShape: exact.shape,
      });
      const applied = await runWorker(invocation, selected, {
        ...baseOptions(reviewed),
        review: "independent@example.test",
      });
      expect(applied).toMatchObject({
        reviewer: "independent@example.test",
        changedPaths: ["scripts/deploy/worker.ts", "src/entry-worker.ts"],
        authorityPaths: ["scripts/deploy/worker.ts", "src/entry-worker.ts"],
        maintenance: "pre-v2-0098-quiesced",
      });
      expect(
        reviewed.calls.filter(
          (command) => command.includes("upload") && !command.includes("--dry-run"),
        ),
      ).toHaveLength(1);
      const lostAck = fixture({
        selectedTarget: selected,
        applied: exact.applied,
        auditedShape: exact.shape,
        loseVersionDeployAcknowledgment: true,
      });
      await expect(
        runWorker(invocation, selected, {
          ...baseOptions(lostAck),
          review: "independent@example.test",
        }),
      ).rejects.toThrow("acknowledgement is indeterminate");
      const nativeBindings = versionForTarget(
        VERSION_AFTER,
        `takoserver-worker:${COMMIT}:${createHash("sha256").update(BUNDLE).digest("hex")}`,
        selected,
      ).resources.bindings;
      let d1Reads = 0;
      const status = await runWorker({ ...invocation, action: "status" }, selected, {
        ...baseOptions(lostAck),
        state: {
          ...lostAck.state,
          async workerVersionWithModules(_worker, versionId) {
            return {
              id: versionId,
              main_module: "worker.js",
              modules: [
                {
                  name: "worker.js",
                  content_type: "application/javascript+module",
                  content_base64: Buffer.from(BUNDLE).toString("base64"),
                },
              ],
              compatibility_date: "2026-08-17",
              compatibility_flags: ["nodejs_compat"],
            };
          },
          async workerSettings() {
            return {
              bindings: nativeBindings,
              observability: SELECTED_NATIVE_CONFIG.observability,
            };
          },
          async workerSchedules() {
            return SELECTED_NATIVE_CONFIG.triggers.crons;
          },
          async workerRoutes() {
            return [];
          },
          async workerSubdomain() {
            return { enabled: false, previewsEnabled: false };
          },
        },
        migrations: {
          read: async () => {
            d1Reads++;
            throw new Error("status must not read D1");
          },
        },
        integrationStorageVerification: integrationStorageVerificationOptions(selected, {
          readState: async () => {
            d1Reads++;
            throw new Error("status must not read D1");
          },
        }),
      });
      expect(status).toMatchObject({
        maintenance: "pre-v2-0098-quiesced",
        schemaUnproven: true,
        ready: false,
      });
      expect(d1Reads).toBe(0);
      expect(
        lostAck.calls.filter(
          (command) => command.includes("upload") && !command.includes("--dry-run"),
        ),
      ).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("publishes one pre-0098 Host maintenance successor with an exact injected CPE native proof", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-worker-pre-v2-0098-cpe-"));
    try {
      const selected = {
        ...v2Target,
        takoformV2: {
          ...v2Target.takoformV2,
          storageLineage: "v2-0088" as const,
          appliedSchemaLineage: "v2-0092" as const,
        },
        schemaMaintenanceMode: "pre-v2-0098-quiesced" as const,
        cloudflareProviderExecutor: executorTarget.cloudflareProviderExecutor,
      };
      const exact = {
        applied: canonicalMigrations.slice(0, 92),
        shape: canonical0092Shape,
        shapeDigest: canonical0092ShapeDigest,
      };
      const base = providerExecutorInspection(false);
      const inspection = {
        ...base,
        schemaReady: false,
        maintenance: {
          mode: "pre-v2-0098-quiesced",
          storageLineage: "v2-0088",
          appliedSchemaLineage: "v2-0092",
          accountId: selected.accountId,
          databaseId: selected.d1.databaseId,
          databaseName: selected.d1.databaseName,
          workerName: selected.cloudflareProviderExecutor.workerName,
          activeVersionId: base.versionId ?? "",
          activeDeploymentId: base.deploymentId ?? "",
          previousVersionId: base.previousVersionId ?? "",
          selectedSourceCommit: base.commit ?? "",
          selectedModuleDigestHex: base.moduleDigestHex ?? "",
          observedNonCodeDigestHex: "7".repeat(64),
        },
      } satisfies ProviderExecutorInspection;
      const current = fixture({
        selectedTarget: selected,
        applied: exact.applied,
        auditedShape: exact.shape,
      });
      let qualificationReads = 0;
      const maintenanceFetcher = async () =>
        Response.json(
          {
            error: {
              code: "backend_unavailable",
              message: "Host is quiesced for the v2 0098 schema maintenance transition",
              details: { reason: "runtime-configuration" },
            },
          },
          { status: 503, headers: { "cache-control": "no-store", "retry-after": "60" } },
        );
      const result = await runWorker(
        {
          surface: "takoserver-worker",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        selected,
        {
          ...current,
          outputDirectory: root,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "test-token" },
          providerExecutorQualification: {
            read: async () => {
              qualificationReads++;
              return inspection;
            },
          },
          integrationStorageVerification: integrationStorageVerificationOptions(selected, {
            readState: async () => exact,
          }),
          fetcher: maintenanceFetcher,
        },
      );
      expect(result).toMatchObject({
        kind: "takoserver.worker-apply@v2",
        maintenance: "pre-v2-0098-quiesced",
        cloudflareProviderExecutor: { required: true, ready: false },
        probe: { status: 503, traffic: "maintenance" },
      });
      expect(qualificationReads).toBeGreaterThanOrEqual(3);
      expect(current.calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(1);
      // No publication receipt is supplied to status: this is the lost-ACK recovery read.
      const nativeBindings = versionForTarget(
        VERSION_AFTER,
        `takoserver-worker:${COMMIT}:${createHash("sha256").update(BUNDLE).digest("hex")}`,
        selected,
      ).resources.bindings;
      const nativeState = {
        ...current.state,
        async workerVersionWithModules(_worker: string, versionId: string) {
          return {
            id: versionId,
            main_module: "worker.js",
            modules: [
              {
                name: "worker.js",
                content_type: "application/javascript+module",
                content_base64: Buffer.from(BUNDLE).toString("base64"),
              },
            ],
            compatibility_date: "2026-08-17",
            compatibility_flags: ["nodejs_compat"],
          };
        },
        async workerSettings() {
          return { bindings: nativeBindings, observability: SELECTED_NATIVE_CONFIG.observability };
        },
        async workerSchedules() {
          return SELECTED_NATIVE_CONFIG.triggers.crons;
        },
        async workerRoutes() {
          return [];
        },
        async workerSubdomain() {
          return { enabled: false, previewsEnabled: false };
        },
      };
      const statusInvocation = {
        surface: "takoserver-worker" as const,
        action: "status" as const,
        environment: "integration" as const,
        commit: COMMIT,
      };
      const statusOptions = {
        ...current,
        state: nativeState,
        providerExecutorQualification: { read: async () => inspection },
        migrations: {
          read: async () => {
            throw new Error("lost-ACK status must not read partial D1");
          },
        },
        integrationStorageVerification: integrationStorageVerificationOptions(selected, {
          readState: async () => {
            throw new Error("lost-ACK status must not read generated D1");
          },
        }),
        fetcher: maintenanceFetcher,
      };
      const status = await runWorker(statusInvocation, selected, statusOptions);
      expect(status).toMatchObject({
        maintenance: "pre-v2-0098-quiesced",
        nativeNonServing: true,
        cloudflareProviderExecutorNativeNonServing: true,
        schemaUnproven: true,
        schemaReady: false,
        ready: false,
        versionId: VERSION_AFTER,
        cloudflareProviderExecutor: { required: true, ready: false, status: "stale" },
      });
      expect(current.calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(1);
      for (const changed of [
        { ...inspection, managedExact: false },
        { ...inspection, status: "drift" as const },
        { ...inspection, maintenance: { ...inspection.maintenance, selectedSourceCommit: COMMIT } },
        {
          ...inspection,
          maintenance: { ...inspection.maintenance, activeVersionId: VERSION_BEFORE },
        },
      ]) {
        await expect(
          runWorker(statusInvocation, selected, {
            ...statusOptions,
            providerExecutorQualification: { read: async () => changed },
          }),
        ).rejects.toThrow("provider executor");
      }
      let statusProofReads = 0;
      await expect(
        runWorker(statusInvocation, selected, {
          ...statusOptions,
          providerExecutorQualification: {
            read: async () => {
              statusProofReads++;
              return statusProofReads === 1
                ? inspection
                : {
                    ...inspection,
                    maintenance: {
                      ...inspection.maintenance,
                      observedNonCodeDigestHex: "f".repeat(64),
                    },
                  };
            },
          },
        }),
      ).rejects.toThrow("qualification changed");
      expect(statusProofReads).toBe(2);
      const sameObjectProof = structuredClone(inspection);
      let sameObjectReads = 0;
      await expect(
        runWorker(statusInvocation, selected, {
          ...statusOptions,
          providerExecutorQualification: {
            read: async () => {
              sameObjectReads++;
              return sameObjectProof;
            },
          },
          fetcher: async () => {
            Object.assign(sameObjectProof.maintenance, {
              observedNonCodeDigestHex: "f".repeat(64),
            });
            Object.assign(sameObjectProof.dependencies, {
              receiptAuthorityVersionId: VERSION_BEFORE,
            });
            return await maintenanceFetcher();
          },
        }),
      ).rejects.toThrow("qualification changed");
      expect(sameObjectReads).toBe(2);
      expect(current.calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(1);
      await expect(
        runWorker(
          {
            surface: "takoserver-worker",
            action: "apply",
            environment: "integration",
            commit: COMMIT,
            reverse: true,
          },
          selected,
          {
            ...current,
            cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "test-token" },
            providerExecutorQualification: { read: async () => inspection },
            integrationStorageVerification: integrationStorageVerificationOptions(selected, {
              readState: async () => exact,
            }),
          },
        ),
      ).rejects.toThrow("pre-0098 CPE proof permits only routine Host maintenance publication");
      await expect(
        runWorker(
          {
            surface: "takoserver-worker-authority-cutover",
            action: "apply",
            environment: "integration",
            commit: COMMIT,
          },
          selected,
          {
            ...current,
            cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "test-token" },
          },
        ),
      ).rejects.toThrow("pre-0098 CPE proof permits only routine Host maintenance publication");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("pre-0098 CPE apply refuses a reused proof object mutated before or after publication", async () => {
    const selected = {
      ...v2Target,
      takoformV2: {
        ...v2Target.takoformV2,
        storageLineage: "v2-0088" as const,
        appliedSchemaLineage: "v2-0092" as const,
      },
      schemaMaintenanceMode: "pre-v2-0098-quiesced" as const,
      cloudflareProviderExecutor: executorTarget.cloudflareProviderExecutor,
    };
    const exact = {
      applied: canonicalMigrations.slice(0, 92),
      shape: canonical0092Shape,
      shapeDigest: canonical0092ShapeDigest,
    };
    const base = providerExecutorInspection(false);
    const proven = {
      ...base,
      schemaReady: false,
      maintenance: {
        mode: "pre-v2-0098-quiesced" as const,
        storageLineage: "v2-0088" as const,
        appliedSchemaLineage: "v2-0092" as const,
        accountId: selected.accountId,
        databaseId: selected.d1.databaseId,
        databaseName: selected.d1.databaseName,
        workerName: selected.cloudflareProviderExecutor.workerName,
        activeVersionId: base.versionId ?? "",
        activeDeploymentId: base.deploymentId ?? "",
        previousVersionId: base.previousVersionId ?? "",
        selectedSourceCommit: base.commit ?? "",
        selectedModuleDigestHex: base.moduleDigestHex ?? "",
        observedNonCodeDigestHex: "7".repeat(64),
      },
    } satisfies ProviderExecutorInspection;
    for (const stage of [
      "before-upload",
      "after-version-upload",
      "after-deployment",
      "malformed-after-deployment",
    ] as const) {
      const root = mkdtempSync(join(tmpdir(), `takoserver-cpe-${stage}-`));
      try {
        const current = fixture({
          selectedTarget: selected,
          applied: exact.applied,
          auditedShape: exact.shape,
        });
        const mutableProof = structuredClone(proven);
        let proofReads = 0;
        const result = await runWorker(
          {
            surface: "takoserver-worker",
            action: "apply",
            environment: "integration",
            commit: COMMIT,
          },
          selected,
          {
            ...current,
            outputDirectory: root,
            cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "test-token" },
            run: async (command, options) => {
              const output = await current.run(command, options);
              if (
                (stage === "before-upload" && command.includes("--dry-run")) ||
                (stage === "after-version-upload" && command.includes("--no-bundle")) ||
                ((stage === "after-deployment" || stage === "malformed-after-deployment") &&
                  command.includes("versions") &&
                  command.includes("deploy"))
              ) {
                if (stage === "malformed-after-deployment") {
                  Object.assign(mutableProof, { unexpected: () => true });
                } else {
                  Object.assign(mutableProof.maintenance, {
                    observedNonCodeDigestHex: "f".repeat(64),
                  });
                  Object.assign(mutableProof.dependencies, {
                    receiptAuthorityVersionId: VERSION_BEFORE,
                  });
                }
              }
              return output;
            },
            providerExecutorQualification: {
              read: async () => {
                proofReads++;
                return mutableProof;
              },
            },
            integrationStorageVerification: integrationStorageVerificationOptions(selected, {
              readState: async () => exact,
            }),
            fetcher: async () =>
              Response.json(
                {
                  error: {
                    code: "backend_unavailable",
                    message: "Host is quiesced for the v2 0098 schema maintenance transition",
                    details: { reason: "runtime-configuration" },
                  },
                },
                { status: 503, headers: { "cache-control": "no-store", "retry-after": "60" } },
              ),
          },
        ).catch((error: unknown) => error);
        expect(result).toBeInstanceOf(DeployError);
        expect((result as DeployError).phase).toBe(
          stage === "before-upload"
            ? "preflight"
            : stage === "after-version-upload"
              ? "mutation"
              : "verification",
        );
        expect(proofReads).toBeGreaterThanOrEqual(2);
        expect(current.calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(
          stage === "before-upload" ? 0 : 1,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }, 20_000);
  test("0092 without billingConfig refuses before Worker upload and reports not ready", async () => {
    const current = fixture({ applied: canonicalMigrations.slice(0, 92) });
    const status = await runWorker(
      {
        surface: "takoserver-worker",
        action: "status",
        environment: "integration",
        commit: COMMIT,
      },
      target,
      current,
    );
    expect(status).toMatchObject({ ready: false, moneyUnitSchemaReady: false });
    const failure = await runWorker(
      { surface: "takoserver-worker", action: "apply", environment: "integration", commit: COMMIT },
      target,
      { ...current, cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "test-token" } },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DeployError);
    expect((failure as DeployError).phase).toBe("preflight");
    expect((failure as Error).message).toContain("0094_wallet_usd_micros.sql");
    expect(
      current.calls.some((call) => call.includes("upload") || call.includes("--no-bundle")),
    ).toBe(false);
  });

  test("current audited schema with corrupt shape or missing 0094 unit policy refuses before upload", async () => {
    for (const defect of ["shape", "policy"] as const) {
      const current = fixture();
      const canonical = await current.migrations.read();
      const migrations: WorkerMigrationReader = {
        read: async () =>
          defect === "shape"
            ? {
                ...canonical,
                shape: "[]",
                shapeDigest: `sha256:${createHash("sha256").update("[]").digest("hex")}`,
              }
            : { ...canonical, moneyUnitPolicy: [] },
      };
      const status = await runWorker(
        {
          surface: "takoserver-worker",
          action: "status",
          environment: "integration",
          commit: COMMIT,
        },
        target,
        { ...current, migrations },
      );
      expect(status).toMatchObject({ ready: false, moneyUnitSchemaReady: false });
      const failure = await runWorker(
        {
          surface: "takoserver-worker",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        target,
        { ...current, migrations, cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "test-token" } },
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect((failure as DeployError).phase).toBe("preflight");
      expect((failure as Error).message).toContain("exact complete audited D1 schema");
      expect(
        current.calls.some((call) => call.includes("upload") || call.includes("--no-bundle")),
      ).toBe(false);
    }
  });

  test("money-unit readiness accepts the exact current audited 0098 schema only", async () => {
    const current = await fixture().migrations.read();
    expect(canonicalMigrations.at(-1)).toBe("0098_stripe_mode_realm.sql");
    expect(workerMoneyUnitSchemaReady(current, process.cwd())).toBe(true);

    const cutoverIndex = canonicalMigrations.indexOf("0094_wallet_usd_micros.sql");
    const stripeIndex = canonicalMigrations.indexOf("0095_stripe_billing.sql");
    expect(cutoverIndex).toBeGreaterThanOrEqual(0);
    expect(stripeIndex).toBeGreaterThan(cutoverIndex);
    const cutoverOnlyShape = deriveExpectedApplicationShape(
      readMigrationArtifact().files.slice(0, stripeIndex),
    );
    const cutoverOnly = {
      ...current,
      applied: canonicalMigrations.slice(0, stripeIndex),
      shape: cutoverOnlyShape,
      shapeDigest: `sha256:${createHash("sha256").update(cutoverOnlyShape).digest("hex")}`,
    };
    expect(workerMoneyUnitSchemaReady(cutoverOnly, process.cwd())).toBe(false);
  });

  test("serving Worker refuses incomplete or foreign audited tails before upload", async () => {
    for (const applied of [
      canonicalMigrations.slice(0, -1),
      [...canonicalMigrations, "0099_foreign.sql"],
    ]) {
      const current = fixture({ applied });
      const status = await runWorker(
        {
          surface: "takoserver-worker",
          action: "status",
          environment: "integration",
          commit: COMMIT,
        },
        target,
        current,
      ).catch((error: unknown) => error);
      if (status instanceof DeployError) {
        expect(status.phase).toBe("preflight");
      } else {
        expect(status).toMatchObject({ ready: false, moneyUnitSchemaReady: false });
      }
      const failure = await runWorker(
        {
          surface: "takoserver-worker",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        target,
        { ...current, cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "test-token" } },
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect((failure as DeployError).phase).toBe("preflight");
      expect((failure as Error).message).toMatch(
        /exact complete audited D1 schema|more applied migrations/,
      );
      expect(
        current.calls.some((call) => call.includes("upload") || call.includes("--no-bundle")),
      ).toBe(false);
    }
  });

  test("serving Worker status reports a missing or mismatched selected-D1 Stripe realm as not ready", async () => {
    for (const stripeModePin of [null, "live"] as const) {
      const current = fixture({ stripeModePin });
      const status = await runWorker(
        {
          surface: "takoserver-worker",
          action: "status",
          environment: "integration",
          commit: COMMIT,
        },
        target,
        current,
      );
      expect(status).toMatchObject({
        ready: false,
        stripeModeRealm: {
          ready: false,
          selectedMode: "test",
          pinnedMode: stripeModePin,
          reason: stripeModePin === null ? "not_pinned" : "mode_mismatch",
        },
      });
    }
  });

  test("serving Worker apply refuses missing, mismatched, or mutable Stripe realm before gate and build", async () => {
    for (const defect of ["missing", "mismatch", "triggers"] as const) {
      const current = fixture({
        ...(defect === "missing" ? { stripeModePin: null } : {}),
        ...(defect === "mismatch" ? { stripeModePin: "live" } : {}),
        ...(defect === "triggers" ? { corruptStripeModeTriggers: true } : {}),
      });
      const failure = await runWorker(
        {
          surface: "takoserver-worker",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        target,
        current,
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect((failure as DeployError).phase).toBe("preflight");
      expect(current.calls.some((call) => call.join(" ") === "bun run check")).toBe(false);
      expect(current.calls.some((call) => call.includes("--dry-run"))).toBe(false);
      expect(current.calls.some((call) => call.includes("upload"))).toBe(false);
    }
  });

  test("serving Worker apply rechecks the selected D1 realm immediately before upload", async () => {
    const current = fixture({ selectedTarget: v2Target, changeStripeModeAfterBuild: "live" });
    const failure = await runWorker(
      {
        surface: "takoserver-worker",
        action: "apply",
        environment: "integration",
        commit: COMMIT,
      },
      v2Target,
      {
        ...current,
        cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "test-token" },
        integrationStorageVerification: integrationStorageVerificationOptions(v2Target),
      },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DeployError);
    expect((failure as DeployError).phase).toBe("preflight");
    expect((failure as Error).message).toContain("realm proof changed before Worker upload");
    expect(
      current.calls.some(
        (call) =>
          call.includes("--no-bundle") || (call.includes("upload") && !call.includes("--dry-run")),
      ),
    ).toBe(false);
  });
  test("v2 status remains read-only and cannot report ready without fixed 0075 proof", async () => {
    const current = fixture({ selectedTarget: v2Target });
    const failure = await runWorker(
      {
        surface: "takoserver-worker",
        action: "status",
        environment: "integration",
        commit: COMMIT,
      },
      v2Target,
      {
        ...current,
        cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "test-token" },
        integrationStorageVerification: {
          ...integrationStorageVerificationOptions(v2Target),
          reader: {
            read: async () => {
              const state = completeIntegrationStorageState();
              return { ...state, applied: state.applied.slice(0, -1) };
            },
          },
        },
      },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DeployError);
    expect((failure as DeployError).phase).toBe("preflight");
    expect(current.calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(0);
  });

  test.each([undefined, "v2-0092"] as const)(
    "v2-0088 lineage publishes after the full current schema without changing its origin claim (applied %s)",
    async (appliedSchemaLineage) => {
      const root = mkdtempSync(join(tmpdir(), "takoserver-worker-v2-storage-"));
      try {
        const selectedTarget = {
          ...v2Target,
          takoformV2: {
            ...v2Target.takoformV2,
            storageLineage: "v2-0088" as const,
            ...(appliedSchemaLineage === undefined ? {} : { appliedSchemaLineage }),
          },
        };
        const current = fixture({ selectedTarget });
        let reads = 0;
        let policyReads = 0;
        const run: WorkerProcess = async (command, options) => {
          const sql = command[command.indexOf("--command") + 1];
          if (
            command.includes("d1") &&
            command.includes("execute") &&
            sql ===
              "SELECT ledger_unit, historical_usage_unit, cash_unit FROM money_unit_policy WHERE singleton = 1"
          ) {
            const configPath = command[command.indexOf("--config") + 1];
            if (!configPath) throw new Error("policy read omitted the generated D1 config");
            const config = JSON.parse(readFileSync(configPath, "utf8")) as {
              account_id: string;
              d1_databases: Array<{
                binding: string;
                database_name: string;
                database_id: string;
                migrations_dir: string;
              }>;
            };
            expect(config.account_id).toBe(selectedTarget.accountId);
            expect(config.d1_databases).toEqual([
              {
                binding: "STATE_DB",
                database_name: selectedTarget.d1.databaseName,
                database_id: selectedTarget.d1.databaseId,
                migrations_dir: "payload/migrations",
              },
            ]);
            policyReads++;
            return ok(JSON.stringify([{ success: true, results: canonicalMoneyPolicy }]));
          }
          return await current.run(command, options);
        };
        const verification = integrationStorageVerificationOptions(selectedTarget);
        const result = await runWorker(
          {
            surface: "takoserver-worker",
            action: "apply",
            environment: "integration",
            commit: COMMIT,
          },
          selectedTarget,
          {
            ...current,
            run,
            outputDirectory: root,
            cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "test-token" },
            fetcher: publishedProductFetcher(),
            integrationStorageVerification: {
              ...verification,
              reader: {
                read: async () => {
                  reads++;
                  return {
                    applied: canonicalMigrations,
                    shape: canonicalMoneyShape,
                    shapeDigest: canonicalMoneyShapeDigest,
                  };
                },
              },
            },
          },
        );
        expect(result).toMatchObject({ kind: "takoserver.worker-apply@v2", commit: COMMIT });
        expect(reads).toBe(3);
        expect(policyReads).toBe(3);
        expect(current.calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    15_000,
  );

  test("fixed 0075 proof drift before upload refuses without provider mutation", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-worker-v2-drift-"));
    try {
      const current = fixture({ selectedTarget: v2Target });
      let reads = 0;
      const failure = await runWorker(
        {
          surface: "takoserver-worker",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        v2Target,
        {
          ...current,
          outputDirectory: root,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "test-token" },
          integrationStorageVerification: {
            ...integrationStorageVerificationOptions(v2Target),
            reader: {
              read: async () => {
                reads++;
                const state = completeIntegrationStorageState();
                return reads === 1 ? state : { ...state, applied: state.applied.slice(0, -1) };
              },
            },
          },
        },
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect((failure as DeployError).phase).toBe("preflight");
      expect(reads).toBe(2);
      expect(current.calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fixed 0075 proof loss after readback is verification-unknown, never a second upload", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-worker-v2-post-drift-"));
    try {
      const current = fixture({ selectedTarget: v2Target });
      let reads = 0;
      const failure = await runWorker(
        {
          surface: "takoserver-worker",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        v2Target,
        {
          ...current,
          outputDirectory: root,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "test-token" },
          integrationStorageVerification: {
            ...integrationStorageVerificationOptions(v2Target),
            reader: {
              read: async () => {
                reads++;
                const state = completeIntegrationStorageState();
                return reads < 3 ? state : { ...state, applied: state.applied.slice(0, -1) };
              },
            },
          },
        },
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect((failure as DeployError).phase).toBe("verification");
      expect(reads).toBe(3);
      expect(
        current.calls.filter(
          (call) =>
            call.includes("versions") && call.includes("upload") && !call.includes("--dry-run"),
        ),
      ).toHaveLength(1);
      expect(
        current.calls.filter((call) => call.includes("versions") && call.includes("deploy")),
      ).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("public Worker status and apply fail closed on an unready provider executor", async () => {
    const current = fixture({ selectedTarget: executorTarget });
    const qualification = {
      async read(): Promise<ProviderExecutorInspection> {
        return providerExecutorInspection(false);
      },
    };
    const status = await runWorker(
      {
        surface: "takoserver-worker",
        action: "status",
        environment: "integration",
        commit: COMMIT,
      },
      executorTarget,
      { ...current, providerExecutorQualification: qualification },
    );
    expect(status).toMatchObject({
      ready: false,
      cloudflareProviderExecutor: {
        required: true,
        ready: false,
        status: "stale",
        versionId: "00000000-0000-4000-8000-000000000099",
      },
    });

    const refusal = await runWorker(
      {
        surface: "takoserver-worker",
        action: "apply",
        environment: "integration",
        commit: COMMIT,
      },
      executorTarget,
      {
        ...current,
        providerExecutorQualification: qualification,
        cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "deploy-token" },
      },
    ).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(DeployError);
    expect((refusal as Error).message).toContain(
      "exact selected-commit Cloudflare provider executor",
    );
    expect(current.calls.some((call) => call.join(" ") === "bun run check")).toBe(false);
    expect(current.calls.some((call) => call.includes("--dry-run"))).toBe(false);
  });

  test("maintenance Worker status does not read the provider executor qualification", async () => {
    const current = fixture({
      selectedTarget: maintenanceExecutorTarget,
      local: ARTIFACT_BLOB_IO_COMPATIBILITY_PENDING,
      applied: [],
    });
    let reads = 0;
    const status = await runWorker(
      {
        surface: "takoserver-worker",
        action: "status",
        environment: "integration",
        commit: COMMIT,
      },
      maintenanceExecutorTarget,
      {
        ...current,
        providerExecutorQualification: {
          async read() {
            reads += 1;
            throw new Error("maintenance mode must not qualify the provider executor");
          },
        },
      },
    );
    expect(reads).toBe(0);
    expect(status).toMatchObject({
      ready: true,
      cloudflareProviderExecutor: { required: false },
      pendingMigrations: [...ARTIFACT_BLOB_IO_COMPATIBILITY_PENDING],
    });
  });

  test("maintenance Worker status refuses a lingering mode after migrations settle", async () => {
    const current = fixture({ selectedTarget: maintenanceExecutorTarget });
    const status = await runWorker(
      {
        surface: "takoserver-worker",
        action: "status",
        environment: "integration",
        commit: COMMIT,
      },
      maintenanceExecutorTarget,
      current,
    );
    expect(status).toMatchObject({
      ready: false,
      cloudflareProviderExecutor: { required: false },
      pendingMigrations: [],
    });
  });

  test("published product and OpenAPI stay bound to the exact target origin", async () => {
    const fetcher = publishedProductFetcher();
    await expect(probeProduct(target.publicOrigin, fetcher)).resolves.toMatchObject({
      url: `${target.publicOrigin}/.well-known/takoserver`,
      status: 200,
      openapi: { url: `${target.publicOrigin}/openapi.json`, status: 200 },
    });
    await expect(
      probeProduct(
        target.publicOrigin,
        publishedProductFetcher({ openApiOrigin: "https://api.example.test" }),
      ),
    ).rejects.toThrow("OpenAPI server");
    await expect(
      probeProduct(
        target.publicOrigin,
        publishedProductFetcher({ discoveryOrigin: "https://api.example.test" }),
      ),
    ).rejects.toThrow("wrong product or origin");
  });

  test("classifies authentication, authorization, and deploy-mechanism paths as authority", () => {
    expect(
      authoritySensitiveWorkerPaths([
        "src/auth.ts",
        "src/app.ts",
        "src/control.ts",
        "src/entry-cloudflare-worker.ts",
        "src/public-host-identity.ts",
        "src/takoform/admission.ts",
        "src/takoform/host-authority.ts",
        "scripts/deploy/worker.ts",
        "wrangler.jsonc",
        "src/catalog.ts",
      ]),
    ).toEqual([
      "scripts/deploy/worker.ts",
      "src/app.ts",
      "src/auth.ts",
      "src/control.ts",
      "src/entry-cloudflare-worker.ts",
      "src/public-host-identity.ts",
      "src/takoform/admission.ts",
      "src/takoform/host-authority.ts",
      "wrangler.jsonc",
    ]);
  });

  test("classifies money, customer secrets, and the durable store as authority", () => {
    // Every one of these published as *routine* before the implementation
    // closure existed: the prepaid ledger, its Stripe settlement, the sealed
    // runtime-input handoff, the AES-256-GCM key ring that seals it, and the
    // durable Takoform resource store every later decision is read back from.
    const authorities = [
      "src/ledger.ts",
      "src/runtime-input-preparations.ts",
      "src/runtime-input-seal-keyring.ts",
      "src/stripe-settlement.ts",
      "src/takoform/store.ts",
    ];
    expect(authoritySensitiveWorkerPaths(authorities)).toEqual(authorities);
  });

  test("derives the money, secret, and durable-store closure from the import graph", () => {
    // A new runtime dependency of any of the five roots classifies without
    // changing the classifier. This snapshot makes each authority-closure
    // expansion visible, including v2 custody reached through the key ring.
    expect(authorityImplementationClosure()).toEqual([
      "src/json.ts",
      "src/ledger.ts",
      "src/money.ts",
      "src/ports.ts",
      "src/provider-runtime-input-port.ts",
      "src/resource-execution-evidence.ts",
      "src/runtime-input-preparations.ts",
      "src/runtime-input-seal-keyring.ts",
      "src/stripe-settlement.ts",
      "src/takoform-v2/private-inputs.ts",
      "src/takoform/accepted-authority.ts",
      "src/takoform/apply-selection.ts",
      "src/takoform/dependency-fence.ts",
      "src/takoform/import-selection.ts",
      "src/takoform/limits.ts",
      "src/takoform/space-id.ts",
      "src/takoform/store.ts",
      "src/takoform/types.ts",
      "src/workflow-resource-lifecycle.ts",
    ]);
    const previouslyClassified = new Set(publicFormIdentityAuthorityPaths());
    expect(
      authorityImplementationClosure().filter((path) => !previouslyClassified.has(path)),
    ).toEqual([
      "src/ledger.ts",
      "src/resource-execution-evidence.ts",
      "src/runtime-input-preparations.ts",
      "src/runtime-input-seal-keyring.ts",
      "src/stripe-settlement.ts",
      "src/takoform-v2/private-inputs.ts",
      "src/takoform/store.ts",
    ]);
  });

  test("every classified authority path still exists in the tree", () => {
    // The classifier is exact paths and a resolved import graph rather than a
    // pattern, so a renamed authority refuses instead of quietly falling out of
    // a regex and publishing as routine.
    for (const path of [
      ...declaredAuthorityModulePaths(),
      ...authorityImplementationClosure(),
      ...publicFormIdentityAuthorityPaths(),
    ]) {
      expect(existsSync(join(import.meta.dir, "..", path))).toBe(true);
    }
  });

  test("keeps the routine lane open: rendering, catalog, and metering stay routine", () => {
    // The walk is not seeded from a composition root. `entry-worker.ts` reaches
    // 140 of the 182 modules under `src` and `app.ts` reaches 73, so seeding
    // there would classify almost the product and leave no routine lane at all.
    expect(
      authoritySensitiveWorkerPaths([
        "src/catalog.ts",
        "src/openapi.ts",
        "src/landing.ts",
        "src/metering.ts",
        "README.md",
      ]),
    ).toEqual([]);
    for (const reachedOnlyThroughAComposition of [
      "src/openapi.ts",
      "src/landing.ts",
      "src/catalog.ts",
    ]) {
      expect(authorityImplementationClosure()).not.toContain(reachedOnlyThroughAComposition);
    }
  });

  test("classifies every executable public Form P/I owner as authority", () => {
    // Managed backend construction lives in the route-less executor. Its WfP
    // implementation is no longer part of the public Form runtime payload.
    const expected = [
      "src/entry-public-form-runtime-payload.ts",
      "src/error-envelope.ts",
      "src/form-ref.ts",
      "src/generated/takoform-forward-candidate-catalog.ts",
      "src/generated/takoform-stable-error-taxonomy.ts",
      "src/generated/takoform-stable-v1-catalog.ts",
      "src/json.ts",
      "src/money.ts",
      "src/ports.ts",
      "src/provider-driver.ts",
      "src/provider-placement.ts",
      "src/provider-port.ts",
      "src/provider-runtime-bindings.ts",
      "src/provider-runtime-input-port.ts",
      "src/provider-worker-endpoint-origin.ts",
      "src/providers/cloudflare-readback-descriptor.ts",
      "src/providers/cloudflare-runtime-bindings.ts",
      "src/providers/cloudflare.ts",
      "src/providers/sqlite-migration-policy.ts",
      "src/public-form-implementation-build.ts",
      "src/public-form-runtime.ts",
      "src/public-worker-implementation.ts",
      "src/standard-service-port.ts",
      "src/strict-json.ts",
      "src/takoform/accepted-authority.ts",
      "src/takoform/apply-selection.ts",
      "src/takoform/bindings.ts",
      "src/takoform/current-candidates.ts",
      "src/takoform/dependency-fence.ts",
      "src/takoform/edge-family.ts",
      "src/takoform/edge-semantics.ts",
      "src/takoform/engine.ts",
      "src/takoform/forms.ts",
      "src/takoform/forward-candidates.ts",
      "src/takoform/implementation-catalog.ts",
      "src/takoform/import-selection.ts",
      "src/takoform/limits.ts",
      "src/takoform/receipt-projection.ts",
      "src/takoform/relations.ts",
      "src/takoform/schema.ts",
      "src/takoform/space-id.ts",
      "src/takoform/sqlite-migrations.ts",
      "src/takoform/standard-services.ts",
      "src/takoform/types.ts",
      "src/takoform/wire.ts",
      "src/takoform/worker-aggregate.ts",
      "src/takoform/worker-runtime-contract.ts",
      "src/worker-endpoint-origin-reservations.ts",
      "src/workflow-resource-lifecycle.ts",
    ];
    expect(publicFormIdentityAuthorityPaths()).toEqual(expected);
    expect(authoritySensitiveWorkerPaths([...expected, "src/catalog.ts"])).toEqual(expected);
  });

  test("routine cannot publish public Form-authority fences without the reviewed cutover", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-worker-public-authority-"));
    try {
      const current = fixture({
        diff: [
          "src/entry-cloudflare-worker.ts",
          "src/public-host-identity.ts",
          "src/takoform/host-authority.ts",
        ].join("\n"),
      });
      const failure = await runWorker(
        {
          surface: "takoserver-worker",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        target,
        {
          ...current,
          outputDirectory: root,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      ).catch((error) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect(failure.message).toContain("takoserver-worker-authority-cutover");
      expect(current.calls.some((call) => call.join(" ") === "bun run check")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("integration Worker dispatch resolves OAuth without exposing it to Wrangler", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-worker-oauth-"));
    try {
      const current = fixture({ selectedTarget: v2Target });
      const oauthToken = "worker-oauth-token-only-in-process";
      const calls: {
        readonly command: readonly string[];
        readonly env: Readonly<Record<string, string>>;
      }[] = [];
      const run: WorkerProcess = async (command, options) => {
        calls.push({ command: [...command], env: options?.env ?? {} });
        if (command.slice(-3).join(" ") === "auth token --json") {
          return ok(JSON.stringify({ type: "oauth", token: oauthToken }));
        }
        return await current.run(command, options);
      };
      const result = await runWorker(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        v2Target,
        {
          state: current.state,
          migrations: current.migrations,
          stripeModeRealm: current.stripeModeRealm,
          run,
          outputDirectory: root,
          cloudflareEnvironment: {},
          review: "reviewer@example.test",
          fetcher: publishedProductFetcher(),
          integrationStorageVerification: integrationStorageVerificationOptions(v2Target),
        },
      );
      expect(result).toMatchObject({ kind: "takoserver.worker-apply@v2", commit: COMMIT });
      const wranglerCalls = calls.filter((entry) => entry.command[0]?.endsWith("/wrangler"));
      expect(wranglerCalls.length).toBeGreaterThan(0);
      expect(wranglerCalls.every(({ env }) => env.CLOUDFLARE_API_TOKEN === undefined)).toBe(true);
      expect(
        calls.find(({ command }) => command.slice(-3).join(" ") === "auth token --json")?.env,
      ).toEqual({ WRANGLER_WRITE_LOGS: "false" });
      expect(JSON.stringify(wranglerCalls)).not.toContain(oauthToken);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("integration Worker apply resolves the OAuth bearer again after the owner gate", async () => {
    // The complete owner gate can outlive a Wrangler OAuth access token.
    const root = mkdtempSync(join(tmpdir(), "takoserver-worker-oauth-refresh-"));
    try {
      const current = fixture({ selectedTarget: v2Target });
      const events: string[] = [];
      const oauth = expiringOAuth(events);
      const run: WorkerProcess = async (command, options) => {
        const token = oauth.answer(command);
        if (token !== undefined) return token;
        const completed = await current.run(command, options);
        oauth.afterCommand(command);
        return completed;
      };
      const result = await withCloudflareApi(current.state, oauth.live, events, () =>
        runWorker(
          {
            surface: "takoserver-worker-authority-cutover",
            action: "apply",
            environment: "integration",
            commit: COMMIT,
          },
          v2Target,
          {
            migrations: current.migrations,
            stripeModeRealm: current.stripeModeRealm,
            run,
            outputDirectory: root,
            cloudflareEnvironment: {},
            review: "reviewer@example.test",
            fetcher: publishedProductFetcher(),
            integrationStorageVerification: integrationStorageVerificationOptions(v2Target),
          },
        ).catch((error: unknown) => error),
      );
      expect(timeline(events)).toEqual([
        "token:oauth-access-1",
        "GET:Bearer oauth-access-1",
        "gate",
        "token:oauth-access-2",
        "GET:Bearer oauth-access-2",
      ]);
      expect(result).toMatchObject({ kind: "takoserver.worker-apply@v2", commit: COMMIT });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rehearsal Worker injected state cannot bypass the explicit token lane", async () => {
    const current = fixture();
    const failure = await runWorker(
      { surface: "takoserver-worker", action: "status", environment: "rehearsal", commit: COMMIT },
      { ...target, environment: "rehearsal" },
      {
        state: current.state,
        migrations: current.migrations,
        run: current.run,
        cloudflareEnvironment: {},
      },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("CLOUDFLARE_API_TOKEN is required");
    expect(current.calls).toHaveLength(0);
  });

  test("routine refuses a pre-0094 D1 before its gate or upload", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-worker-pending-"));
    try {
      const current = fixture({
        local: [
          "0048_resource_execution_evidence.sql",
          "0049_artifact_consumer_active_resolution.sql",
        ],
        applied: ["0048_resource_execution_evidence.sql"],
      });
      const failure = await runWorker(
        {
          surface: "takoserver-worker",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        target,
        {
          ...current,
          outputDirectory: root,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      ).catch((error) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect(failure.message).toContain("0094_wallet_usd_micros.sql");
      expect(current.calls.some((call) => call.join(" ") === "bun run check")).toBe(false);
      expect(current.calls.some((call) => call.includes("--no-bundle"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("0058 maintenance admits only exact source 0057 predecessor with 0058 next, never readiness", async () => {
    const canonical = { local: canonicalMigrations, applied: exact0057 };
    expect(workerSchemaAllowsPending(schemaMaintenanceTarget, canonical)).toBe(true);
    expect(workerSchemaAllowsPending(target, canonical)).toBe(false);
    for (const invalid of [
      { local: canonicalMigrations, applied: exact0057.slice(0, -1) },
      { local: canonicalMigrations, applied: canonicalMigrations.slice(0, 58) },
      { local: canonicalMigrations, applied: [...exact0057.slice(0, -1), "0057_foreign.sql"] },
      { local: [...canonicalMigrations.slice(0, 57), "0058_foreign.sql"], applied: exact0057 },
    ])
      expect(workerSchemaAllowsPending(schemaMaintenanceTarget, invalid)).toBe(false);
    const current = fixture({
      selectedTarget: schemaMaintenanceTarget,
      local: canonicalMigrations,
      applied: exact0057,
    });
    const status = await runWorker(
      {
        surface: "takoserver-worker",
        action: "status",
        environment: "integration",
        commit: COMMIT,
      },
      schemaMaintenanceTarget,
      { ...current, cloudflareEnvironment: {} },
    );
    expect(status).toMatchObject({
      maintenance: "pre-0058-quiesced",
      ready: false,
      pendingMigrations: canonicalMigrations.slice(57),
    });
  });

  test("v2 0088 maintenance admits only canonical audited 0066 through 0088 prefixes", () => {
    const selected = { ...v2Target, schemaMaintenanceMode: "pre-v2-0088-quiesced" as const };
    const files = readMigrationArtifact().files;
    const at = (count: number) => {
      const shape = deriveExpectedApplicationShape(files.slice(0, count));
      return {
        local: canonicalMigrations,
        applied: canonicalMigrations.slice(0, count),
        shape,
        shapeDigest: `sha256:${createHash("sha256").update(shape).digest("hex")}`,
      };
    };
    for (const count of [66, 67, 69, 75, 86, 87, 88]) {
      expect(workerSchemaAllowsPending(selected, at(count))).toBe(true);
    }
    expect(workerSchemaAllowsPending(selected, at(65))).toBe(false);
    expect(workerSchemaAllowsPending(selected, { ...at(75), shape: "[]" })).toBe(false);
    expect(
      workerSchemaAllowsPending(selected, {
        ...at(75),
        applied: [...canonicalMigrations.slice(0, 74), "0075_foreign.sql"],
      }),
    ).toBe(false);
    expect(
      workerSchemaAllowsPending(selected, {
        ...at(75),
        local: [...canonicalMigrations.slice(0, 87), "0088_foreign.sql"],
      }),
    ).toBe(false);
  }, 20_000);

  test("fresh and canonical 0088/0089/0091/0092 lineages require the full audited schema for serving", () => {
    const at = (count: number) => ({
      local: canonicalMigrations,
      applied: canonicalMigrations.slice(0, count),
    });
    const lineage0088 = {
      ...v2Target,
      takoformV2: { ...v2Target.takoformV2, storageLineage: "v2-0088" as const },
    };
    const lineage0089 = {
      ...v2Target,
      takoformV2: { ...v2Target.takoformV2, storageLineage: "v2-0089" as const },
    };
    expect(workerSchemaAllowsPending(lineage0088, at(88))).toBe(false);
    expect(workerSchemaAllowsPending(lineage0089, at(89))).toBe(false);
    for (const count of [66, 75, 87, 89]) {
      expect(workerSchemaAllowsPending(lineage0088, at(count))).toBe(false);
    }
    expect(workerSchemaAllowsPending(lineage0088, at(canonicalMigrations.length))).toBe(true);
    expect(workerSchemaAllowsPending(lineage0089, at(88))).toBe(false);
    const lineage0091 = {
      ...v2Target,
      takoformV2: { ...v2Target.takoformV2, storageLineage: "v2-0091" as const },
    };
    expect(workerSchemaAllowsPending(lineage0091, at(91))).toBe(false);
    for (const count of [88, 89, 90, 92]) {
      expect(workerSchemaAllowsPending(lineage0091, at(count))).toBe(false);
    }
    const lineage0092 = {
      ...v2Target,
      takoformV2: { ...v2Target.takoformV2, storageLineage: "v2-0092" as const },
    };
    expect(workerSchemaAllowsPending(lineage0092, at(92))).toBe(false);
    for (const count of [88, 89, 91]) {
      expect(workerSchemaAllowsPending(lineage0092, at(count))).toBe(false);
    }
    const applied0092 = {
      ...lineage0088,
      takoformV2: { ...lineage0088.takoformV2, appliedSchemaLineage: "v2-0092" as const },
    };
    const exact0092 = {
      ...at(92),
      shape: deriveExpectedApplicationShape(readMigrationArtifact().files.slice(0, 92)),
    };
    expect(workerSchemaAllowsPending(applied0092, exact0092)).toBe(false);
    expect(workerSchemaAllowsPending(lineage0088, exact0092)).toBe(false);
    for (const selected of [lineage0088, lineage0089, lineage0091, lineage0092, applied0092]) {
      expect(workerSchemaAllowsPending(selected, at(canonicalMigrations.length))).toBe(true);
    }
    expect(
      workerSchemaAllowsPending(lineage0088, {
        ...at(88),
        applied: [...canonicalMigrations.slice(0, 87), "0088_foreign.sql"],
      }),
    ).toBe(false);
    expect(
      workerSchemaAllowsPending(lineage0088, {
        ...at(88),
        local: [...canonicalMigrations.slice(0, 89), "0090_foreign.sql"],
      }),
    ).toBe(false);
    // Without an explicit lineage the historical rule still refuses any pending tail.
    expect(workerSchemaAllowsPending(v2Target, at(88))).toBe(false);
  });

  test("v2 0088 maintenance probe requires the distinct current-mode response", async () => {
    const response = Response.json(
      {
        error: {
          code: "backend_unavailable",
          message: "Host is quiesced for the v2 0088 schema maintenance transition",
          details: { reason: "runtime-configuration" },
        },
      },
      { status: 503, headers: { "cache-control": "no-store", "retry-after": "60" } },
    );
    expect(
      await probeSchemaMaintenance(
        target.publicOrigin,
        async () => response.clone(),
        "pre-v2-0088-quiesced",
      ),
    ).toMatchObject({ status: 503, traffic: "maintenance" });
    await expect(
      probeSchemaMaintenance(target.publicOrigin, async () => response.clone()),
    ).rejects.toThrow("maintenance refusal");
  });

  test("pre-v2-0098 probe accepts only its distinct 503 maintenance envelope", async () => {
    const response = Response.json(
      {
        error: {
          code: "backend_unavailable",
          message: "Host is quiesced for the v2 0098 schema maintenance transition",
          details: { reason: "runtime-configuration" },
        },
      },
      { status: 503, headers: { "cache-control": "no-store", "retry-after": "60" } },
    );
    expect(
      await probeSchemaMaintenance(
        target.publicOrigin,
        async () => response.clone(),
        "pre-v2-0098-quiesced",
      ),
    ).toMatchObject({ status: 503, traffic: "maintenance" });
    await expect(
      probeSchemaMaintenance(target.publicOrigin, async () => response.clone()),
    ).rejects.toThrow("maintenance refusal");
  });

  test("v2 maintenance executor proof binds the exact target and cannot qualify ordinary publication", () => {
    const selected = {
      ...v2Target,
      cloudflareProviderExecutor: executorTarget.cloudflareProviderExecutor,
      schemaMaintenanceMode: "pre-v2-0088-quiesced" as const,
    };
    const ordinary = providerExecutorInspection(true);
    const inactive = {
      ...ordinary,
      ready: false,
      schemaReady: false,
      maintenance: {
        mode: "pre-v2-0088-quiesced" as const,
        accountId: selected.accountId,
        databaseId: selected.d1.databaseId,
        databaseName: selected.d1.databaseName,
        workerName: selected.cloudflareProviderExecutor.workerName,
        activeVersionId: ordinary.versionId ?? "",
        activeDeploymentId: ordinary.deploymentId ?? "",
        previousVersionId: ordinary.previousVersionId ?? "",
        selectedSourceCommit: ordinary.commit ?? "",
        selectedModuleDigestHex: ordinary.moduleDigestHex ?? "",
        predecessorSourceCommit: OTHER_COMMIT,
        predecessorVersionId: ordinary.previousVersionId ?? "",
        observedNonCodeDigestHex: "7".repeat(64),
      },
    };
    expect(providerExecutorAllowsPublication(selected, inactive)).toBe(true);
    expect(providerExecutorAllowsPublication(selected, ordinary)).toBe(false);
    expect(providerExecutorAllowsPublication(v2Target, inactive)).toBe(false);
    expect(
      providerExecutorAllowsPublication(selected, {
        ...inactive,
        maintenance: { ...inactive.maintenance, databaseId: target.d1.databaseId },
      }),
    ).toBe(false);
    expect(
      providerExecutorAllowsPublication(selected, {
        ...inactive,
        maintenance: { ...inactive.maintenance, selectedModuleDigestHex: "f".repeat(64) },
      }),
    ).toBe(false);
  });

  test("0058 maintenance does not bypass a declared private executor qualifier", async () => {
    const selected = { ...executorTarget, schemaMaintenanceMode: "pre-0058-quiesced" as const };
    const current = fixture({
      selectedTarget: selected,
      local: canonicalMigrations,
      applied: exact0057,
    });
    const failure = await runWorker(
      {
        surface: "takoserver-worker",
        action: "status",
        environment: "integration",
        commit: COMMIT,
      },
      selected,
      { ...current, cloudflareEnvironment: {} },
    ).catch((error) => error);
    expect(failure).toBeInstanceOf(DeployError);
    expect((failure as Error).message).toContain("owner-injected live qualification");
    expect(current.calls.some((call) => call.includes("--no-bundle"))).toBe(false);
  });

  test("wrong 0058 predecessor refuses before owner gate or Worker upload", async () => {
    const current = fixture({
      selectedTarget: schemaMaintenanceTarget,
      local: canonicalMigrations,
      applied: exact0057.slice(0, -1),
    });
    const failure = await runWorker(
      { surface: "takoserver-worker", action: "apply", environment: "integration", commit: COMMIT },
      schemaMaintenanceTarget,
      { ...current, cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" } },
    ).catch((error) => error);
    expect(failure).toBeInstanceOf(DeployError);
    expect(current.calls.some((call) => call.join(" ") === "bun run check")).toBe(false);
    expect(current.calls.some((call) => call.includes("--no-bundle"))).toBe(false);
    const status = await runWorker(
      {
        surface: "takoserver-worker",
        action: "status",
        environment: "integration",
        commit: COMMIT,
      },
      schemaMaintenanceTarget,
      { ...current, cloudflareEnvironment: {} },
    ).catch((error) => error);
    expect(status).toBeInstanceOf(DeployError);
  });

  test("0058 maintenance current Version readback refuses wrong mode, storage binding and source annotation", async () => {
    for (const defect of ["mode", "storage", "source"] as const) {
      const current = fixture({
        selectedTarget: schemaMaintenanceTarget,
        current: "after",
        afterMessage: `takoserver-worker:${COMMIT}:${"c".repeat(64)}`,
        local: canonicalMigrations,
        applied: exact0057,
      });
      const state: WorkerState = {
        ...current.state,
        async workerVersion(workerName, versionId) {
          const version = await current.state.workerVersion(workerName, versionId);
          if (versionId !== VERSION_AFTER) return version;
          const actual = version as ReturnType<typeof versionForTarget>;
          if (defect === "source")
            return {
              ...actual,
              annotations: { ...actual.annotations, "workers/message": "not-a-source-annotation" },
            };
          return {
            ...actual,
            resources: {
              bindings: actual.resources.bindings.map((binding) => {
                if (defect === "mode" && binding.name === "TAKOSERVER_SCHEMA_MAINTENANCE_MODE")
                  return { ...binding, text: "wrong" };
                if (defect === "storage" && binding.name === "STATE_DB")
                  return { ...binding, id: "other-database" };
                return binding;
              }),
            },
          };
        },
      };
      const failure = await runWorker(
        {
          surface: "takoserver-worker",
          action: "status",
          environment: "integration",
          commit: COMMIT,
        },
        schemaMaintenanceTarget,
        { ...current, state, cloudflareEnvironment: {} },
      ).catch((error) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect(current.calls.some((call) => call.includes("--no-bundle"))).toBe(false);
    }
  });

  test("publishes a second exact 0058 maintenance Version without claiming runtime readiness", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-worker-0058-maintenance-"));
    try {
      const current = fixture({
        selectedTarget: schemaMaintenanceTarget,
        local: canonicalMigrations,
        applied: exact0057,
        beforeMessage: `takoserver-worker:${COMMIT}:${"c".repeat(64)}`,
        diff: "",
      });
      const result = await runWorker(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        schemaMaintenanceTarget,
        {
          ...current,
          review: "reviewer@example.test",
          outputDirectory: root,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          fetcher: async () =>
            Response.json(
              {
                error: {
                  code: "backend_unavailable",
                  message: "Host is quiesced for the 0058 schema maintenance transition",
                  details: { reason: "runtime-configuration" },
                },
              },
              { status: 503, headers: { "cache-control": "no-store", "retry-after": "60" } },
            ),
        },
      );
      expect(result).toMatchObject({
        maintenance: "pre-0058-quiesced",
        previousVersionId: VERSION_BEFORE,
        versionId: VERSION_AFTER,
        probe: { status: 503, traffic: "maintenance" },
      });
      expect(current.calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("publishes a second all-traffic compatibility Version while the exact 0043 wave is pending", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-worker-0043-compatibility-"));
    const compatibilityTarget = {
      ...target,
      artifactBlobIoMode: "pre-0043-quiesced",
    } satisfies DeployTarget;
    try {
      const current = fixture({
        selectedTarget: compatibilityTarget,
        local: ARTIFACT_BLOB_IO_COMPATIBILITY_PENDING,
        applied: [],
        beforeMessage: `takoserver-worker:${COMMIT}:${"c".repeat(64)}`,
        diff: "",
      });
      const result = await runWorker(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        compatibilityTarget,
        {
          ...current,
          review: "reviewer@example.test",
          outputDirectory: root,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          fetcher: artifactBlobIoQuiescenceFetcher,
        },
      );
      expect(result).toMatchObject({
        previousVersionId: VERSION_BEFORE,
        versionId: VERSION_AFTER,
        probe: {
          url: `${target.publicOrigin}/healthz`,
          status: 503,
          traffic: "quiesced",
        },
      });
      expect(current.calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("routine routes an authority-sensitive diff to the separate cutover", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-worker-sensitive-"));
    try {
      const current = fixture({ diff: "src/auth.ts\nsrc/catalog.ts\n" });
      const failure = await runWorker(
        {
          surface: "takoserver-worker",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        target,
        {
          ...current,
          outputDirectory: root,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      ).catch((error) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect(failure.message).toContain("takoserver-worker-authority-cutover");
      expect(current.calls.some((call) => call.join(" ") === "bun run check")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("routine also routes an uncommitted authority-sensitive path", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-worker-dirty-sensitive-"));
    try {
      const current = fixture({ diff: "", dirty: " M src/token.ts\0" });
      const failure = await runWorker(
        {
          surface: "takoserver-worker",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        target,
        {
          ...current,
          outputDirectory: root,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      ).catch((error) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect(failure.message).toContain("takoserver-worker-authority-cutover");
      expect(current.calls.some((call) => call.join(" ") === "bun run check")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("authority cutover needs review then seals one bundle/config for one upload", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-worker-authority-"));
    try {
      const current = fixture({ diff: "src/auth.ts\n", selectedTarget: v2Target });
      const result = await runWorker(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        v2Target,
        {
          ...current,
          review: "reviewer@example.test",
          outputDirectory: root,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          fetcher: publishedProductFetcher(),
          integrationStorageVerification: integrationStorageVerificationOptions(v2Target),
        },
      );
      expect(result).toMatchObject({
        kind: "takoserver.worker-apply@v2",
        surface: "takoserver-worker-authority-cutover",
        commit: COMMIT,
        previousVersionId: VERSION_BEFORE,
        versionId: VERSION_AFTER,
        reviewer: "reviewer@example.test",
      });
      expect(current.calls.filter((call) => call.join(" ") === "bun run check")).toHaveLength(1);
      expect(current.calls.filter((call) => call.includes("--dry-run"))).toHaveLength(1);
      const uploads = current.calls.filter((call) => call.includes("--no-bundle"));
      expect(uploads).toHaveLength(1);
      expect(uploads[0]).toContain("--strict");
      expect(uploads[0]?.find((value) => value.startsWith("takoserver-worker:"))).toMatch(
        /^takoserver-worker:[0-9a-f]{40}:[0-9a-f]{64}$/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("integration authority status uses the selected Wrangler for default remote D1 readers", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-worker-private-wrangler-"));
    const authorityTarget = {
      ...target,
      integrationE2eCredentialAuthority: {
        organizationId: INTEGRATION_E2E_ORGANIZATION_ID,
        publicJwk: { kty: "OKP", crv: "Ed25519", x: "E".repeat(43) },
      },
    } satisfies DeployTarget;
    const current = fixture();
    const privateWrangler = join(root, "private", "node_modules", ".bin", "wrangler");
    const d1Calls: string[][] = [];
    const run: WorkerProcess = async (command) => {
      d1Calls.push([...command]);
      const sql = command[command.indexOf("--command") + 1];
      if (sql === undefined) throw new Error("missing D1 command");
      if (sql.includes("FROM runtime_grant_keys")) {
        return ok(
          JSON.stringify([
            {
              success: true,
              results: [
                {
                  key_id: "key-current",
                  public_jwk: JSON.stringify({
                    kty: "OKP",
                    crv: "Ed25519",
                    x: `${"F".repeat(42)}A`,
                  }),
                  created_at_epoch_seconds: 1_700_000_000,
                  revoked_at_epoch_seconds: null,
                },
              ],
            },
          ]),
        );
      }
      if (sql === STRIPE_MODE_REALM_SCHEMA_QUERY) {
        return ok(
          JSON.stringify([
            {
              success: true,
              results: CANONICAL_STRIPE_REALM_SCHEMA,
            },
          ]),
        );
      }
      if (sql.includes("FROM stripe_mode_realm")) {
        return ok(JSON.stringify([{ success: true, results: [{ mode: "test" }] }]));
      }
      if (sql.includes("SELECT name FROM sqlite_schema WHERE type = 'table'")) {
        return ok(JSON.stringify([{ success: true, results: [] }]));
      }
      if (sql.includes("FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'")) {
        return ok(JSON.stringify([{ success: true, results: [] }]));
      }
      throw new Error(`unexpected D1 query: ${sql}`);
    };

    try {
      await runWorker(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "status",
          environment: "integration",
          commit: COMMIT,
          legacyPredecessorVersionId: VERSION_BEFORE,
        },
        authorityTarget,
        {
          state: current.state,
          run,
          wranglerPath: privateWrangler,
          outputDirectory: root,
        },
      );

      const migrationReads = d1Calls.filter(
        (command) =>
          command.at(-1)?.includes("sqlite_schema") &&
          command.at(-1) !== STRIPE_MODE_REALM_SCHEMA_QUERY,
      );
      const signingKeyRead = d1Calls.find((command) =>
        command.at(-1)?.includes("runtime_grant_keys"),
      );
      expect(migrationReads).toHaveLength(2);
      expect(migrationReads.every((command) => command[0] === privateWrangler)).toBe(true);
      expect(signingKeyRead?.[0]).toBe(privateWrangler);
      expect(
        d1Calls
          .filter((command) => command.at(-1)?.includes("stripe_mode_realm"))
          .every((command) => command[0] === privateWrangler),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("only the integration authority cutover adds one complete provenance-bound JIT profile", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-worker-jit-authority-"));
    const authorityTarget = {
      ...v2Target,
      integrationE2eCredentialAuthority: {
        organizationId: INTEGRATION_E2E_ORGANIZATION_ID,
        publicJwk: { kty: "OKP", crv: "Ed25519", x: "E".repeat(43) },
      },
    } satisfies DeployTarget;
    try {
      const process = fixture({ diff: "src/auth.ts\n", selectedTarget: v2Target });
      const activeSigningDatabase = signingDatabase(`${"F".repeat(42)}A`);
      const state: WorkerState = {
        async workerDomains() {
          return [{ hostname: "api.integration.example.test", service: target.workerName }];
        },
        async workerDeployments() {
          const uploaded = process.calls.some((call) => call.includes("--no-bundle"));
          return uploaded
            ? [
                deployment("deployment-after", VERSION_AFTER, "2026-08-28T02:00:00Z"),
                deployment("deployment-before", VERSION_BEFORE, "2026-08-28T01:00:00Z"),
              ]
            : [deployment("deployment-before", VERSION_BEFORE, "2026-08-28T01:00:00Z")];
        },
        async workerVersion(_worker, versionId) {
          if (versionId === VERSION_BEFORE) {
            return versionForTarget(
              versionId,
              `takoserver-worker:${LIVE_COMMIT}:${"c".repeat(64)}`,
              v2Target,
            );
          }
          const upload = process.calls.find((call) => call.includes("--no-bundle"));
          const message = upload?.[upload.indexOf("--message") + 1];
          if (!message) throw new Error("missing upload annotation");
          return versionForTarget(versionId, message, authorityTarget);
        },
        async workerSecrets() {
          return expectedWorkerSecrets(v2Target).map((name) => ({ name, type: "secret_text" }));
        },
      };

      const status = await runWorker(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "status",
          environment: "integration",
          commit: COMMIT,
          legacyPredecessorVersionId: VERSION_BEFORE,
        },
        authorityTarget,
        {
          ...process,
          state,
          outputDirectory: root,
          signingDatabase: activeSigningDatabase,
          integrationStorageVerification: integrationStorageVerificationOptions(authorityTarget),
        },
      );
      expect(status).toMatchObject({
        ready: false,
        integrationE2eCredentialAuthorityConfigured: false,
        versionId: VERSION_BEFORE,
      });

      const routine = await runWorker(
        {
          surface: "takoserver-worker",
          action: "status",
          environment: "integration",
          commit: COMMIT,
        },
        authorityTarget,
        {
          ...process,
          state,
          outputDirectory: root,
          signingDatabase: activeSigningDatabase,
        },
      ).catch((error) => error);
      expect(routine).toBeInstanceOf(DeployError);

      const result = await runWorker(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
          legacyPredecessorVersionId: VERSION_BEFORE,
        },
        authorityTarget,
        {
          ...process,
          state,
          review: "reviewer@example.test",
          outputDirectory: root,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          fetcher: publishedProductFetcher(),
          signingDatabase: activeSigningDatabase,
          integrationStorageVerification: integrationStorageVerificationOptions(authorityTarget),
        },
      );
      expect(result).toMatchObject({
        kind: "takoserver.worker-apply@v2",
        surface: "takoserver-worker-authority-cutover",
        commit: COMMIT,
        previousVersionId: VERSION_BEFORE,
        versionId: VERSION_AFTER,
      });
      const config = JSON.parse(readFileSync(join(root, "release/wrangler.jsonc"), "utf8")) as {
        vars: Record<string, string>;
      };
      expect(config.vars).toMatchObject({
        TAKOSERVER_ENVIRONMENT: "integration",
        TAKOSERVER_INTEGRATION_E2E_API_KEY_PUBLIC_JWK: JSON.stringify(
          authorityTarget.integrationE2eCredentialAuthority.publicJwk,
        ),
        TAKOSERVER_INTEGRATION_E2E_ORGANIZATION_ID: INTEGRATION_E2E_ORGANIZATION_ID,
        TAKOSERVER_SOURCE_COMMIT: COMMIT,
        TAKOSERVER_WORKER_ARTIFACT_DIGEST: result.bundleDigest,
      });
      expect(JSON.stringify(config)).not.toContain("private-material");
      expect(process.calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("JIT target rejects a historical-shaped current Version without an explicit historical selector", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-worker-jit-no-selector-"));
    const authorityTarget = {
      ...target,
      integrationE2eCredentialAuthority: {
        organizationId: INTEGRATION_E2E_ORGANIZATION_ID,
        publicJwk: { kty: "OKP", crv: "Ed25519", x: "E".repeat(43) },
      },
    } satisfies DeployTarget;
    try {
      const process = fixture({ diff: "src/auth.ts\n" });
      const failure = await runWorker(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        authorityTarget,
        {
          ...process,
          outputDirectory: root,
          review: "reviewer@example.test",
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          signingDatabase: signingDatabase(`${"F".repeat(42)}A`),
        },
      ).catch((error) => error);

      expect(failure).toBeInstanceOf(DeployError);
      expect(failure.phase).toBe("preflight");
      expect(failure.message).toContain("does not declare the TAKOSERVER_ENVIRONMENT binding");
      expect(process.calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("JIT target rejects wrong provenance exactly once without retrying through a stripped target", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-worker-jit-wrong-provenance-"));
    const authorityTarget = {
      ...target,
      integrationE2eCredentialAuthority: {
        organizationId: INTEGRATION_E2E_ORGANIZATION_ID,
        publicJwk: { kty: "OKP", crv: "Ed25519", x: "E".repeat(43) },
      },
    } satisfies DeployTarget;
    try {
      const process = fixture({ diff: "src/catalog.ts\n" });
      const base = process.state;
      let workerVersionReads = 0;
      const state: WorkerState = {
        ...base,
        async workerVersion(workerName, versionId) {
          if (versionId !== VERSION_BEFORE) return await base.workerVersion(workerName, versionId);
          workerVersionReads += 1;
          const value = versionForTarget(
            versionId,
            `takoserver-worker:${LIVE_COMMIT}:${"c".repeat(64)}`,
            authorityTarget,
          );
          const source = value.resources.bindings.find(
            (binding) => binding.name === "TAKOSERVER_SOURCE_COMMIT",
          ) as { readonly name: string; readonly type: string; text?: string } | undefined;
          if (!source) throw new Error("missing JIT source binding");
          source.text = OTHER_COMMIT;
          return value;
        },
      };
      const failure = await runWorker(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        authorityTarget,
        {
          ...process,
          state,
          outputDirectory: root,
          review: "reviewer@example.test",
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          signingDatabase: signingDatabase(`${"F".repeat(42)}A`),
        },
      ).catch((error) => error);

      expect(failure).toBeInstanceOf(DeployError);
      expect(failure.phase).toBe("preflight");
      expect(failure.message).toContain("binds TAKOSERVER_SOURCE_COMMIT with unexpected text");
      expect(workerVersionReads).toBe(1);
      expect(process.calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses JIT authority reuse of the active D1 signing key before any upload or put", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-worker-jit-signing-reuse-"));
    const authorityTarget = {
      ...target,
      integrationE2eCredentialAuthority: {
        organizationId: INTEGRATION_E2E_ORGANIZATION_ID,
        publicJwk: { kty: "OKP", crv: "Ed25519", x: "E".repeat(43) },
      },
    } satisfies DeployTarget;
    try {
      const process = fixture({ diff: "src/auth.ts\n" });
      const failure = await runWorker(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        authorityTarget,
        {
          ...process,
          outputDirectory: root,
          review: "reviewer@example.test",
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          signingDatabase: signingDatabase(
            authorityTarget.integrationE2eCredentialAuthority.publicJwk.x,
          ),
        },
      ).catch((error) => error);

      expect(failure).toMatchObject({ phase: "preflight" });
      expect(failure.message).toContain("must not reuse the active runtime signing key");
      expect(process.calls).toHaveLength(0);
      expect(process.calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(0);
      expect(process.calls.filter((call) => call.includes("put"))).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("integration authority cutover can bootstrap an exact unannotated predecessor", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-worker-legacy-"));
    try {
      const current = fixture({
        beforeMessage: null,
        dirty: " M src/catalog.ts\0",
        legacyBeforeWithoutVersionMetadata: true,
        selectedTarget: v2Target,
      });
      const result = await runWorker(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
          legacyPredecessorVersionId: VERSION_BEFORE,
        },
        v2Target,
        {
          ...current,
          review: "reviewer@example.test",
          outputDirectory: root,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          fetcher: publishedProductFetcher(),
          integrationStorageVerification: integrationStorageVerificationOptions(v2Target),
        },
      );
      expect(result).toMatchObject({
        predecessorIdentity: "legacy-unattributed-predecessor",
        authorityScope: "entire-worker-artifact",
        legacyPredecessorVersionId: VERSION_BEFORE,
        changedPaths: null,
        authorityPaths: null,
        worktreePaths: ["src/catalog.ts"],
      });
      expect(current.calls.some((call) => call.join(" ").includes("git diff"))).toBe(false);
      expect(current.calls.filter((call) => call.join(" ") === "bun run check")).toHaveLength(1);
      expect(current.calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(1);

      const status = await runWorker(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "status",
          environment: "integration",
          commit: COMMIT,
        },
        v2Target,
        {
          ...current,
          outputDirectory: root,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          integrationStorageVerification: integrationStorageVerificationOptions(v2Target),
        },
      );
      expect(status).toMatchObject({ deployedCommit: COMMIT, commitMatches: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("selector status reports that the exact legacy predecessor remains current", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-worker-legacy-status-current-"));
    try {
      const current = fixture({
        beforeMessage: null,
        legacyBeforeWithoutVersionMetadata: true,
      });
      const status = await runWorker(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "status",
          environment: "integration",
          commit: COMMIT,
          legacyPredecessorVersionId: VERSION_BEFORE,
        },
        target,
        {
          ...current,
          outputDirectory: root,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      );
      expect(status).toMatchObject({
        kind: "takoserver.worker-status@v2",
        legacyPredecessorVersionId: VERSION_BEFORE,
        cutoverState: "legacy-predecessor-current",
        deployedCommit: null,
        artifactDigest: null,
        commitMatches: false,
        ready: false,
        versionId: VERSION_BEFORE,
        previousVersionId: null,
        predecessorIdentity: "legacy-unattributed-predecessor",
        authorityScope: "entire-worker-artifact",
      });
      expect(current.calls.filter((call) => call.join(" ") === "bun run check")).toHaveLength(0);
      expect(current.calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("selector status preserves canonical identity but never marks a pre-metadata predecessor ready", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-worker-legacy-canonical-status-"));
    try {
      const current = fixture({
        beforeMessage: `takoserver-worker:${COMMIT}:${"c".repeat(64)}`,
        legacyBeforeWithoutVersionMetadata: true,
      });
      const status = await runWorker(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "status",
          environment: "integration",
          commit: COMMIT,
          legacyPredecessorVersionId: VERSION_BEFORE,
        },
        target,
        {
          ...current,
          outputDirectory: root,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      );
      expect(status).toMatchObject({
        kind: "takoserver.worker-status@v2",
        legacyPredecessorVersionId: VERSION_BEFORE,
        cutoverState: "legacy-predecessor-current",
        deployedCommit: COMMIT,
        artifactDigest: `sha256:${"c".repeat(64)}`,
        commitMatches: true,
        ready: false,
        versionId: VERSION_BEFORE,
        authorityScope: "entire-worker-artifact",
      });
      expect(status).not.toHaveProperty("predecessorIdentity");
      expect(current.calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("integration authority cutover bootstraps a canonical pre-metadata predecessor as one artifact", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-worker-legacy-canonical-apply-"));
    try {
      const current = fixture({
        dirty: " M src/catalog.ts\0",
        legacyBeforeWithoutVersionMetadata: true,
        selectedTarget: v2Target,
      });
      const result = await runWorker(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
          legacyPredecessorVersionId: VERSION_BEFORE,
        },
        v2Target,
        {
          ...current,
          review: "reviewer@example.test",
          outputDirectory: root,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          fetcher: publishedProductFetcher(),
          integrationStorageVerification: integrationStorageVerificationOptions(v2Target),
        },
      );
      expect(result).toMatchObject({
        authorityScope: "entire-worker-artifact",
        legacyPredecessorVersionId: VERSION_BEFORE,
        changedPaths: null,
        authorityPaths: null,
        worktreePaths: ["src/catalog.ts"],
        previousVersionId: VERSION_BEFORE,
        versionId: VERSION_AFTER,
      });
      expect(result).not.toHaveProperty("predecessorIdentity");
      expect(current.calls.some((call) => call.join(" ").includes("git diff"))).toBe(false);
      expect(current.calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("selector status rejects an unattributed predecessor with the successor metadata binding", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-worker-legacy-status-new-binding-"));
    try {
      const current = fixture({ beforeMessage: null });
      const failure = await runWorker(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "status",
          environment: "integration",
          commit: COMMIT,
          legacyPredecessorVersionId: VERSION_BEFORE,
        },
        target,
        {
          ...current,
          outputDirectory: root,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      ).catch((error) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect(failure.message).toContain("canonical annotation inventory");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("selector status requires the direct successor to add version metadata", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-worker-legacy-status-successor-binding-"));
    try {
      const current = fixture({
        current: "after",
        afterMessage: `takoserver-worker:${COMMIT}:${"f".repeat(64)}`,
        afterWithoutVersionMetadata: true,
      });
      const failure = await runWorker(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "status",
          environment: "integration",
          commit: COMMIT,
          legacyPredecessorVersionId: VERSION_BEFORE,
        },
        target,
        {
          ...current,
          outputDirectory: root,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      ).catch((error) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect(failure.message).toContain("does not declare the WORKER_VERSION binding");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("selector status reconciles a lost upload acknowledgement to the selected commit", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-worker-legacy-status-lost-ack-"));
    try {
      const current = fixture({
        current: "after",
        afterMessage: `takoserver-worker:${COMMIT}:${"f".repeat(64)}`,
      });
      const status = await runWorker(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "status",
          environment: "integration",
          commit: COMMIT,
          legacyPredecessorVersionId: VERSION_BEFORE,
        },
        target,
        {
          ...current,
          outputDirectory: root,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      );
      expect(status).toMatchObject({
        kind: "takoserver.worker-status@v2",
        legacyPredecessorVersionId: VERSION_BEFORE,
        cutoverState: "selected-commit-current",
        deployedCommit: COMMIT,
        commitMatches: true,
        artifactDigest: `sha256:${"f".repeat(64)}`,
        ready: true,
        versionId: VERSION_AFTER,
        previousVersionId: VERSION_BEFORE,
      });
      expect(status).not.toHaveProperty("predecessorIdentity");
      expect(current.calls.filter((call) => call.join(" ") === "bun run check")).toHaveLength(0);
      expect(current.calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("selector status reports a direct advance to a different canonical commit", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-worker-legacy-status-different-"));
    try {
      const current = fixture({
        current: "after",
        afterMessage: `takoserver-worker:${OTHER_COMMIT}:${"e".repeat(64)}`,
      });
      const status = await runWorker(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "status",
          environment: "integration",
          commit: COMMIT,
          legacyPredecessorVersionId: VERSION_BEFORE,
        },
        target,
        {
          ...current,
          outputDirectory: root,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      );
      expect(status).toMatchObject({
        legacyPredecessorVersionId: VERSION_BEFORE,
        cutoverState: "different-commit-current",
        deployedCommit: OTHER_COMMIT,
        commitMatches: false,
        ready: false,
        versionId: VERSION_AFTER,
        previousVersionId: VERSION_BEFORE,
      });
      expect(current.calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("selector status rejects an unrelated canonical advancement", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-worker-legacy-status-unrelated-"));
    try {
      const current = fixture({ current: "unrelated" });
      const failure = await runWorker(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "status",
          environment: "integration",
          commit: COMMIT,
          legacyPredecessorVersionId: VERSION_BEFORE,
        },
        target,
        {
          ...current,
          outputDirectory: root,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      ).catch((error) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect(failure.phase).toBe("preflight");
      expect(failure.message).toContain("not the direct successor");
      expect(current.calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("selector status rejects a malformed direct successor", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-worker-legacy-status-malformed-"));
    try {
      const current = fixture({ current: "after", afterMessage: "not-canonical" });
      const failure = await runWorker(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "status",
          environment: "integration",
          commit: COMMIT,
          legacyPredecessorVersionId: VERSION_BEFORE,
        },
        target,
        {
          ...current,
          outputDirectory: root,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      ).catch((error) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect(failure.phase).toBe("preflight");
      expect(failure.message).toContain("non-canonical annotation inventory");
      expect(current.calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("apply rejects an already advanced selector before its gate or upload", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-worker-legacy-apply-advanced-"));
    try {
      const current = fixture({
        current: "after",
        afterMessage: `takoserver-worker:${COMMIT}:${"f".repeat(64)}`,
      });
      const failure = await runWorker(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
          legacyPredecessorVersionId: VERSION_BEFORE,
        },
        target,
        {
          ...current,
          review: "reviewer@example.test",
          outputDirectory: root,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      ).catch((error) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect(failure.message).toContain("does not match the pinned legacy predecessor");
      expect(current.calls.filter((call) => call.join(" ") === "bun run check")).toHaveLength(0);
      expect(current.calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("legacy bootstrap rechecks the pinned predecessor after build and before upload", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-worker-legacy-race-"));
    try {
      const current = fixture({
        beforeMessage: null,
        advanceDuringBuild: true,
        afterMessage: `takoserver-worker:${OTHER_COMMIT}:${"e".repeat(64)}`,
        legacyBeforeWithoutVersionMetadata: true,
      });
      const failure = await runWorker(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
          legacyPredecessorVersionId: VERSION_BEFORE,
        },
        target,
        {
          ...current,
          review: "reviewer@example.test",
          outputDirectory: root,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      ).catch((error) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect(failure.phase).toBe("preflight");
      expect(failure.message).toContain("pinned legacy predecessor");
      expect(current.calls.filter((call) => call.join(" ") === "bun run check")).toHaveLength(1);
      expect(current.calls.filter((call) => call.includes("--dry-run"))).toHaveLength(1);
      expect(current.calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("legacy bootstrap rejects identity and binding-profile transition before upload", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-worker-legacy-attribution-race-"));
    try {
      const current = fixture({
        beforeMessage: null,
        beforeMessageAfterBuild: `takoserver-worker:${LIVE_COMMIT}:${"c".repeat(64)}`,
        legacyBeforeWithoutVersionMetadata: true,
        beforeVersionMetadataAfterBuild: true,
      });
      const failure = await runWorker(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
          legacyPredecessorVersionId: VERSION_BEFORE,
        },
        target,
        {
          ...current,
          review: "reviewer@example.test",
          outputDirectory: root,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      ).catch((error) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect(failure.phase).toBe("preflight");
      expect(failure.message).toContain("identity or binding profile changed");
      expect(current.calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("canonical legacy bootstrap rejects identity drift before upload", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-worker-legacy-canonical-race-"));
    try {
      const current = fixture({
        beforeMessageAfterBuild: `takoserver-worker:${OTHER_COMMIT}:${"e".repeat(64)}`,
        legacyBeforeWithoutVersionMetadata: true,
      });
      const failure = await runWorker(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
          legacyPredecessorVersionId: VERSION_BEFORE,
        },
        target,
        {
          ...current,
          review: "reviewer@example.test",
          outputDirectory: root,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      ).catch((error) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect(failure.phase).toBe("preflight");
      expect(failure.message).toContain("identity or binding profile changed");
      expect(current.calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("legacy bootstrap rejects a same-Version deployment replacement during final inspection", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-worker-legacy-history-race-"));
    try {
      const current = fixture({
        legacyBeforeWithoutVersionMetadata: true,
        replaceDeploymentDuringFinalInspection: true,
      });
      const failure = await runWorker(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
          legacyPredecessorVersionId: VERSION_BEFORE,
        },
        target,
        {
          ...current,
          review: "reviewer@example.test",
          outputDirectory: root,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      ).catch((error) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect(failure.phase).toBe("preflight");
      expect(failure.message).toContain("deployment history changed during closure inspection");
      expect(current.calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("legacy bootstrap rechecks exact live closure immediately before upload", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-worker-legacy-closure-race-"));
    try {
      const current = fixture({
        beforeMessage: null,
        secretsAfterBuild: [],
        legacyBeforeWithoutVersionMetadata: true,
      });
      const failure = await runWorker(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
          legacyPredecessorVersionId: VERSION_BEFORE,
        },
        target,
        {
          ...current,
          review: "reviewer@example.test",
          outputDirectory: root,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      ).catch((error) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect(failure.phase).toBe("preflight");
      expect(failure.message).toContain("Worker secret inventory drift");
      expect(current.calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an explicit selector does not downgrade a canonical predecessor", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-worker-legacy-canonical-"));
    try {
      const current = fixture({ selectedTarget: v2Target });
      const status = await runWorker(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "status",
          environment: "integration",
          commit: COMMIT,
          legacyPredecessorVersionId: VERSION_BEFORE,
        },
        v2Target,
        {
          ...current,
          outputDirectory: root,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          integrationStorageVerification: integrationStorageVerificationOptions(v2Target),
        },
      );
      expect(status).toMatchObject({
        deployedCommit: LIVE_COMMIT,
        commitMatches: false,
        ready: true,
        artifactDigest: `sha256:${"c".repeat(64)}`,
        versionId: VERSION_BEFORE,
      });
      expect(status).not.toHaveProperty("cutoverState");
      expect(status).not.toHaveProperty("predecessorIdentity");
      expect(status).not.toHaveProperty("legacyPredecessorVersionId");

      const result = await runWorker(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
          legacyPredecessorVersionId: VERSION_BEFORE,
        },
        v2Target,
        {
          ...current,
          review: "reviewer@example.test",
          outputDirectory: root,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          fetcher: publishedProductFetcher(),
          integrationStorageVerification: integrationStorageVerificationOptions(v2Target),
        },
      );
      expect(result).toMatchObject({
        changedPaths: ["src/catalog.ts"],
        authorityPaths: [],
      });
      expect(result).not.toHaveProperty("predecessorIdentity");
      expect(result).not.toHaveProperty("authorityScope");
      expect(current.calls.some((call) => call.join(" ").includes("git diff"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("legacy bootstrap refuses an unannotated predecessor without the exact selector", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-worker-legacy-no-selector-"));
    try {
      const current = fixture({
        beforeMessage: null,
        legacyBeforeWithoutVersionMetadata: true,
      });
      const failure = await runWorker(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        target,
        {
          ...current,
          review: "reviewer@example.test",
          outputDirectory: root,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      ).catch((error) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect(failure.message).toContain("canonical annotation");
      expect(current.calls.some((call) => call.join(" ") === "bun run check")).toBe(false);
      expect(current.calls.some((call) => call.includes("--no-bundle"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("legacy bootstrap refuses a selector that does not match the current Version", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-worker-legacy-mismatch-"));
    try {
      const current = fixture({
        beforeMessage: null,
        legacyBeforeWithoutVersionMetadata: true,
      });
      const failure = await runWorker(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
          legacyPredecessorVersionId: "00000000-0000-4000-8000-000000000099",
        },
        target,
        {
          ...current,
          review: "reviewer@example.test",
          outputDirectory: root,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      ).catch((error) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect(failure.message).toContain("does not match the pinned legacy predecessor");
      expect(current.calls.some((call) => call.join(" ") === "bun run check")).toBe(false);
      expect(current.calls.some((call) => call.includes("--no-bundle"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("legacy bootstrap requires an independent reviewer before its gate or upload", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-worker-legacy-review-"));
    try {
      const current = fixture({
        beforeMessage: "not-canonical",
        legacyBeforeWithoutVersionMetadata: true,
      });
      const failure = await runWorker(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
          legacyPredecessorVersionId: VERSION_BEFORE,
        },
        target,
        {
          ...current,
          outputDirectory: root,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      ).catch((error) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect(failure.message).toContain("TAKOSERVER_INDEPENDENT_REVIEW");
      expect(current.calls.some((call) => call.join(" ") === "bun run check")).toBe(false);
      expect(current.calls.some((call) => call.includes("--no-bundle"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("legacy bootstrap never accepts a malformed annotation after upload", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-worker-legacy-post-"));
    try {
      const current = fixture({
        beforeMessage: null,
        afterMessage: "not-canonical",
        legacyBeforeWithoutVersionMetadata: true,
        selectedTarget: v2Target,
      });
      const failure = await runWorker(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
          legacyPredecessorVersionId: VERSION_BEFORE,
        },
        v2Target,
        {
          ...current,
          review: "reviewer@example.test",
          outputDirectory: root,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          fetcher: publishedProductFetcher(),
          integrationStorageVerification: integrationStorageVerificationOptions(v2Target),
        },
      ).catch((error) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect(failure.phase).toBe("verification");
      expect(failure.message).toContain("non-canonical annotation inventory");
      expect(current.calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an advanced malformed Version cannot be re-adopted with the old selector", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-worker-legacy-advanced-"));
    try {
      const current = fixture({
        beforeMessage: null,
        afterMessage: "not-canonical",
        legacyBeforeWithoutVersionMetadata: true,
        selectedTarget: v2Target,
      });
      const first = await runWorker(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
          legacyPredecessorVersionId: VERSION_BEFORE,
        },
        v2Target,
        {
          ...current,
          review: "reviewer@example.test",
          outputDirectory: root,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          fetcher: publishedProductFetcher(),
          integrationStorageVerification: integrationStorageVerificationOptions(v2Target),
        },
      ).catch((error) => error);
      expect(first).toBeInstanceOf(DeployError);
      expect(first.phase).toBe("verification");

      const second = await runWorker(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "status",
          environment: "integration",
          commit: COMMIT,
          legacyPredecessorVersionId: VERSION_BEFORE,
        },
        v2Target,
        {
          ...current,
          outputDirectory: root,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          integrationStorageVerification: integrationStorageVerificationOptions(v2Target),
        },
      ).catch((error) => error);
      expect(second).toBeInstanceOf(DeployError);
      expect(second.message).toContain("non-canonical annotation inventory");
      expect(current.calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function providerExecutorInspection(ready: boolean): ProviderExecutorInspection {
  const digest = "8".repeat(64);
  return {
    status: ready ? "ready" : "stale",
    ready,
    managedExact: true,
    routeLess: true,
    schemaReady: true,
    dependencies: {
      ready: true,
      receiptAuthorityReady: true,
      receiptAuthorityVersionId: "00000000-0000-4000-8000-000000000097",
      managedWorkerGatewayReady: true,
      managedWorkerGatewayVersionId: "00000000-0000-4000-8000-000000000098",
    },
    versionId: "00000000-0000-4000-8000-000000000099",
    deploymentId: "00000000-0000-4000-8000-000000000100",
    previousVersionId: "00000000-0000-4000-8000-000000000096",
    commit: ready ? COMMIT : OTHER_COMMIT,
    bundleDigestHex: digest,
    moduleDigestHex: digest,
  };
}

function publishedProductFetcher(
  options: { readonly discoveryOrigin?: string; readonly openApiOrigin?: string } = {},
) {
  const discoveryOrigin = options.discoveryOrigin ?? target.publicOrigin;
  const openApiOrigin = options.openApiOrigin ?? target.publicOrigin;
  return async (input: string): Promise<Response> => {
    const pathname = new URL(input).pathname;
    if (pathname === "/.well-known/takoserver") {
      return Response.json({
        product: "takoserver",
        apiVersion: "v1",
        endpoints: {
          api: discoveryOrigin,
          openapi: `${discoveryOrigin}/openapi.json`,
        },
      });
    }
    if (pathname === "/openapi.json") {
      return Response.json({ servers: [{ url: openApiOrigin }] });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  };
}

async function artifactBlobIoQuiescenceFetcher(): Promise<Response> {
  return Response.json(
    {
      error: {
        code: "backend_unavailable",
        message: "artifact blob I/O is quiesced for the 0043 compatibility cutover",
        details: { reason: "runtime-configuration" },
      },
    },
    {
      status: 503,
      headers: { "cache-control": "no-store", "retry-after": "60" },
    },
  );
}

function deployment(id: string, versionId: string, created: string) {
  return {
    id,
    created_on: created,
    versions: [{ version_id: versionId, percentage: 100 }],
  };
}

function version(
  id: string,
  message: string | null,
  bindingProfile: "current" | "legacy-pre-version-metadata" = "current",
  selectedTarget: DeployTarget = target,
) {
  const expected = expectedExactBindingClosure(selectedTarget);
  return {
    id,
    ...(message === null
      ? {}
      : {
          annotations: {
            "workers/message": message,
            "workers/triggered_by": "version_upload",
          },
        }),
    resources: {
      bindings: Object.entries(expected).flatMap(([name, requirement]) => {
        if (requirement === null) return [];
        if (bindingProfile === "legacy-pre-version-metadata" && name === "WORKER_VERSION") {
          return [];
        }
        return [{ name, type: requirement.type, ...requirement.fields }];
      }),
    },
  };
}

function versionForTarget(id: string, message: string, selectedTarget: DeployTarget) {
  const match = /^takoserver-worker:([0-9a-f]{40}):([0-9a-f]{64})$/u.exec(message);
  if (!match) throw new Error("invalid test Worker annotation");
  const expected = expectedExactBindingClosure(selectedTarget, {
    ...(selectedTarget.integrationE2eCredentialAuthority === undefined
      ? {}
      : {
          authorityProfile: {
            kind: "provenance-bound-jit" as const,
            provenance: {
              sourceCommit: match[1] as string,
              artifactDigest: `sha256:${match[2]}` as const,
            },
          },
        }),
  });
  return {
    id,
    annotations: {
      "workers/message": message,
      "workers/triggered_by": "version_upload",
    },
    resources: {
      bindings: Object.entries(expected).flatMap(([name, requirement]) =>
        requirement === null ? [] : [{ name, type: requirement.type, ...requirement.fields }],
      ),
    },
  };
}

function signingDatabase(publicX: string) {
  return {
    async readKey(keyId: string) {
      return {
        keyId,
        publicJwk: JSON.stringify({ kty: "OKP", crv: "Ed25519", x: publicX }),
        createdAtEpochSeconds: 1_700_000_000,
        revokedAtEpochSeconds: null,
      };
    },
  };
}

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

/**
 * A Wrangler OAuth access token lives about one hour and `auth token --json`
 * refreshes it only once it has already expired. This models one expiry while
 * the owner gate runs: the gate invalidates the issued token, and the next
 * `auth token` call mints `oauth-access-2`.
 */
function expiringOAuth(events: string[], gate = "bun run check") {
  let issued = 0;
  let live = "";
  return {
    live: () => live,
    /** Answers `auth token --json`; every other command returns undefined. */
    answer(command: readonly string[]): CommandResult | undefined {
      if (command.slice(-3).join(" ") !== "auth token --json") return undefined;
      if (live === "") {
        issued += 1;
        live = `oauth-access-${issued}`;
      }
      events.push(`token:${live}`);
      return {
        exitCode: 0,
        stdout: `${JSON.stringify({ type: "oauth", token: live })}\n`,
        stderr: "",
      };
    },
    afterCommand(command: readonly string[]): void {
      if (command.join(" ") !== gate) return;
      events.push("gate");
      live = "";
    },
  };
}

interface CloudflareApiState {
  workerDomains(): Promise<readonly { readonly hostname: string; readonly service: string }[]>;
  workerDeployments(workerName: string): Promise<readonly unknown[]>;
  workerVersion(workerName: string, versionId: string): Promise<unknown>;
  workerSecrets(workerName: string): Promise<readonly unknown[]>;
  workerSubdomain?(
    workerName: string,
  ): Promise<{ readonly enabled: boolean; readonly previewsEnabled: boolean }>;
  workerAccountSubdomain?(): Promise<string>;
}

/**
 * Serves one portable Worker state as the Cloudflare REST API on the global
 * fetch, which never reaches the network. Only the live OAuth access token is
 * authorized; any other bearer receives the provider's 401.
 */
async function withCloudflareApi<T>(
  state: CloudflareApiState,
  live: () => string,
  events: string[],
  body: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      const bearer = request.headers.get("authorization");
      events.push(`${request.method}:${bearer}`);
      const url = new URL(request.url);
      if (url.origin !== "https://api.cloudflare.com" || bearer !== `Bearer ${live()}`) {
        return Response.json(
          { success: false, result: null, errors: [{ code: 10000, message: "denied" }] },
          { status: 401 },
        );
      }
      return await cloudflareApiResponse(state, url);
    },
    { preconnect: original.preconnect },
  );
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

async function cloudflareApiResponse(state: CloudflareApiState, url: URL): Promise<Response> {
  const ok = (result: unknown, extra: Record<string, unknown> = {}) =>
    Response.json({ success: true, errors: [], messages: [], result, ...extra });
  const path = url.pathname.replace(/^\/client\/v4\/accounts\/[0-9a-f]{32}\/workers/u, "");
  const [collection, name, resource, id] = path.split("/").slice(1).map(decodeURIComponent);
  if (path === "/domains") {
    const domains = await state.workerDomains();
    const perPage = Number(url.searchParams.get("per_page"));
    return ok(domains, {
      result_info: {
        page: 1,
        per_page: perPage,
        count: domains.length,
        total_count: domains.length,
        total_pages: Math.ceil(domains.length / perPage),
      },
    });
  }
  if (path === "/subdomain" && state.workerAccountSubdomain !== undefined) {
    return ok({ subdomain: await state.workerAccountSubdomain() });
  }
  if (collection === "scripts" && name !== undefined) {
    if (resource === "deployments" && id === undefined) {
      return ok({ deployments: await state.workerDeployments(name) });
    }
    if (resource === "versions" && id !== undefined) return ok(await state.workerVersion(name, id));
    if (resource === "secrets") return ok(await state.workerSecrets(name));
    if (resource === "subdomain" && state.workerSubdomain !== undefined) {
      const subdomain = await state.workerSubdomain(name);
      return ok({ enabled: subdomain.enabled, previews_enabled: subdomain.previewsEnabled });
    }
  }
  return Response.json(
    { success: false, result: null, errors: [{ code: 7003, message: `unmodelled ${path}` }] },
    { status: 404 },
  );
}

/** Events with consecutive repeats collapsed. */
function timeline(events: readonly string[]): readonly string[] {
  return events.filter((event, index) => event !== events[index - 1]);
}
