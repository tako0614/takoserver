import { describe, expect, test } from "bun:test";
import { CloudflareState } from "../scripts/deploy/cloudflare-state.ts";
import {
  type IntegrationHostRetirementFetcher,
  type IntegrationHostRetirementInvocation,
  type IntegrationHostRetirementState,
  type RetiredIntegrationHostDescriptor,
  runIntegrationHostRetirement,
} from "../scripts/deploy/integration-host-retirement.ts";
import type { CommandResult } from "../scripts/deploy/process.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import { expectedExactBindingClosure } from "../scripts/deploy/worker-state.ts";

const SOURCE_COMMIT = "1".repeat(40);
const CURRENT_DIGEST = "2".repeat(64);
const OLD_COMMIT = "3".repeat(40);
const OLD_DIGEST = "4".repeat(64);
const ACCOUNT_ID = "a".repeat(32);
const OLD_DEPLOYMENT_ID = "d311dcd8-448d-4f80-b6cf-291ea3a7d3c1";
const OLD_VERSION_ID = "511a7b0d-e956-4b75-8cd9-9b19882b171a";
const CURRENT_DEPLOYMENT_ID = "bd516ff8-70b5-49a4-b3b9-10d05aea1081";
const CURRENT_VERSION_ID = "54897e2a-5b91-4b02-bc6e-6642a490026b";
const CURRENT_WORKER = "takoserver-api-integration-next";
const OLD_WORKER = "takoserver-api-integration-old";
const CURRENT_ORIGIN = "https://api.next.integration.example.test";
const OLD_SUFFIX = "integration-account.workers.dev";
const OLD_ORIGIN = `https://${OLD_WORKER}.${OLD_SUFFIX}`;
const OLD_DATABASE_ID = "00000000-0000-4000-8000-000000000041";
const OLD_DATABASE_NAME = "takoserver-runtime-old";
const OLD_BUCKET_NAME = "takoserver-objects-old";
const OLD_SIGNING_KEY_ID = "old-signing-key";
const REVIEWER = "independent-reviewer";

const currentTarget = {
  kind: "takoserver.deploy-target@v2",
  environment: "integration",
  accountId: ACCOUNT_ID,
  workerName: CURRENT_WORKER,
  d1: {
    databaseName: "takoserver-runtime-next",
    databaseId: "00000000-0000-4000-8000-000000000042",
  },
  r2: { bucketName: "takoserver-objects-next" },
  publicOrigin: CURRENT_ORIGIN,
  signing: { currentKeyId: "current-signing-key" },
  integrationE2eCredentialAuthority: {
    organizationId: "org_takosumi_hosted_staging",
    publicJwk: { kty: "OKP", crv: "Ed25519", x: "A".repeat(43) },
  },
} satisfies DeployTarget;

const retiredTarget = {
  kind: "takoserver.deploy-target@v2",
  environment: "integration",
  accountId: ACCOUNT_ID,
  workerName: OLD_WORKER,
  d1: { databaseName: OLD_DATABASE_NAME, databaseId: OLD_DATABASE_ID },
  r2: { bucketName: OLD_BUCKET_NAME },
  publicOrigin: OLD_ORIGIN,
  zones: [{ suffix: "old.integration.example.test", zoneId: "zone-old" }],
  workerEndpointSuffix: OLD_SUFFIX,
  signingKeyId: OLD_SIGNING_KEY_ID,
} satisfies RetiredIntegrationHostDescriptor;

const invocation = {
  action: "apply",
  environment: "integration",
  commit: SOURCE_COMMIT,
  retiredTargetPath: "/operator-private/retired-integration-target.json",
  retiredDeploymentId: OLD_DEPLOYMENT_ID,
  retiredVersionId: OLD_VERSION_ID,
} satisfies IntegrationHostRetirementInvocation;

