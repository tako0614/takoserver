import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudflareProviderExecutorInspection } from "../scripts/deploy/cloudflare-provider-executor.ts";
import { DeployError } from "../scripts/deploy/errors.ts";
import type { CommandResult } from "../scripts/deploy/process.ts";
import { expectedWorkerSecrets, writeWorkerConfig } from "../scripts/deploy/realized-config.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import type {
  WorkerMigrationReader,
  WorkerProviderExecutorQualification,
  WorkerState,
} from "../scripts/deploy/worker.ts";
import {
  type ClosureTransitionProcess,
  runWorkerClosureTransition,
} from "../scripts/deploy/worker-closure-transition.ts";
import {
  expectedExactBindingClosure,
  type WorkerClosureDelta,
} from "../scripts/deploy/worker-state.ts";
import {
  cloudflareProviderExecutorTarget,
  EDGE_ONLY_RESOURCE_CLASSES,
  edgeSuppliesFixture,
  objectBucketSuppliesFixture,
} from "./helpers/hosted-supply-fixtures.ts";

const COMMIT = "a".repeat(40);
const LIVE_COMMIT = "b".repeat(40);
const LIVE_DIGEST = "c".repeat(64);
const BUNDLE = "export default {fetch(){return new Response('ok')}};\n";
const PREDECESSOR = "00000000-0000-4000-8000-0000000000a1";
const SUCCESSOR = "00000000-0000-4000-8000-0000000000a2";
const UNRELATED = "00000000-0000-4000-8000-0000000000a3";

const RETIRED_VAR = "TAKOSERVER_STANDARD_SERVICE_SUPPLIES";
const ADDED_VAR = "TAKOSERVER_OBJECT_BUCKET_SUPPLIES";
const REFRESHED_VAR = "TAKOSERVER_EDGE_SUPPLIES";
const ADDED_BINDING = "CLOUDFLARE_PROVIDER_EXECUTOR";
const ADDED_SECRET = "TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING";
const ROTATED_SECRET = "TAKOSERVER_SIGNING_KEY";
const CARRIED_STORE_SECRET = "STRIPE_SECRET_KEY";
const SEAL_KEYRING_VALUE = "seal-keyring-input-value";
const PROVISIONER_TOKEN_VALUE = "replacement-provisioner-token";

/**
 * The integration case this profile exists for: `main` retired
 * `standardServiceSupplies`, added `objectBucketSupplies`, and made the
 * runtime-input seal keyring a required secret once edge supplies are sold.
 */
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
  // Real reviewed supplies, shaped like the operator's own target: two halves
  // over one shared Cloudflare SupplyContract. Anything less would not reach
  // the composition preflight every Worker publication now runs.
  edgeSupplies: edgeSuppliesFixture(),
  objectBucketSupplies: objectBucketSuppliesFixture(),
  cloudflareProviderExecutor: cloudflareProviderExecutorTarget(),
} satisfies DeployTarget;

/** The post-rollback target adds Stripe to the two public-owned Worker secrets. */
const rollbackTarget = {
  ...target,
  stripeCheckout: true,
} satisfies DeployTarget;

const INTEGRATION_DELTA: WorkerClosureDelta = {
  retiredVars: [RETIRED_VAR],
  addedVars: [ADDED_VAR],
  refreshedVars: [],
  addedBindings: [ADDED_BINDING],
  addedSecrets: [ADDED_SECRET],
  rotatedSecrets: [ROTATED_SECRET],
};

function targetBindings(
  selected: DeployTarget = target,
): readonly { readonly name: string; readonly type: string }[] {
  return Object.entries(expectedExactBindingClosure(selected)).flatMap(([name, requirement]) =>
    requirement === null ? [] : [{ name, type: requirement.type, ...requirement.fields }],
  );
}

/** The pinned predecessor: one retired var extra, one var and one secret short. */
function predecessorVersion(
  overrides: {
    readonly extraVar?: string;
    readonly dropVar?: string;
    readonly annotation?: string | null;
    readonly selected?: DeployTarget;
    /** Target secrets this Version does not declare, as a rollback can leave them. */
    readonly dropSecrets?: readonly string[];
    /** Values this Version binds that differ from the ones the target derives. */
    readonly staleVars?: Readonly<Record<string, string>>;
  } = {},
) {
  const bindings = targetBindings(overrides.selected)
    .filter(({ name }) => name !== ADDED_BINDING)
    .filter(
      ({ name }) =>
        name !== ADDED_VAR &&
        name !== ADDED_SECRET &&
        (overrides.dropVar === undefined || name !== overrides.dropVar),
    );
  const dropped = new Set(overrides.dropSecrets ?? []);
  const stale: Readonly<Record<string, string>> = overrides.staleVars ?? {};
  const declared = bindings
    .filter(({ name }) => !dropped.has(name))
    .map((binding) =>
      stale[binding.name] === undefined ? binding : { ...binding, text: stale[binding.name] },
    );
  const annotation =
    overrides.annotation === undefined
      ? `takoserver-worker:${LIVE_COMMIT}:${LIVE_DIGEST}`
      : overrides.annotation;
  return {
    id: PREDECESSOR,
    ...(annotation === null
      ? {}
      : {
          annotations: {
            "workers/message": annotation,
            "workers/triggered_by": "version_upload",
          },
        }),
    resources: {
      bindings: [
        ...declared,
        { name: RETIRED_VAR, type: "plain_text", text: '{"kind":"legacy"}' },
        ...(overrides.extraVar === undefined
          ? []
          : [{ name: overrides.extraVar, type: "plain_text", text: "left-over" }]),
      ],
    },
  };
}

function successorVersion(message: string, selected: DeployTarget = target) {
  return {
    id: SUCCESSOR,
    annotations: { "workers/message": message, "workers/triggered_by": "version_upload" },
    resources: { bindings: targetBindings(selected) },
  };
}

function deployment(id: string, versionId: string, created: string) {
  return { id, created_on: created, versions: [{ version_id: versionId, percentage: 100 }] };
}

interface Fixture {
  readonly run: ClosureTransitionProcess;
  readonly calls: string[][];
  readonly stateCalls: string[];
  readonly state: WorkerState;
  readonly migrations: WorkerMigrationReader;
  readonly secretDirectory: string;
  readonly providerExecutorQualification: WorkerProviderExecutorQualification;
}

function fixture(
  root: string,
  input: {
    readonly current?: "predecessor" | "successor" | "unrelated";
    readonly applied?: readonly string[];
    readonly predecessor?: Parameters<typeof predecessorVersion>[0];
    readonly predecessorSecrets?: readonly string[];
    /** Exact script-level secret store, which a rollback can leave ahead. */
    readonly storeSecrets?: readonly string[];
    readonly selected?: DeployTarget;
    readonly local?: readonly string[];
  } = {},
): Fixture {
  const selected = input.selected ?? target;
  const calls: string[][] = [];
  const stateCalls: string[] = [];
  let current = input.current ?? "predecessor";
  let uploaded = false;
  let uploadMessage: string | null = null;
  const run: ClosureTransitionProcess = async (command): Promise<CommandResult> => {
    calls.push([...command]);
    const key = command.join(" ");
    if (key === "git rev-parse HEAD") return ok(`${COMMIT}\n`);
    if (key === "git branch --show-current") return ok("fix/closure-transition\n");
    if (key === "git status --porcelain=v1 -z --untracked-files=all") return ok("");
    if (key === "bun run check") return ok("green\n");
    if (command.includes("--dry-run")) {
      const out = command[command.indexOf("--outdir") + 1];
      if (!out) throw new Error("dry-run output missing");
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, "index.js"), BUNDLE);
      writeFileSync(join(out, "index.js.map"), "{}\n");
      return ok("Total Upload: 1 KiB\n");
    }
    if (command.includes("deploy") && command.includes("--no-bundle")) {
      uploadMessage = command[command.indexOf("--message") + 1] ?? null;
      uploaded = true;
      current = "successor";
      return ok("Uploaded\n");
    }
    throw new Error(`unexpected command: ${key}`);
  };
  const state: WorkerState = {
    async workerDomains() {
      stateCalls.push("workerDomains");
      return [{ hostname: "api.integration.example.test", service: selected.workerName }];
    },
    async workerDeployments() {
      stateCalls.push("workerDeployments");
      if (current === "unrelated") {
        return [deployment("deployment-unrelated", UNRELATED, "2026-09-02T03:00:00Z")];
      }
      if (current === "predecessor") {
        return [deployment("deployment-predecessor", PREDECESSOR, "2026-09-02T01:00:00Z")];
      }
      return [
        deployment("deployment-successor", SUCCESSOR, "2026-09-02T02:00:00Z"),
        deployment("deployment-predecessor", PREDECESSOR, "2026-09-02T01:00:00Z"),
      ];
    },
    async workerVersion(_worker, versionId) {
      stateCalls.push(`workerVersion:${versionId}`);
      if (versionId === PREDECESSOR) {
        return predecessorVersion({ selected, ...input.predecessor });
      }
      if (versionId === SUCCESSOR) {
        return successorVersion(
          uploadMessage ?? `takoserver-worker:${COMMIT}:${"d".repeat(64)}`,
          selected,
        );
      }
      return { id: versionId, resources: { bindings: [] } };
    },
    async workerSecrets() {
      stateCalls.push("workerSecrets");
      const names =
        uploaded || current === "successor"
          ? expectedWorkerSecrets(selected)
          : (input.storeSecrets ??
            input.predecessorSecrets ??
            expectedWorkerSecrets(selected).filter((name) => name !== ADDED_SECRET));
      return names.map((name) => ({ name, type: "secret_text" }));
    },
  };
  const secretDirectory = join(root, "secret-inputs");
  mkdirSync(secretDirectory, { recursive: true, mode: 0o700 });
  chmodSync(secretDirectory, 0o700);
  for (const [name, value] of [
    [ADDED_SECRET, SEAL_KEYRING_VALUE],
    [ROTATED_SECRET, PROVISIONER_TOKEN_VALUE],
  ] as const) {
    writeFileSync(join(secretDirectory, name), value, { mode: 0o600 });
    chmodSync(join(secretDirectory, name), 0o600);
  }
  return {
    run,
    calls,
    stateCalls,
    state,
    secretDirectory,
    migrations: {
      async read() {
        return {
          local: input.local ?? ["0001_first.sql", "0002_second.sql"],
          applied: input.applied ?? ["0001_first.sql", "0002_second.sql"],
        };
      },
    },
    providerExecutorQualification: qualification(providerExecutorInspection()),
  };
}