describe("integration Host retirement", () => {
  test("deletes exactly the pinned old script once, without a query, and keeps public GET unauthenticated", async () => {
    const fixture = applyingFixture();
    const result = await runIntegrationHostRetirement(invocation, currentTarget, fixture.options);

    expect(result).toMatchObject({
      action: "apply",
      environment: "integration",
      retiredWorker: OLD_WORKER,
      retiredDeploymentId: OLD_DEPLOYMENT_ID,
      retiredVersionId: OLD_VERSION_ID,
      retiredScriptAbsent: true,
      successorWorker: CURRENT_WORKER,
      successorDeploymentId: CURRENT_DEPLOYMENT_ID,
      successorVersionId: CURRENT_VERSION_ID,
      publicIdentityReady: true,
      storageTouched: false,
      routesTouched: false,
      namespacesTouched: false,
    });
    expect(fixture.deleteRequests).toHaveLength(1);
    expect(fixture.deleteRequests[0]?.method).toBe("DELETE");
    expect(new URL(fixture.deleteRequests[0]?.url ?? "https://invalid.test").search).toBe("");
    expect(fixture.deleteRequests[0]?.headers.get("authorization")).toBe("Bearer test-token");
    expect(fixture.publicRequests).toHaveLength(3);
    expect(
      fixture.publicRequests.every(
        (request) => request.method === "GET" && request.headers.get("authorization") === null,
      ),
    ).toBe(true);
    expect(fixture.namespaceReads).toEqual([
      "/workers/durable_objects/namespaces",
      "/workers/durable_objects/namespaces",
    ]);
  });

  test("refuses predecessor closure drift at the immediate deletion fence", async () => {
    const fixture = applyingFixture({ driftOldSettingsOnSecondRead: true });

    await expect(
      runIntegrationHostRetirement(invocation, currentTarget, fixture.options),
    ).rejects.toMatchObject({ phase: "preflight" });
    expect(fixture.deleteRequests).toHaveLength(0);
  });

  test("refuses every current Worker role as the retired identity before any state read", async () => {
    const roleTarget = currentTargetWithAllWorkerRoles();
    const roles = [
      roleTarget.workerName,
      roleTarget.sponsorshipAuthority?.workerName,
      roleTarget.cloudflareProviderExecutor?.workerName,
      roleTarget.cloudflareProviderExecutor?.gatewayWorkerName,
      roleTarget.cloudflareProviderExecutor?.receiptAuthorityWorkerName,
      roleTarget.formAuthority?.workerName,
      roleTarget.formAuthority?.identityProbeWorkerName,
      roleTarget.formAuthority?.integrationWorkerName,
      roleTarget.formAuthority?.integrationOperatorWorkerName,
      roleTarget.exactArtifactRecovery?.workerName,
    ].filter((name): name is string => name !== undefined);
    let reads = 0;
    const state = throwingState(() => {
      reads += 1;
    });

    for (const workerName of roles) {
      await expect(
        runIntegrationHostRetirement({ ...invocation, action: "status" }, roleTarget, {
          retiredTarget: {
            ...retiredTarget,
            workerName,
            publicOrigin: `https://${workerName}.${OLD_SUFFIX}`,
          },
          state,
          fetcher: unexpectedFetcher,
        }),
      ).rejects.toMatchObject({ phase: "preflight" });
    }
    expect(reads).toBe(0);
  });

  test("does not retry an unknown delete acknowledgement", async () => {
    const fixture = applyingFixture({ deleteResult: "transport-error" });

    await expect(
      runIntegrationHostRetirement(invocation, currentTarget, fixture.options),
    ).rejects.toMatchObject({
      phase: "mutation",
      message: expect.stringContaining("unknown"),
    });
    expect(fixture.deleteRequests).toHaveLength(1);
  });

  test("labels a post-acknowledgement reader failure as verification", async () => {
    const fixture = applyingFixture({ failWorkerScriptsAfterDelete: true });

    await expect(
      runIntegrationHostRetirement(invocation, currentTarget, fixture.options),
    ).rejects.toMatchObject({
      phase: "verification",
      message: expect.stringContaining("post-delete"),
    });
    expect(fixture.deleteRequests).toHaveLength(1);
  });

  test("labels a discovery reader failure as preflight and never claims an acknowledgement", async () => {
    const state = throwingState();
    let requests = 0;

    await expect(
      runIntegrationHostRetirement({ ...invocation, action: "status" }, currentTarget, {
        retiredTarget,
        state,
        fetcher: async () => {
          requests += 1;
          throw new Error("fetch must not run");
        },
      }),
    ).rejects.toMatchObject({
      phase: "preflight",
      message: expect.not.stringContaining("acknowledged"),
    });
    expect(requests).toBe(0);
  });

  test("reports an already absent old script as retired and apply refuses a second delete", async () => {
    const fixture = applyingFixture({ initiallyDeleted: true });
    const status = await runIntegrationHostRetirement(
      { ...invocation, action: "status" },
      currentTarget,
      fixture.options,
    );
    expect(status).toMatchObject({ action: "status", state: "retired", retiredPresent: false });

    await expect(
      runIntegrationHostRetirement(invocation, currentTarget, fixture.options),
    ).rejects.toMatchObject({
      phase: "preflight",
      message: expect.stringContaining("already absent"),
    });
    expect(fixture.deleteRequests).toHaveLength(0);
  });

  test("uses the exhaustive paginated Durable Object namespace reader contract", async () => {
    const pages: number[] = [];
    const rows = Array.from({ length: 185 }, (_, index) => ({
      id: `namespace-${index}`,
      name: `Namespace${index}`,
      script: null,
    }));
    const state = new CloudflareState({
      accountId: ACCOUNT_ID,
      token: "test-token",
      fetcher: async (request) => {
        const url = new URL(request.url);
        expect(url.pathname).toBe(
          `/client/v4/accounts/${ACCOUNT_ID}/workers/durable_objects/namespaces`,
        );
        expect(url.searchParams.get("per_page")).toBe("100");
        const page = Number(url.searchParams.get("page"));
        pages.push(page);
        const result = page === 1 ? rows.slice(0, 100) : rows.slice(100);
        return Response.json({
          success: true,
          result,
          result_info: {
            page,
            per_page: 100,
            count: result.length,
            total_count: rows.length,
            total_pages: 2,
          },
        });
      },
    });

    expect(
      await state.list(
        "/workers/durable_objects/namespaces",
        "Cloudflare Durable Object namespace inventory",
      ),
    ).toHaveLength(185);
    expect(pages).toEqual([1, 2]);
  });
});

interface ApplyingFixtureOptions {
  readonly driftOldSettingsOnSecondRead?: boolean;
  readonly deleteResult?: "success" | "transport-error";
  readonly failWorkerScriptsAfterDelete?: boolean;
  readonly initiallyDeleted?: boolean;
}

function applyingFixture(options: ApplyingFixtureOptions = {}): {
  readonly options: Parameters<typeof runIntegrationHostRetirement>[2];
  readonly deleteRequests: Request[];
  readonly publicRequests: Request[];
  readonly namespaceReads: string[];
} {
  let deleted = options.initiallyDeleted ?? false;
  let oldSettingsReads = 0;
  const deleteRequests: Request[] = [];
  const publicRequests: Request[] = [];
  const namespaceReads: string[] = [];
  const oldVersion = retiredVersion();
  const successorVersion = currentVersion();
  const state: IntegrationHostRetirementState = {
    async workerScripts() {
      if (deleted && options.failWorkerScriptsAfterDelete) {
        throw new Error("script inventory unavailable after acknowledgement");
      }
      return deleted ? [CURRENT_WORKER] : [CURRENT_WORKER, OLD_WORKER];
    },
    async workerDeployments(workerName) {
      if (workerName === OLD_WORKER) {
        return deleted ? [] : [deployment(OLD_DEPLOYMENT_ID, OLD_VERSION_ID)];
      }
      if (workerName === CURRENT_WORKER) {
        return [deployment(CURRENT_DEPLOYMENT_ID, CURRENT_VERSION_ID)];
      }
      throw new Error(`unexpected deployment read for ${workerName}`);
    },
    async workerVersion(workerName, versionId) {
      if (workerName === OLD_WORKER && versionId === OLD_VERSION_ID) {
        return structuredClone(oldVersion);
      }
      if (workerName === CURRENT_WORKER && versionId === CURRENT_VERSION_ID) {
        return structuredClone(successorVersion);
      }
      throw new Error("unexpected Version read");
    },
    async workerSecrets(workerName) {
      if (workerName === OLD_WORKER) return retiredSecrets();
      if (workerName === CURRENT_WORKER) {
        return [{ name: "TAKOSERVER_SIGNING_KEY", type: "secret_text" }];
      }
      throw new Error("unexpected secret read");
    },
    async workerDomains() {
      return [{ hostname: new URL(CURRENT_ORIGIN).hostname, service: CURRENT_WORKER }];
    },
    async workerSettings(workerName) {
      if (workerName !== OLD_WORKER) throw new Error("unexpected settings read");
      oldSettingsReads += 1;
      return retiredSettings(
        options.driftOldSettingsOnSecondRead === true && oldSettingsReads === 2,
      );
    },
    async workerSchedules(workerName) {
      if (workerName !== OLD_WORKER) throw new Error("unexpected schedule read");
      return ["*/5 * * * *"];
    },
    async workerSubdomain(workerName) {
      if (workerName !== OLD_WORKER) throw new Error("unexpected subdomain read");
      return { enabled: true, previewsEnabled: true };
    },
    async workerAccountSubdomain() {
      return "integration-account";
    },
    async workerRoutes() {
      return [];
    },
    async list(path) {
      namespaceReads.push(path);
      return Array.from({ length: 185 }, (_, index) => ({
        id: `namespace-${index}`,
        name: `Namespace${index}`,
        script: null,
      }));
    },
  };
  const fetcher: IntegrationHostRetirementFetcher = async (request) => {
    if (request.url === `${CURRENT_ORIGIN}/.well-known/takoserver`) {
      publicRequests.push(request);
      return Response.json({
        product: "takoserver",
        apiVersion: "v1",
        endpoints: { api: CURRENT_ORIGIN },
      });
    }
    deleteRequests.push(request);
    if (options.deleteResult === "transport-error") throw new Error("connection reset");
    deleted = true;
    return Response.json({ success: true });
  };
  return {
    deleteRequests,
    publicRequests,
    namespaceReads,
    options: {
      retiredTarget,
      state,
      fetcher,
      run: qualificationProcess,
      review: REVIEWER,
      cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "test-token" },
    },
  };
}