function publishedProductFetcher() {
  return async (input: string): Promise<Response> => {
    const pathname = new URL(input).pathname;
    if (pathname === "/.well-known/takoserver") {
      return Response.json({
        product: "takoserver",
        apiVersion: "v1",
        endpoints: {
          api: target.publicOrigin,
          openapi: `${target.publicOrigin}/openapi.json`,
        },
      });
    }
    if (pathname === "/openapi.json") {
      return Response.json({ servers: [{ url: target.publicOrigin }] });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  };
}

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function providerExecutorInspection(
  overrides: Partial<CloudflareProviderExecutorInspection> = {},
): CloudflareProviderExecutorInspection {
  const digest = "8".repeat(64);
  return {
    status: "ready",
    ready: true,
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
    commit: COMMIT,
    bundleDigestHex: digest,
    moduleDigestHex: digest,
    moduleBytes: Uint8Array.from([1, 2, 3]),
    bindingsExact: true,
    secretsExact: true,
    settingsExact: true,
    migrationExact: true,
    ...overrides,
  };
}

function qualification(
  ...inspections: readonly CloudflareProviderExecutorInspection[]
): WorkerProviderExecutorQualification {
  let index = 0;
  return {
    async read() {
      const inspection = inspections[Math.min(index, inspections.length - 1)];
      index += 1;
      if (inspection === undefined) throw new Error("executor qualification fixture is empty");
      return inspection;
    },
  };
}

function withRoot<T>(name: string, body: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), name));
  return body(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

describe("reviewed Worker closure transition", () => {
  test("stages the all-traffic compatibility Worker across only the exact pending 0043 suffix", async () => {
    await withRoot("takoserver-closure-artifact-quiescence-", async (root) => {
      const selected = {
        ...target,
        artifactBlobIoMode: "pre-0043-quiesced" as const,
      } satisfies DeployTarget;
      const pending = [
        "0037_worker_runtime_input_preparation_v2.sql",
        "0038_selfhost_edge_kv.sql",
        "0039_takoform_live_native_claim_across_tenants.sql",
        "0040_selfhost_queues_and_schedules.sql",
        "0041_selfhost_object_buckets.sql",
        "0042_worker_endpoint_origin_reservation_space_id.sql",
        "0043_artifact_blob_io_fences.sql",
      ];
      const parts = fixture(root, {
        selected,
        local: pending,
        applied: [],
        predecessor: { dropVar: "TAKOSERVER_ARTIFACT_BLOB_IO_MODE" },
      });
      const result = await runWorkerClosureTransition(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
          closurePredecessorVersionId: PREDECESSOR,
          delta: {
            ...INTEGRATION_DELTA,
            addedVars: [...INTEGRATION_DELTA.addedVars, "TAKOSERVER_ARTIFACT_BLOB_IO_MODE"],
          },
        },
        selected,
        {
          run: parts.run,
          state: parts.state,
          providerExecutorQualification: parts.providerExecutorQualification,
          migrations: parts.migrations,
          review: "reviewer@example.test",
          secretDirectory: parts.secretDirectory,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          outputDirectory: join(root, "work"),
          fetcher: async () =>
            Response.json(
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
            ),
        },
      );
      expect(result).toMatchObject({
        state: "closure-transition-applied",
        pendingMigrations: pending,
        probe: { status: 503, traffic: "quiesced" },
      });
      expect(parts.calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(1);
    });
  });

  test("status reports the declared delta it would apply without mutating", async () => {
    await withRoot("takoserver-closure-status-", async (root) => {
      const parts = fixture(root);
      const status = await runWorkerClosureTransition(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "status",
          environment: "integration",
          commit: COMMIT,
          closurePredecessorVersionId: PREDECESSOR,
          delta: INTEGRATION_DELTA,
        },
        target,
        {
          run: parts.run,
          state: parts.state,
          providerExecutorQualification: parts.providerExecutorQualification,
          migrations: parts.migrations,
          outputDirectory: join(root, "work"),
        },
      );
      expect(status).toMatchObject({
        kind: "takoserver.worker-closure-transition-status@v1",
        surface: "takoserver-worker-authority-cutover",
        environment: "integration",
        state: "closure-predecessor-current",
        closurePredecessorVersionId: PREDECESSOR,
        versionId: PREDECESSOR,
        deployedCommit: LIVE_COMMIT,
        artifactDigest: `sha256:${LIVE_DIGEST}`,
        cloudflareProviderExecutor: {
          required: true,
          ready: true,
          versionId: "00000000-0000-4000-8000-000000000099",
        },
        mutationApplied: false,
        ready: true,
      });
      expect(status.delta).toEqual({
        retiredVars: [RETIRED_VAR],
        addedVars: [ADDED_VAR],
        refreshedVars: [],
        addedBindings: [ADDED_BINDING],
        addedSecrets: [ADDED_SECRET],
        rotatedSecrets: [ROTATED_SECRET],
      });
      expect(status.carriedSecrets).toEqual(["TAKOSERVER_SIGNING_KEY"]);
      expect(status.secretInputsRequired).toEqual([ADDED_SECRET, ROTATED_SECRET].sort());
      // Status never builds, never uploads and never reads a secret input.
      expect(parts.calls.some((call) => call.includes("--no-bundle"))).toBe(false);
      expect(parts.calls.some((call) => call.includes("--dry-run"))).toBe(false);
    });
  });

  test("refuses an unqualified provider executor before reading or publishing the public Worker", async () => {
    await withRoot("takoserver-closure-executor-unready-", async (root) => {
      const parts = fixture(root);
      const refusal = await runWorkerClosureTransition(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
          closurePredecessorVersionId: PREDECESSOR,
          delta: INTEGRATION_DELTA,
        },
        target,
        {
          run: parts.run,
          state: parts.state,
          providerExecutorQualification: qualification(
            providerExecutorInspection({ status: "stale", ready: false, commit: LIVE_COMMIT }),
          ),
          migrations: parts.migrations,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "deploy-token" },
          outputDirectory: join(root, "work"),
        },
      ).catch((error: unknown) => error);

      expect(refusal).toBeInstanceOf(DeployError);
      expect((refusal as DeployError).phase).toBe("preflight");
      expect((refusal as Error).message).toContain(
        "exact selected-commit Cloudflare provider executor",
      );
      expect(parts.stateCalls).toEqual([]);
      expect(parts.calls).toEqual([]);
    });
  });

  test("re-fences the exact provider executor before upload and after public readback", async () => {
    await withRoot("takoserver-closure-executor-refence-", async (root) => {
      const beforeUpload = fixture(root);
      const changed = providerExecutorInspection({
        deploymentId: "00000000-0000-4000-8000-000000000101",
      });
      const preflightRefusal = await runWorkerClosureTransition(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
          closurePredecessorVersionId: PREDECESSOR,
          delta: INTEGRATION_DELTA,
        },
        target,
        {
          run: beforeUpload.run,
          state: beforeUpload.state,
          providerExecutorQualification: qualification(providerExecutorInspection(), changed),
          migrations: beforeUpload.migrations,
          review: "reviewer@example.test",
          secretDirectory: beforeUpload.secretDirectory,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "deploy-token" },
          outputDirectory: join(root, "before-upload"),
        },
      ).catch((error: unknown) => error);
      expect(preflightRefusal).toBeInstanceOf(DeployError);
      expect((preflightRefusal as DeployError).phase).toBe("preflight");
      expect((preflightRefusal as Error).message).toContain(
        "qualification changed during public Worker publication",
      );
      expect(beforeUpload.calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(0);

      const afterPublication = fixture(root);
      const verificationRefusal = await runWorkerClosureTransition(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
          closurePredecessorVersionId: PREDECESSOR,
          delta: INTEGRATION_DELTA,
        },
        target,
        {
          run: afterPublication.run,
          state: afterPublication.state,
          providerExecutorQualification: qualification(
            providerExecutorInspection(),
            providerExecutorInspection(),
            changed,
          ),
          migrations: afterPublication.migrations,
          review: "reviewer@example.test",
          secretDirectory: afterPublication.secretDirectory,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "deploy-token" },
          outputDirectory: join(root, "after-publication"),
        },
      ).catch((error: unknown) => error);
      expect(verificationRefusal).toBeInstanceOf(DeployError);
      expect((verificationRefusal as DeployError).phase).toBe("verification");
      expect((verificationRefusal as Error).message).toContain(
        "qualification changed during public Worker publication",
      );
      expect(afterPublication.calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(1);
    });
  });

  test("refuses an undeclared difference before any mutation and names it", async () => {
    await withRoot("takoserver-closure-undeclared-", async (root) => {
      const extra = fixture(root, {
        predecessor: { extraVar: "TAKOSERVER_R2_PARENT_ACCESS_KEY_ID" },
      });
      const undeclaredExtra = await runWorkerClosureTransition(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
          closurePredecessorVersionId: PREDECESSOR,
          delta: INTEGRATION_DELTA,
        },
        target,
        {
          run: extra.run,
          state: extra.state,
          providerExecutorQualification: extra.providerExecutorQualification,
          migrations: extra.migrations,
          review: "reviewer@example.test",
          secretDirectory: extra.secretDirectory,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          outputDirectory: join(root, "extra"),
        },
      ).catch((error: unknown) => error);
      expect(undeclaredExtra).toBeInstanceOf(DeployError);
      const extraError = undeclaredExtra as DeployError;
      expect(extraError.phase).toBe("preflight");
      expect(extraError.message).toContain("outside the declared delta");
      expect(extraError.detail).toContain("TAKOSERVER_R2_PARENT_ACCESS_KEY_ID");
      expect(extra.calls.some((call) => call.includes("--no-bundle"))).toBe(false);

      const missing = fixture(root, { predecessor: { dropVar: "TAKOSERVER_EDGE_SUPPLIES" } });
      const undeclaredMissing = await runWorkerClosureTransition(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "status",
          environment: "integration",
          commit: COMMIT,
          closurePredecessorVersionId: PREDECESSOR,
          delta: INTEGRATION_DELTA,
        },
        target,
        {
          run: missing.run,
          state: missing.state,
          providerExecutorQualification: missing.providerExecutorQualification,
          migrations: missing.migrations,
          outputDirectory: join(root, "missing"),
        },
      ).catch((error: unknown) => error);
      expect(undeclaredMissing).toBeInstanceOf(DeployError);
      expect((undeclaredMissing as DeployError).detail).toContain("TAKOSERVER_EDGE_SUPPLIES");

      const overdeclared = fixture(root);
      const notPresent = await runWorkerClosureTransition(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "status",
          environment: "integration",
          commit: COMMIT,
          closurePredecessorVersionId: PREDECESSOR,
          delta: { ...INTEGRATION_DELTA, retiredVars: [RETIRED_VAR, "TAKOSERVER_ZONES"] },
        },
        target,
        {
          run: overdeclared.run,
          state: overdeclared.state,
          providerExecutorQualification: overdeclared.providerExecutorQualification,
          migrations: overdeclared.migrations,
          outputDirectory: join(root, "overdeclared"),
        },
      ).catch((error: unknown) => error);
      expect(notPresent).toBeInstanceOf(DeployError);
      expect((notPresent as DeployError).detail).toContain("TAKOSERVER_ZONES");
    });
  });

  test("refuses when the pinned predecessor is not the authoritative current Version", async () => {
    await withRoot("takoserver-closure-unpinned-", async (root) => {
      const parts = fixture(root, { current: "unrelated" });
      const refusal = await runWorkerClosureTransition(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
          closurePredecessorVersionId: PREDECESSOR,
          delta: INTEGRATION_DELTA,
        },
        target,
        {
          run: parts.run,
          state: parts.state,
          providerExecutorQualification: parts.providerExecutorQualification,
          migrations: parts.migrations,
          review: "reviewer@example.test",
          secretDirectory: parts.secretDirectory,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          outputDirectory: join(root, "work"),
        },
      ).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(DeployError);
      expect((refusal as DeployError).message).toContain("not the pinned closure predecessor");
      expect(parts.calls.some((call) => call.includes("--no-bundle"))).toBe(false);

      const advanced = fixture(root, { current: "unrelated" });
      const status = await runWorkerClosureTransition(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "status",
          environment: "integration",
          commit: COMMIT,
          closurePredecessorVersionId: PREDECESSOR,
          delta: INTEGRATION_DELTA,
        },
        target,
        {
          run: advanced.run,
          state: advanced.state,
          providerExecutorQualification: advanced.providerExecutorQualification,
          migrations: advanced.migrations,
          outputDirectory: join(root, "advanced"),
        },
      ).catch((error: unknown) => error);
      expect(status).toBeInstanceOf(DeployError);
      expect((status as DeployError).message).toContain(
        "neither the pinned closure predecessor nor its direct successor",
      );
    });
  });

  test("refuses a selector without any declared change", async () => {
    await withRoot("takoserver-closure-empty-", async (root) => {
      const parts = fixture(root);
      const refusal = await runWorkerClosureTransition(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "status",
          environment: "integration",
          commit: COMMIT,
          closurePredecessorVersionId: PREDECESSOR,
          delta: {
            retiredVars: [],
            addedVars: [],
            refreshedVars: [],
            addedBindings: [],
            addedSecrets: [],
            rotatedSecrets: [],
          },
        },
        target,
        {
          run: parts.run,
          state: parts.state,
          providerExecutorQualification: parts.providerExecutorQualification,
          migrations: parts.migrations,
          outputDirectory: join(root, "work"),
        },
      ).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(DeployError);
      expect((refusal as DeployError).message).toContain("non-empty declared delta");
    });
  });

  test("uploads the exact routine closure once, carrying, adding and rotating secrets", async () => {
    await withRoot("takoserver-closure-apply-", async (root) => {
      const work = join(root, "work");
      const parts = fixture(root);
      const result = await runWorkerClosureTransition(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
          closurePredecessorVersionId: PREDECESSOR,
          delta: INTEGRATION_DELTA,
        },
        target,
        {
          run: parts.run,
          state: parts.state,
          providerExecutorQualification: parts.providerExecutorQualification,
          migrations: parts.migrations,
          review: "reviewer@example.test",
          secretDirectory: parts.secretDirectory,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          fetcher: publishedProductFetcher(),
          outputDirectory: work,
        },
      );

      expect(result).toMatchObject({
        kind: "takoserver.worker-closure-transition-apply@v1",
        surface: "takoserver-worker-authority-cutover",
        environment: "integration",
        state: "closure-transition-applied",
        commit: COMMIT,
        reviewer: "reviewer@example.test",
        closurePredecessorVersionId: PREDECESSOR,
        preMutationObservedVersionId: PREDECESSOR,
        previousVersionId: PREDECESSOR,
        versionId: SUCCESSOR,
        deploymentId: "deployment-successor",
        mutationApplied: true,
      });
      expect(result.delta).toEqual({
        retiredVars: [RETIRED_VAR],
        addedVars: [ADDED_VAR],
        refreshedVars: [],
        addedBindings: [ADDED_BINDING],
        addedSecrets: [ADDED_SECRET],
        rotatedSecrets: [ROTATED_SECRET],
      });
      expect(result.carriedSecrets).toEqual(["TAKOSERVER_SIGNING_KEY"]);
      expect(result.rollback).toBe(
        `wrangler versions deploy ${PREDECESSOR}@100% --yes --name ${target.workerName}`,
      );

      // Exactly one upload, and it carried the sealed secrets file.
      const uploads = parts.calls.filter((call) => call.includes("--no-bundle"));
      expect(uploads).toHaveLength(1);
      const upload = uploads[0] as string[];
      expect(upload).toContain("--secrets-file");
      expect(upload[upload.indexOf("--secrets-file") + 1]).toBe(join(work, "release/secrets.json"));

      // The realized closure is byte-identical to the routine surface's.
      const reference = writeWorkerConfig(target, {
        path: join(root, "reference-wrangler.jsonc"),
        main: "worker.js",
        commit: COMMIT,
        workerArtifactDigest: result.bundleDigest as `sha256:${string}`,
      });
      expect(readFileSync(join(work, "release/wrangler.jsonc"), "utf8")).toBe(
        readFileSync(reference, "utf8"),
      );
      const realized = JSON.parse(readFileSync(join(work, "release/wrangler.jsonc"), "utf8")) as {
        vars: Record<string, string>;
        secrets: { required: readonly string[] };
      };
      expect(realized.vars).not.toHaveProperty(RETIRED_VAR);
      expect(realized.vars).toHaveProperty(ADDED_VAR);
      expect(realized.secrets.required).toEqual([...expectedWorkerSecrets(target)]);
      expect(realized.secrets.required).not.toContain("CLOUDFLARE_API_TOKEN");

      // Added and rotated secrets are entered exactly once; carried ones never are.
      const secrets = JSON.parse(
        readFileSync(join(work, "release/secrets.json"), "utf8"),
      ) as Record<string, string>;
      expect(Object.keys(secrets).sort()).toEqual([ADDED_SECRET, ROTATED_SECRET].sort());
      expect(secrets[ADDED_SECRET]).toBe(SEAL_KEYRING_VALUE);
      expect(secrets[ROTATED_SECRET]).toBe(PROVISIONER_TOKEN_VALUE);
      expect(secrets).not.toHaveProperty("CLOUDFLARE_API_TOKEN");

      // Secret bytes never reach argv, the realized config or the result.
      const argv = JSON.stringify(parts.calls);
      expect(argv).not.toContain(SEAL_KEYRING_VALUE);
      expect(argv).not.toContain(PROVISIONER_TOKEN_VALUE);
      expect(readFileSync(join(work, "release/wrangler.jsonc"), "utf8")).not.toContain(
        PROVISIONER_TOKEN_VALUE,
      );
      expect(JSON.stringify(result)).not.toContain(SEAL_KEYRING_VALUE);
      expect(JSON.stringify(result)).not.toContain(PROVISIONER_TOKEN_VALUE);
    });
  });

  test("apply refuses pending 0049 and settles a lost acknowledgement through status", async () => {
    await withRoot("takoserver-closure-pending-", async (root) => {
      const pending = fixture(root, {
        local: [
          "0048_resource_execution_evidence.sql",
          "0049_artifact_consumer_active_resolution.sql",
        ],
        applied: ["0048_resource_execution_evidence.sql"],
      });
      const refusal = await runWorkerClosureTransition(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
          closurePredecessorVersionId: PREDECESSOR,
          delta: INTEGRATION_DELTA,
        },
        target,
        {
          run: pending.run,
          state: pending.state,
          providerExecutorQualification: pending.providerExecutorQualification,
          migrations: pending.migrations,
          review: "reviewer@example.test",
          secretDirectory: pending.secretDirectory,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          outputDirectory: join(root, "pending"),
        },
      ).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(DeployError);
      expect((refusal as DeployError).message).toContain("pending D1 migrations");

      const settled = fixture(root, { current: "successor" });
      const status = await runWorkerClosureTransition(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "status",
          environment: "integration",
          commit: COMMIT,
          closurePredecessorVersionId: PREDECESSOR,
          delta: INTEGRATION_DELTA,
        },
        target,
        {
          run: settled.run,
          state: settled.state,
          providerExecutorQualification: settled.providerExecutorQualification,
          migrations: settled.migrations,
          outputDirectory: join(root, "settled"),
        },
      );
      expect(status).toMatchObject({
        kind: "takoserver.worker-closure-transition-status@v1",
        state: "closure-transition-applied",
        closurePredecessorVersionId: PREDECESSOR,
        versionId: SUCCESSOR,
        previousVersionId: PREDECESSOR,
        mutationApplied: false,
      });
    });
  });

  test("refuses a target that cannot compose before it uploads anything", async () => {
    await withRoot("takoserver-closure-composition-", async (root) => {
      // The live incident: one Cloudflare SupplyContract declared twice, the
      // edge half without `storage.object`. The closure fence cannot see it —
      // both halves are legal plain text — so only composition can.
      const ambiguous = {
        ...target,
        edgeSupplies: edgeSuppliesFixture(EDGE_ONLY_RESOURCE_CLASSES),
      } satisfies DeployTarget;
      const parts = fixture(root);
      const refusal = await runWorkerClosureTransition(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
          closurePredecessorVersionId: PREDECESSOR,
          delta: INTEGRATION_DELTA,
        },
        ambiguous,
        {
          run: parts.run,
          state: parts.state,
          providerExecutorQualification: parts.providerExecutorQualification,
          migrations: parts.migrations,
          review: "reviewer@example.test",
          secretDirectory: parts.secretDirectory,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          outputDirectory: join(root, "work"),
        },
      ).catch((error: unknown) => error);

      expect(refusal).toBeInstanceOf(DeployError);
      const error = refusal as DeployError;
      expect(error.phase).toBe("preflight");
      expect(error.message).toContain("Cloudflare supply contract is ambiguous");
      // Nothing ran at all: not the owner gate, not the build, not the upload.
      expect(parts.calls).toEqual([]);
    });
  });

  test("publishes a changed value of a var both sides already declare", async () => {
    await withRoot("takoserver-closure-refresh-", async (root) => {
      const work = join(root, "work");
      const stale = { [REFRESHED_VAR]: '{"kind":"takoserver.hosted-edge-supplies@v2"}' };
      const parts = fixture(root, { predecessor: { staleVars: stale } });
      const result = await runWorkerClosureTransition(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
          closurePredecessorVersionId: PREDECESSOR,
          delta: { ...INTEGRATION_DELTA, refreshedVars: [REFRESHED_VAR] },
        },
        target,
        {
          run: parts.run,
          state: parts.state,
          providerExecutorQualification: parts.providerExecutorQualification,
          migrations: parts.migrations,
          review: "reviewer@example.test",
          secretDirectory: parts.secretDirectory,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          fetcher: publishedProductFetcher(),
          outputDirectory: work,
        },
      );

      expect(result).toMatchObject({ state: "closure-transition-applied", versionId: SUCCESSOR });
      expect(result.delta).toEqual({
        retiredVars: [RETIRED_VAR],
        addedVars: [ADDED_VAR],
        refreshedVars: [REFRESHED_VAR],
        addedBindings: [ADDED_BINDING],
        addedSecrets: [ADDED_SECRET],
        rotatedSecrets: [ROTATED_SECRET],
      });
      // The upload carries the target's value, not the predecessor's.
      const realized = JSON.parse(readFileSync(join(work, "release/wrangler.jsonc"), "utf8")) as {
        vars: Record<string, string>;
      };
      expect(realized.vars[REFRESHED_VAR]).toBe(JSON.stringify(target.edgeSupplies));
    });
  });

  test("names --refresh-var when a value differs and the declaration does not say so", async () => {
    await withRoot("takoserver-closure-undeclared-value-", async (root) => {
      const stale = { [REFRESHED_VAR]: '{"kind":"takoserver.hosted-edge-supplies@v2"}' };
      const parts = fixture(root, { predecessor: { staleVars: stale } });
      const refusal = await runWorkerClosureTransition(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "status",
          environment: "integration",
          commit: COMMIT,
          closurePredecessorVersionId: PREDECESSOR,
          delta: INTEGRATION_DELTA,
        },
        target,
        {
          run: parts.run,
          state: parts.state,
          providerExecutorQualification: parts.providerExecutorQualification,
          migrations: parts.migrations,
          outputDirectory: join(root, "work"),
        },
      ).catch((error: unknown) => error);

      expect(refusal).toBeInstanceOf(DeployError);
      const error = refusal as DeployError;
      expect(error.message).toContain(`binds ${REFRESHED_VAR} with unexpected text`);
      expect(error.message).toContain(`--refresh-var=${REFRESHED_VAR}`);

      // And a refresh of a var that already matches is a no-op, not a transition.
      const matching = fixture(root);
      const noop = await runWorkerClosureTransition(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "status",
          environment: "integration",
          commit: COMMIT,
          closurePredecessorVersionId: PREDECESSOR,
          delta: { ...INTEGRATION_DELTA, refreshedVars: [REFRESHED_VAR] },
        },
        target,
        {
          run: matching.run,
          state: matching.state,
          providerExecutorQualification: matching.providerExecutorQualification,
          migrations: matching.migrations,
          outputDirectory: join(root, "matching"),
        },
      ).catch((error: unknown) => error);
      expect(noop).toBeInstanceOf(DeployError);
      expect((noop as DeployError).message).toContain(
        "already binds a refreshed var with the exact target value",
      );
      expect((noop as DeployError).detail).toContain(REFRESHED_VAR);
    });
  });

  test("carries a secret a rollback left in the store but off the served Version", async () => {
    await withRoot("takoserver-closure-store-", async (root) => {
      const work = join(root, "work");
      // A rollback leaves the script-level store ahead of the Version it
      // restored: four secrets held, two declared by the Version serving.
      const parts = fixture(root, {
        selected: rollbackTarget,
        predecessor: { dropSecrets: [CARRIED_STORE_SECRET] },
        storeSecrets: expectedWorkerSecrets(rollbackTarget),
      });
      const result = await runWorkerClosureTransition(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
          closurePredecessorVersionId: PREDECESSOR,
          delta: INTEGRATION_DELTA,
        },
        rollbackTarget,
        {
          run: parts.run,
          state: parts.state,
          providerExecutorQualification: parts.providerExecutorQualification,
          migrations: parts.migrations,
          review: "reviewer@example.test",
          secretDirectory: parts.secretDirectory,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          fetcher: publishedProductFetcher(),
          outputDirectory: work,
        },
      );

      expect(result).toMatchObject({ state: "closure-transition-applied", versionId: SUCCESSOR });
      expect(result.carriedStoreSecrets).toEqual([CARRIED_STORE_SECRET, ADDED_SECRET].sort());
      // The named added secret is re-entered; the carried one never is.
      const secrets = JSON.parse(
        readFileSync(join(work, "release/secrets.json"), "utf8"),
      ) as Record<string, string>;
      expect(Object.keys(secrets).sort()).toEqual([ADDED_SECRET, ROTATED_SECRET].sort());
      expect(secrets).not.toHaveProperty(CARRIED_STORE_SECRET);

      // Without the store extras the same declaration is short, as before.
      const bare = fixture(root, {
        selected: rollbackTarget,
        predecessor: { dropSecrets: [CARRIED_STORE_SECRET] },
        storeSecrets: expectedWorkerSecrets(rollbackTarget).filter(
          (name) => name !== CARRIED_STORE_SECRET && name !== ADDED_SECRET,
        ),
      });
      const refusal = await runWorkerClosureTransition(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "status",
          environment: "integration",
          commit: COMMIT,
          closurePredecessorVersionId: PREDECESSOR,
          delta: INTEGRATION_DELTA,
        },
        rollbackTarget,
        {
          run: bare.run,
          state: bare.state,
          providerExecutorQualification: bare.providerExecutorQualification,
          migrations: bare.migrations,
          outputDirectory: join(root, "bare"),
        },
      ).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(DeployError);
      expect((refusal as DeployError).message).toContain("outside the declared delta");
      expect((refusal as DeployError).detail).toContain(CARRIED_STORE_SECRET);
    });
  });
});