function retiredVersion(): Record<string, unknown> {
  return {
    id: OLD_VERSION_ID,
    annotations: {
      "workers/message": `takoserver-worker:${OLD_COMMIT}:${OLD_DIGEST}`,
      "workers/triggered_by": "version_upload",
    },
    resources: {
      bindings: retiredBindings("name"),
      script: {
        etag: "retired-script-etag",
        handlers: ["fetch", "scheduled"],
        named_handlers: [{ name: "PublicHostIdentityEntrypoint", handlers: ["identity"] }],
      },
      script_runtime: {
        compatibility_date: "2026-08-17",
        compatibility_flags: ["nodejs_compat"],
        usage_model: "standard",
      },
    },
  };
}

function retiredSettings(drift: boolean): Record<string, unknown> {
  return {
    bindings: retiredBindings("binding"),
    workers_dev: true,
    preview_urls: false,
    placement: {},
    tail_consumers: [],
    logpush: false,
    observability: { enabled: !drift },
  };
}

function retiredBindings(nameField: "name" | "binding"): readonly Record<string, unknown>[] {
  const named = (name: string, value: Record<string, unknown>): Record<string, unknown> => ({
    [nameField]: name,
    ...value,
  });
  return [
    named("AI", { type: "ai", project: "default" }),
    named("CLOUDFLARE_ACCOUNT_ID", { type: "plain_text", text: ACCOUNT_ID }),
    named("CLOUDFLARE_API_TOKEN", { type: "secret_text" }),
    named("OBJECTS", { type: "r2_bucket", bucket_name: OLD_BUCKET_NAME }),
    named("OPERATOR_IDENTITY_PUBLIC_JWK", { type: "plain_text", text: "{}" }),
    named("PUBLIC_ORIGIN", { type: "plain_text", text: OLD_ORIGIN }),
    named("STATE_DB", {
      type: "d1",
      database_id: OLD_DATABASE_ID,
      id: OLD_DATABASE_ID,
    }),
    named("TAKOSERVER_AI_MODELS", { type: "plain_text", text: "[]" }),
    named("TAKOSERVER_EDGE_SUPPLIES", { type: "plain_text", text: "[]" }),
    named("TAKOSERVER_ENVIRONMENT", { type: "plain_text", text: "integration" }),
    named("TAKOSERVER_HOSTED_SPONSORSHIP_TOKEN", { type: "secret_text" }),
    named("TAKOSERVER_INTEGRATION_E2E_API_KEY_PUBLIC_JWK", {
      type: "plain_text",
      text: "{}",
    }),
    named("TAKOSERVER_INTEGRATION_E2E_ORGANIZATION_ID", {
      type: "plain_text",
      text: "org_takosumi_hosted_staging",
    }),
    named("TAKOSERVER_OBJECT_BUCKET_SUPPLIES", { type: "plain_text", text: "[]" }),
    named("TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING", { type: "secret_text" }),
    named("TAKOSERVER_SIGNING_KEY", { type: "secret_text" }),
    named("TAKOSERVER_SIGNING_KEY_ID", { type: "plain_text", text: OLD_SIGNING_KEY_ID }),
    named("TAKOSERVER_SOURCE_COMMIT", { type: "plain_text", text: OLD_COMMIT }),
    named("TAKOSERVER_WORKER_ARTIFACT_DIGEST", {
      type: "plain_text",
      text: `sha256:${OLD_DIGEST}`,
    }),
    named("TAKOSERVER_WORKER_ENDPOINT_SUFFIX", { type: "plain_text", text: OLD_SUFFIX }),
    named("TAKOSERVER_ZONES", { type: "plain_text", text: JSON.stringify(retiredTarget.zones) }),
    named("WORKER_VERSION", { type: "version_metadata" }),
  ];
}

function retiredSecrets(): readonly Record<string, unknown>[] {
  return [
    "CLOUDFLARE_API_TOKEN",
    "TAKOSERVER_HOSTED_SPONSORSHIP_TOKEN",
    "TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING",
    "TAKOSERVER_SIGNING_KEY",
  ].map((name) => ({ name, type: "secret_text" }));
}

function currentVersion(): Record<string, unknown> {
  const authorityProfile = {
    kind: "provenance-bound-jit" as const,
    provenance: {
      sourceCommit: SOURCE_COMMIT,
      artifactDigest: `sha256:${CURRENT_DIGEST}` as const,
    },
  };
  const closure = expectedExactBindingClosure(currentTarget, { authorityProfile });
  return {
    id: CURRENT_VERSION_ID,
    annotations: {
      "workers/message": `takoserver-worker:${SOURCE_COMMIT}:${CURRENT_DIGEST}`,
      "workers/triggered_by": "version_upload",
    },
    resources: {
      bindings: Object.entries(closure).flatMap(([name, requirement]) =>
        requirement === null ? [] : [{ name, type: requirement.type, ...requirement.fields }],
      ),
    },
  };
}

function deployment(deploymentId: string, versionId: string): Record<string, unknown> {
  return {
    id: deploymentId,
    created_on: "2026-09-19T20:00:00.000Z",
    versions: [{ version_id: versionId, percentage: 100 }],
  };
}

async function qualificationProcess(command: readonly string[]): Promise<CommandResult> {
  const joined = command.join(" ");
  if (joined === "git rev-parse HEAD") {
    return { exitCode: 0, stdout: `${SOURCE_COMMIT}\n`, stderr: "" };
  }
  if (joined === "git branch --show-current") {
    return { exitCode: 0, stdout: "host-retirement-test\n", stderr: "" };
  }
  if (command[0] === "git" && command[1] === "status") {
    return { exitCode: 0, stdout: "", stderr: "" };
  }
  throw new Error(`unexpected command: ${joined}`);
}

function throwingState(onRead: () => void = () => {}): IntegrationHostRetirementState {
  const fail = async (): Promise<never> => {
    onRead();
    throw new Error("state unavailable");
  };
  return {
    workerScripts: fail,
    workerDeployments: fail,
    workerVersion: fail,
    workerSecrets: fail,
    workerDomains: fail,
    workerSettings: fail,
    workerSchedules: fail,
    workerSubdomain: fail,
    workerAccountSubdomain: fail,
    workerRoutes: fail,
    list: fail,
  };
}

async function unexpectedFetcher(): Promise<Response> {
  throw new Error("fetch must not run");
}

function currentTargetWithAllWorkerRoles(): DeployTarget {
  return {
    ...currentTarget,
    sponsorshipAuthority: { workerName: "current-sponsor" },
    cloudflareProviderExecutor: {
      workerName: "current-provider-executor",
      gatewayWorkerName: "current-gateway",
      receiptAuthorityWorkerName: "current-receipt",
    },
    formAuthority: {
      workerName: "current-form",
      identityProbeWorkerName: "current-form-probe",
      integrationWorkerName: "current-form-fixture",
      integrationOperatorWorkerName: "current-form-operator",
    },
    exactArtifactRecovery: { workerName: "current-exact-recovery" },
  } as unknown as DeployTarget;
}
