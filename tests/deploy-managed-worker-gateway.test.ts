import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  inspectManagedWorkerGatewayRoute,
  type ManagedWorkerGatewayRoute,
  type ManagedWorkerGatewayRouteState,
  planManagedWorkerGatewayRoute,
  runManagedWorkerGateway,
} from "../scripts/deploy/managed-worker-gateway.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import type { WranglerVersionPublicationLease } from "../scripts/deploy/wrangler-state.ts";

const pattern = "*.app-staging.example.test/*";
const productionPattern = "*.app.example.test/*";
const gatewayScript = "takoserver-dispatch";
const legacyScript = "takosumi";
const stagedVersionId = "11111111-1111-4111-8111-111111111111";
const stagedDeploymentId = "22222222-2222-4222-8222-222222222222";
const currentVersionId = "33333333-3333-4333-8333-333333333333";
const currentDeploymentId = "44444444-4444-4444-8444-444444444444";
const predecessorVersionId = "55555555-5555-4555-8555-555555555555";
const predecessorDeploymentId = "66666666-6666-4666-8666-666666666666";
const rollbackDeploymentId = "77777777-7777-4777-8777-777777777777";
const dispatchNamespaceId = "88888888-8888-4888-8888-888888888888";
const gatewaySource = "export default { fetch() { return new Response('ok'); } };\n";

function target(environment: "integration" | "production"): DeployTarget {
  return {
    kind: "takoserver.deploy-target@v2",
    environment,
    accountId: "a".repeat(32),
    workerName: "takoserver-api",
    d1: { databaseName: "state", databaseId: "00000000-0000-0000-0000-000000000000" },
    r2: { bucketName: "takoserver-objects" },
    publicOrigin: "https://api.example.test",
    cloudflareProviderExecutor: {
      workerName: "takoserver-provider-executor",
      dispatchNamespace: "dispatch",
      dispatchNamespaceId,
      gatewayWorkerName: gatewayScript,
      managedBaseDomain: "app.example.test",
      providerInstallationId: "cloudflare.test",
      receiptAuthorityWorkerName: "takoserver-managed-object-receipts",
      releaseReadbackQualification: {
        schema: "takoserver.cloudflare-wfp-release-readback-qualification@v1",
        dispatchNamespace: "dispatch",
        rehearsalDigest: `sha256:${"9".repeat(64)}`,
      },
    },
    signing: { currentKeyId: "current-key" },
  };
}

class FakeRouteState implements ManagedWorkerGatewayRouteState {
  constructor(readonly routes: ManagedWorkerGatewayRoute[]) {}

  async workerRoutes(): Promise<readonly ManagedWorkerGatewayRoute[]> {
    return this.routes;
  }

  async dispatchNamespace(_name: string): Promise<unknown> {
    return dispatchNamespaceMetadata();
  }
}

function dispatchNamespaceMetadata(): unknown {
  return {
    created_by: "a".repeat(32),
    created_on: "2026-09-04T00:00:00Z",
    modified_by: "a".repeat(32),
    modified_on: "2026-09-04T00:00:00Z",
    namespace_id: dispatchNamespaceId,
    namespace_name: "dispatch",
    script_count: 1,
    trusted_workers: false,
  };
}

class ReadyGatewayState extends FakeRouteState {
  async workerDeployments(): Promise<readonly unknown[]> {
    return [
      {
        id: stagedDeploymentId,
        created_on: "2026-08-31T00:00:00.000Z",
        versions: [{ version_id: stagedVersionId, percentage: 100 }],
      },
    ];
  }

  async workerVersion(_workerName: string, _versionId: string): Promise<unknown> {
    return { resources: { script: { etag: "arbitrary-provider-etag" } } };
  }

  async workerVersionWithModules(_workerName: string, _versionId: string): Promise<unknown> {
    return gatewayVersion(
      "integration",
      "a".repeat(40),
      createHash("sha256").update(gatewaySource).digest("hex"),
      "gateway-code-etag",
      stagedVersionId,
      gatewaySource,
      { deployed: true },
    );
  }

  async workerSettings(): Promise<unknown> {
    return { workers_dev: false, preview_urls: false };
  }
}

class PublishingGatewayState extends FakeRouteState {
  readonly versions = new Map<
    string,
    { commit: string; digest: string; etag: string; source: string }
  >();
  readonly events: string[];
  history: unknown[] = [];

  constructor(routes: ManagedWorkerGatewayRoute[], events: string[]) {
    super(routes);
    this.events = events;
  }

  stage(versionId: string, commit: string, digest: string, source: string): void {
    this.versions.set(versionId, { commit, digest, source, etag: `etag-${versionId}` });
  }

  deploy(versionId: string, deploymentId: string): void {
    const previous = this.history[0];
    this.history = [
      deployment(deploymentId, versionId, "2026-08-31T00:02:00.000Z"),
      ...(previous === undefined ? [] : [previous]),
    ];
  }

  async workerDeployments(): Promise<readonly unknown[]> {
    return this.history;
  }

  async workerVersion(_workerName: string, versionId: string): Promise<unknown> {
    const version = this.versions.get(versionId);
    if (!version) return {};
    return { resources: { script: { etag: version.etag } } };
  }

  async workerVersionWithModules(_workerName: string, versionId: string): Promise<unknown> {
    const version = this.versions.get(versionId);
    if (!version) return {};
    this.events.push("version-readback");
    return gatewayVersion(
      "integration",
      version.commit,
      version.digest,
      version.etag,
      versionId,
      version.source,
      { deployed: this.history.some((entry) => deployedVersionId(entry) === versionId) },
    );
  }

  async workerSettings(): Promise<unknown> {
    return { workers_dev: false, preview_urls: false };
  }
}

class NamespaceSwapDuringBuildGatewayState extends PublishingGatewayState {
  override async dispatchNamespace(): Promise<unknown> {
    return {
      ...(dispatchNamespaceMetadata() as Record<string, unknown>),
      namespace_id: this.events.includes("build")
        ? "99999999-9999-4999-8999-999999999999"
        : dispatchNamespaceId,
    };
  }
}

class MalformedStagedGatewayState extends PublishingGatewayState {
  override async workerVersionWithModules(
    _workerName: string,
    _versionId: string,
  ): Promise<unknown> {
    this.events.push("version-readback");
    return { id: stagedVersionId, annotations: {}, bindings: [], modules: [] };
  }
}

class AnnotatedWrongCodeGatewayState extends PublishingGatewayState {
  override async workerVersionWithModules(workerName: string, versionId: string): Promise<unknown> {
    const value = await super.workerVersionWithModules(workerName, versionId);
    if (!value || typeof value !== "object") return value;
    return {
      ...value,
      modules: [
        {
          name: "worker.js",
          content_type: "application/javascript+module",
          content_base64: Buffer.from(
            "export default { fetch() { return Response.error(); } }",
          ).toString("base64"),
        },
      ],
    };
  }
}

class EtagOnlyStagedGatewayState extends PublishingGatewayState {
  override async workerVersion(_workerName: string, versionId: string): Promise<unknown> {
    const version = this.versions.get(versionId);
    return version ? { resources: { script: { etag: version.digest } } } : {};
  }

  override async workerVersionWithModules(workerName: string, versionId: string): Promise<unknown> {
    const value = await super.workerVersionWithModules(workerName, versionId);
    if (!value || typeof value !== "object") return value;
    const withoutModules = { ...value } as Record<string, unknown>;
    delete withoutModules.modules;
    return withoutModules;
  }
}

class RollbackGatewayState extends ReadyGatewayState {
  readonly versions = new Map<string, unknown>();
  history: unknown[];

  constructor(routes: ManagedWorkerGatewayRoute[]) {
    super(routes);
    this.history = [
      deployment(currentDeploymentId, currentVersionId, "2026-08-31T00:02:00.000Z"),
      deployment(predecessorDeploymentId, predecessorVersionId, "2026-08-31T00:01:00.000Z"),
    ];
    this.versions.set(currentVersionId, { resources: { script: { etag: "broken-etag" } } });
    this.versions.set(
      predecessorVersionId,
      gatewayVersion(
        "production",
        "9".repeat(40),
        createHash("sha256").update(gatewaySource).digest("hex"),
        "predecessor-etag",
        predecessorVersionId,
        gatewaySource,
      ),
    );
  }

  override async workerDeployments(): Promise<readonly unknown[]> {
    return this.history;
  }

  override async workerVersion(_workerName: string, versionId: string): Promise<unknown> {
    const version = this.versions.get(versionId);
    if (!version) return {};
    return isGatewayVersion(version) ? { resources: version.resources } : version;
  }

  override async workerVersionWithModules(
    _workerName: string,
    versionId: string,
  ): Promise<unknown> {
    return this.versions.get(versionId) ?? {};
  }

  deployPredecessor(): void {
    this.history = [
      deployment(rollbackDeploymentId, predecessorVersionId, "2026-08-31T00:03:00.000Z"),
      deployment(currentDeploymentId, currentVersionId, "2026-08-31T00:02:00.000Z"),
      deployment(predecessorDeploymentId, predecessorVersionId, "2026-08-31T00:01:00.000Z"),
    ];
  }
}

function deployment(id: string, versionId: string, createdOn: string): unknown {
  return { id, created_on: createdOn, versions: [{ version_id: versionId, percentage: 100 }] };
}

function deployedVersionId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const versions = (value as { readonly versions?: unknown }).versions;
  if (!Array.isArray(versions) || versions.length !== 1) return null;
  const version = versions[0];
  return version && typeof version === "object" && typeof version.version_id === "string"
    ? version.version_id
    : null;
}

function isGatewayVersion(value: unknown): value is { readonly resources: unknown } {
  return !!value && typeof value === "object" && "resources" in value;
}

function gatewayVersion(
  environment: "integration" | "production",
  commit: string,
  digest: string,
  etag: string,
  versionId: string,
  source: string,
  input: { readonly deployed?: boolean; readonly extraBindings?: readonly unknown[] } = {},
): unknown {
  return {
    id: versionId,
    annotations: {
      "workers/message": `takoserver-managed-worker-gateway:${commit}:${digest}`,
    },
    main_module: "worker.js",
    compatibility_date: "2026-08-31",
    compatibility_flags: ["nodejs_compat"],
    ...(input.deployed === true
      ? { migration_tag: "v1", migrations: {} }
      : {
          migrations: {
            new_tag: "v1",
            steps: [{ new_sqlite_classes: ["TakoserverManagedWorkerSqlite"] }],
          },
        }),
    modules: [
      {
        name: "worker.js",
        content_type: "application/javascript+module",
        content_base64: Buffer.from(source).toString("base64"),
      },
    ],
    bindings: [
      {
        name: "STATE_DB",
        type: "d1",
        database_id: "00000000-0000-0000-0000-000000000000",
      },
      { name: "DISPATCHER", type: "dispatch_namespace", namespace: "dispatch" },
      {
        name: "SQLITE_DATABASES",
        type: "durable_object_namespace",
        class_name: "TakoserverManagedWorkerSqlite",
      },
      { name: "MANAGED_PROVIDER_ID", type: "plain_text", text: "provider" },
      {
        name: "TAKOSERVER_MANAGED_WORKER_GATEWAY_ID",
        type: "plain_text",
        text: "gateway",
      },
      { name: "TAKOSERVER_ENVIRONMENT", type: "plain_text", text: environment },
      ...(input.extraBindings ?? []),
    ],
    resources: {
      script: { etag },
    },
  };
}

function publicationLease(): WranglerVersionPublicationLease {
  return {
    accountId: "a".repeat(32),
    workerName: gatewayScript,
    async release() {},
  };
}

function writeWranglerEvent(
  options: { readonly env?: Readonly<Record<string, string>> } | undefined,
  event: Readonly<Record<string, unknown>>,
): void {
  const path = options?.env?.WRANGLER_OUTPUT_FILE_PATH;
  if (!path) throw new Error("test runner did not receive WRANGLER_OUTPUT_FILE_PATH");
  writeFileSync(path, `${JSON.stringify(event)}\n`);
}

function gatewayPublicationRunner(
  state: PublishingGatewayState,
  events: string[],
  commit: string,
  input: { readonly loseDeploymentAck?: boolean } = {},
) {
  return async (
    command: readonly string[],
    options?: {
      readonly env?: Readonly<Record<string, string>>;
      readonly input?: string;
    },
  ): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => {
    const joined = command.join(" ");
    if (joined === "git rev-parse HEAD") return { exitCode: 0, stdout: `${commit}\n`, stderr: "" };
    if (joined === "git branch --show-current") {
      return { exitCode: 0, stdout: "feature/gateway\n", stderr: "" };
    }
    if (command[0] === "git" && command[1] === "status") {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (joined === "bun run check") {
      events.push("check");
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (command.includes("--dry-run")) {
      const outdirIndex = command.indexOf("--outdir");
      const outdir = outdirIndex >= 0 ? command[outdirIndex + 1] : undefined;
      if (!outdir) throw new Error("test runner did not receive an outdir");
      writeFileSync(join(outdir, "worker.js"), gatewaySource);
      events.push("build");
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (command.includes("--no-bundle")) {
      events.push("stage");
      const configIndex = command.indexOf("--config");
      const configPath = configIndex >= 0 ? command[configIndex + 1] : undefined;
      if (!configPath) throw new Error("test runner did not receive an upload config");
      const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
      expect(config.migrations).toEqual([
        {
          tag: "v1",
          new_sqlite_classes: ["TakoserverManagedWorkerSqlite"],
        },
      ]);
      const messageIndex = command.indexOf("--message");
      const message = messageIndex >= 0 ? command[messageIndex + 1] : undefined;
      const digest = message?.split(":")[2];
      if (!digest) throw new Error("test runner did not receive an upload digest");
      if (typeof config.main !== "string") {
        throw new Error("test runner did not receive an upload main module");
      }
      const source = readFileSync(join(dirname(configPath), config.main), "utf8");
      state.stage(stagedVersionId, commit, digest, source);
      writeWranglerEvent(options, {
        type: "version-upload",
        version: 1,
        worker_name: gatewayScript,
        worker_name_overridden: false,
        version_id: stagedVersionId,
      });
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (command.includes("versions") && command.includes("deploy")) {
      events.push("deploy");
      state.deploy(stagedVersionId, stagedDeploymentId);
      if (input.loseDeploymentAck === true) {
        return { exitCode: 1, stdout: "", stderr: "connection reset" };
      }
      writeWranglerEvent(options, {
        type: "version-deploy",
        version: 1,
        worker_name: gatewayScript,
        deployment_id: stagedDeploymentId,
        version_traffic: { [stagedVersionId]: 100 },
      });
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected command: ${joined}`);
  };
}

function gatewayReadyRunner(commit: string) {
  return async (
    command: readonly string[],
  ): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => {
    const joined = command.join(" ");
    if (joined === "git rev-parse HEAD") return { exitCode: 0, stdout: `${commit}\n`, stderr: "" };
    if (joined === "git branch --show-current") {
      return { exitCode: 0, stdout: "feature/gateway\n", stderr: "" };
    }
    if (command[0] === "git" && command[1] === "status") {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (joined === "bun run check") return { exitCode: 0, stdout: "", stderr: "" };
    if (command.includes("--dry-run")) {
      const outdirIndex = command.indexOf("--outdir");
      const outdir = outdirIndex >= 0 ? command[outdirIndex + 1] : undefined;
      if (!outdir) throw new Error("test runner did not receive an outdir");
      writeFileSync(join(outdir, "worker.js"), gatewaySource);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    throw new Error(`exact current gateway must not publish: ${joined}`);
  };
}

test("exact-pattern inspection ignores specific customer routes and plans integration creation", () => {
  const routes: ManagedWorkerGatewayRoute[] = [
    {
      zoneId: "zone",
      id: "specific",
      pattern: "tenant.app-staging.example.test/*",
      script: "customer",
    },
  ];
  const inspection = inspectManagedWorkerGatewayRoute(routes, {
    pattern,
    gatewayScript,
    legacyScript,
    zoneId: "zone",
  });
  expect(inspection.status).toBe("absent");
  expect(planManagedWorkerGatewayRoute(inspection, { environment: "integration" })).toEqual({
    action: "create",
    reason: "create the exact integration route",
    targetScript: gatewayScript,
  });
});

test("portable owner check includes gateway types, TypeScript, and dry-run artifact build", () => {
  const packageJson = JSON.parse(
    readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"),
  ) as {
    readonly scripts: Readonly<Record<string, string>>;
  };
  expect(packageJson.scripts["check:managed-worker-gateway-types"]).toContain(
    "wrangler types managed-worker-gateway-worker-configuration.d.ts --check",
  );
  expect(packageJson.scripts["typecheck:managed-worker-gateway"]).toBe(
    "tsc --noEmit -p tsconfig.managed-worker-gateway.json",
  );
  expect(packageJson.scripts["build:managed-worker-gateway"]).toContain(
    "wrangler deploy --dry-run --strict",
  );
  expect(packageJson.scripts.check).toContain("bun run check:managed-worker-gateway-types");
  expect(packageJson.scripts.check).toContain("bun run typecheck:managed-worker-gateway");
  expect(packageJson.scripts.check).toContain("bun run build:managed-worker-gateway");
});

test("production adoption and reversal are fenced to the exact legacy route", () => {
  const legacy: ManagedWorkerGatewayRoute = {
    zoneId: "zone",
    id: "route",
    pattern: productionPattern,
    script: legacyScript,
  };
  const adopted: ManagedWorkerGatewayRoute = { ...legacy, script: gatewayScript };
  const before = inspectManagedWorkerGatewayRoute([legacy], {
    pattern: productionPattern,
    gatewayScript,
    legacyScript,
  });
  expect(before.status).toBe("legacy-adoptable");
  expect(planManagedWorkerGatewayRoute(before, { environment: "production" }).action).toBe("adopt");
  const after = inspectManagedWorkerGatewayRoute([adopted], {
    pattern: productionPattern,
    gatewayScript,
    legacyScript,
  });
  expect(after.status).toBe("ready");
  expect(
    planManagedWorkerGatewayRoute(after, { environment: "production", reverse: true }),
  ).toMatchObject({
    action: "reverse",
    targetScript: legacyScript,
  });
});

test("duplicate or unknown exact routes refuse mutation", () => {
  const duplicate = inspectManagedWorkerGatewayRoute(
    [
      { zoneId: "zone-a", id: "a", pattern, script: gatewayScript },
      { zoneId: "zone-b", id: "b", pattern, script: gatewayScript },
    ],
    { pattern, gatewayScript, legacyScript },
  );
  expect(duplicate.status).toBe("ambiguous");
  expect(planManagedWorkerGatewayRoute(duplicate, { environment: "integration" }).action).toBe(
    "refuse",
  );
  const drift = inspectManagedWorkerGatewayRoute(
    [{ zoneId: "zone", id: "route", pattern, script: "unknown" }],
    { pattern, gatewayScript, legacyScript },
  );
  expect(drift.status).toBe("drift");
  expect(planManagedWorkerGatewayRoute(drift, { environment: "integration" }).action).toBe(
    "refuse",
  );
});

test("status is read-only while apply requires an independent reviewer", async () => {
  const routeState = new FakeRouteState([]);
  const status = await runManagedWorkerGateway(
    {
      surface: "takoserver-managed-worker-gateway",
      action: "status",
      environment: "integration",
      commit: "a".repeat(40),
    },
    target("integration"),
    {
      state: routeState,
      routePattern: pattern,
      gatewayScript,
      legacyScript,
      zoneId: "zone",
    },
  );
  expect(status).toMatchObject({ routeStatus: "absent", workerStatus: "unavailable" });

  const failure = await runManagedWorkerGateway(
    {
      surface: "takoserver-managed-worker-gateway",
      action: "apply",
      environment: "integration",
      commit: "a".repeat(40),
    },
    target("integration"),
    {
      state: routeState,
      routePattern: pattern,
      gatewayScript,
      legacyScript,
      zoneId: "zone",
      providerId: "provider",
      gatewayId: "gateway",
    },
  ).catch((error) => error);
  expect(failure).toMatchObject({ phase: "preflight" });
  expect(failure.message).toContain("TAKOSERVER_INDEPENDENT_REVIEW");
});

test("gateway requires the target namespace id and ignores a caller namespace override", async () => {
  const selected = target("integration");
  const topology = selected.cloudflareProviderExecutor;
  if (!topology) throw new Error("missing topology");
  const { dispatchNamespaceId: _dispatchNamespaceId, ...bootstrapTopology } = topology;
  const bootstrapTarget: DeployTarget = {
    ...selected,
    cloudflareProviderExecutor: bootstrapTopology,
  };
  await expect(
    runManagedWorkerGateway(
      {
        surface: "takoserver-managed-worker-gateway",
        action: "status",
        environment: "integration",
        commit: "a".repeat(40),
      },
      bootstrapTarget,
      {
        state: new FakeRouteState([]),
        routePattern: pattern,
        gatewayScript,
        legacyScript,
        zoneId: "zone",
      },
    ),
  ).rejects.toThrow("explicit target id pin");

  const seen: string[] = [];
  const state = new FakeRouteState([]);
  state.dispatchNamespace = async (name: string) => {
    seen.push(name);
    return dispatchNamespaceMetadata();
  };
  const status = await runManagedWorkerGateway(
    {
      surface: "takoserver-managed-worker-gateway",
      action: "status",
      environment: "integration",
      commit: "a".repeat(40),
    },
    selected,
    {
      state,
      routePattern: pattern,
      gatewayScript,
      legacyScript,
      zoneId: "zone",
      dispatchNamespace: "caller-must-not-control-this",
    } as Parameters<typeof runManagedWorkerGateway>[2],
  );
  expect(seen).toEqual([topology.dispatchNamespace]);
  expect(status).toMatchObject({
    dispatchNamespace: topology.dispatchNamespace,
    dispatchNamespaceId,
  });
});

/**
 * The managed SQLite Durable Object refuses every admin operation without the
 * gateway's `TAKOSERVER_MANAGED_SQLITE_ADMIN_SECRET`, and an operator
 * provisions that secret out of band. So the readback must recognise it —
 * without letting anything else through.
 */
test("the gateway closure recognises the provisioned SQLite admin secret and nothing else", async () => {
  const withSecret = new (class extends ReadyGatewayState {
    override async workerVersionWithModules(): Promise<unknown> {
      return gatewayVersion(
        "integration",
        "a".repeat(40),
        createHash("sha256").update(gatewaySource).digest("hex"),
        "gateway-code-etag",
        stagedVersionId,
        gatewaySource,
        {
          deployed: true,
          extraBindings: [{ name: "TAKOSERVER_MANAGED_SQLITE_ADMIN_SECRET", type: "secret_text" }],
        },
      );
    }
  })([]);
  expect(
    await runManagedWorkerGateway(
      {
        surface: "takoserver-managed-worker-gateway",
        action: "status",
        environment: "integration",
        commit: "a".repeat(40),
      },
      target("integration"),
      {
        state: withSecret,
        routePattern: pattern,
        gatewayScript,
        legacyScript,
        zoneId: "zone",
        providerId: "provider",
        gatewayId: "gateway",
      },
    ),
  ).toMatchObject({ workerBindingsExact: true });

  const withStranger = new (class extends ReadyGatewayState {
    override async workerVersionWithModules(): Promise<unknown> {
      return gatewayVersion(
        "integration",
        "a".repeat(40),
        createHash("sha256").update(gatewaySource).digest("hex"),
        "gateway-code-etag",
        stagedVersionId,
        gatewaySource,
        {
          deployed: true,
          extraBindings: [{ name: "SOMETHING_ELSE", type: "secret_text" }],
        },
      );
    }
  })([]);
  expect(
    await runManagedWorkerGateway(
      {
        surface: "takoserver-managed-worker-gateway",
        action: "status",
        environment: "integration",
        commit: "a".repeat(40),
      },
      target("integration"),
      {
        state: withStranger,
        routePattern: pattern,
        gatewayScript,
        legacyScript,
        zoneId: "zone",
        providerId: "provider",
        gatewayId: "gateway",
      },
    ),
  ).toMatchObject({ workerStatus: "malformed", workerBindingsExact: false });
});

test("run surface performs injected integration mutation then exact readback", async () => {
  const routeState = new ReadyGatewayState([]);
  const mutations: string[] = [];
  const result = await runManagedWorkerGateway(
    {
      surface: "takoserver-managed-worker-gateway",
      action: "apply",
      environment: "integration",
      commit: "a".repeat(40),
    },
    target("integration"),
    {
      state: routeState,
      routePattern: pattern,
      gatewayScript,
      legacyScript,
      zoneId: "zone",
      providerId: "provider",
      gatewayId: "gateway",
      review: "reviewer",
      run: gatewayReadyRunner("a".repeat(40)),
      mutate: {
        async create(input) {
          mutations.push(`create:${input.zoneId}:${input.pattern}:${input.script}`);
          routeState.routes.push({
            zoneId: input.zoneId,
            id: "new-route",
            pattern: input.pattern,
            script: input.script,
          });
        },
        async update() {
          throw new Error("not expected");
        },
      },
    },
  );
  expect(mutations).toEqual([`create:zone:${pattern}:${gatewayScript}`]);
  expect(result).toMatchObject({
    kind: "takoserver.managed-worker-gateway-apply@v1",
    workerCodeExact: true,
    workerCodeEtag: "arbitrary-provider-etag",
    routeStatus: "ready",
    mutation: "create",
  });
});

test("run surface qualifies, builds, uploads, reads back, then mutates the route", async () => {
  const events: string[] = [];
  const routeState = new PublishingGatewayState([], events);
  const commit = "a".repeat(40);
  const run = gatewayPublicationRunner(routeState, events, commit);
  const result = await runManagedWorkerGateway(
    {
      surface: "takoserver-managed-worker-gateway",
      action: "apply",
      environment: "integration",
      commit,
    },
    target("integration"),
    {
      state: routeState,
      routePattern: pattern,
      gatewayScript,
      legacyScript,
      zoneId: "zone",
      providerId: "provider",
      gatewayId: "gateway",
      review: "reviewer",
      run,
      publicationLease: publicationLease(),
      routeMutationFetcher: async (request) => {
        events.push("route");
        const body = (await request.json()) as {
          readonly pattern: string;
          readonly script: string;
        };
        routeState.routes.push({
          zoneId: "zone",
          id: "route-created",
          pattern: body.pattern,
          script: body.script,
        });
        return Response.json({ success: true, result: { id: "route-created" } });
      },
      cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
    },
  );
  expect(events).toEqual([
    "check",
    "build",
    "stage",
    "version-readback",
    "deploy",
    "version-readback",
    "route",
  ]);
  expect(result).toMatchObject({
    workerReady: true,
    workerVersionId: stagedVersionId,
    workerDeploymentId: stagedDeploymentId,
    workerPreviousVersionId: null,
    workerCodeEtag: `etag-${stagedVersionId}`,
    routeStatus: "ready",
    mutation: "create",
  });
});

test("namespace replacement during build refuses before Version upload or traffic mutation", async () => {
  const events: string[] = [];
  const routeState = new NamespaceSwapDuringBuildGatewayState([], events);
  const commit = "a".repeat(40);
  const failure = await runManagedWorkerGateway(
    {
      surface: "takoserver-managed-worker-gateway",
      action: "apply",
      environment: "integration",
      commit,
    },
    target("integration"),
    {
      state: routeState,
      routePattern: pattern,
      gatewayScript,
      legacyScript,
      zoneId: "zone",
      providerId: "provider",
      gatewayId: "gateway",
      review: "reviewer",
      run: gatewayPublicationRunner(routeState, events, commit),
      publicationLease: publicationLease(),
      routeMutationFetcher: async () => {
        events.push("route");
        return Response.json({ success: true });
      },
      cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
    },
  ).catch((error) => error);
  expect(failure).toMatchObject({ phase: "preflight" });
  expect(failure.message).toContain("dispatch namespace id does not match the target pin");
  expect(events).toEqual(["check", "build"]);
  expect(routeState.versions.size).toBe(0);
  expect(routeState.history).toEqual([]);
  expect(routeState.routes).toEqual([]);
});

test("staged Version readback failure never starts traffic deployment or route mutation", async () => {
  const events: string[] = [];
  const routeState = new MalformedStagedGatewayState([], events);
  const commit = "a".repeat(40);
  const failure = await runManagedWorkerGateway(
    {
      surface: "takoserver-managed-worker-gateway",
      action: "apply",
      environment: "integration",
      commit,
    },
    target("integration"),
    {
      state: routeState,
      routePattern: pattern,
      gatewayScript,
      legacyScript,
      zoneId: "zone",
      providerId: "provider",
      gatewayId: "gateway",
      review: "reviewer",
      run: gatewayPublicationRunner(routeState, events, commit),
      publicationLease: publicationLease(),
      routeMutationFetcher: async () => {
        events.push("route");
        return Response.json({ success: true });
      },
      cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
    },
  ).catch((error) => error);
  expect(failure).toMatchObject({ phase: "mutation" });
  expect(failure.message).toContain("staged Worker Version readback failed");
  expect(events).toEqual(["check", "build", "stage", "version-readback"]);
  expect(routeState.history).toEqual([]);
});

test("self annotation cannot adopt provider-stored code with different bytes", async () => {
  const events: string[] = [];
  const routeState = new AnnotatedWrongCodeGatewayState([], events);
  const commit = "a".repeat(40);
  const failure = await runManagedWorkerGateway(
    {
      surface: "takoserver-managed-worker-gateway",
      action: "apply",
      environment: "integration",
      commit,
    },
    target("integration"),
    {
      state: routeState,
      routePattern: pattern,
      gatewayScript,
      legacyScript,
      zoneId: "zone",
      providerId: "provider",
      gatewayId: "gateway",
      review: "reviewer",
      run: gatewayPublicationRunner(routeState, events, commit),
      publicationLease: publicationLease(),
      cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
    },
  ).catch((error) => error);
  expect(failure).toMatchObject({ phase: "mutation" });
  expect(failure.message).toContain("staged Worker Version readback failed");
  expect(events).toEqual(["check", "build", "stage", "version-readback"]);
  expect(routeState.history).toEqual([]);
});

test("an ETag equal to the local digest cannot replace official module-byte readback", async () => {
  const events: string[] = [];
  const routeState = new EtagOnlyStagedGatewayState([], events);
  const commit = "a".repeat(40);
  const failure = await runManagedWorkerGateway(
    {
      surface: "takoserver-managed-worker-gateway",
      action: "apply",
      environment: "integration",
      commit,
    },
    target("integration"),
    {
      state: routeState,
      routePattern: pattern,
      gatewayScript,
      legacyScript,
      zoneId: "zone",
      providerId: "provider",
      gatewayId: "gateway",
      review: "reviewer",
      run: gatewayPublicationRunner(routeState, events, commit),
      publicationLease: publicationLease(),
      cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
    },
  ).catch((error) => error);
  expect(failure).toMatchObject({ phase: "mutation" });
  expect(failure.message).toContain("staged Worker Version readback failed");
  expect(events).toEqual(["check", "build", "stage", "version-readback"]);
  expect(routeState.history).toEqual([]);
});

test("traffic deployment acknowledgement loss converges without a second deployment", async () => {
  const events: string[] = [];
  const routeState = new PublishingGatewayState([], events);
  const commit = "a".repeat(40);
  const failure = await runManagedWorkerGateway(
    {
      surface: "takoserver-managed-worker-gateway",
      action: "apply",
      environment: "integration",
      commit,
    },
    target("integration"),
    {
      state: routeState,
      routePattern: pattern,
      gatewayScript,
      legacyScript,
      zoneId: "zone",
      providerId: "provider",
      gatewayId: "gateway",
      review: "reviewer",
      run: gatewayPublicationRunner(routeState, events, commit, { loseDeploymentAck: true }),
      publicationLease: publicationLease(),
      cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
    },
  ).catch((error) => error);
  expect(failure).toMatchObject({ phase: "mutation" });
  expect(failure.message).toContain("acknowledgement is indeterminate");
  expect(events).toEqual(["check", "build", "stage", "version-readback", "deploy"]);

  const status = await runManagedWorkerGateway(
    {
      surface: "takoserver-managed-worker-gateway",
      action: "status",
      environment: "integration",
      commit,
    },
    target("integration"),
    {
      state: routeState,
      routePattern: pattern,
      gatewayScript,
      legacyScript,
      zoneId: "zone",
      providerId: "provider",
      gatewayId: "gateway",
    },
  );
  expect(status).toMatchObject({
    workerReady: false,
    workerCodeExact: false,
    workerModuleDigest: createHash("sha256").update(gatewaySource).digest("hex"),
    workerVersionId: stagedVersionId,
    workerDeploymentId: stagedDeploymentId,
    routeStatus: "absent",
    ready: false,
  });

  events.length = 0;
  const recovered = await runManagedWorkerGateway(
    {
      surface: "takoserver-managed-worker-gateway",
      action: "apply",
      environment: "integration",
      commit,
    },
    target("integration"),
    {
      state: routeState,
      routePattern: pattern,
      gatewayScript,
      legacyScript,
      zoneId: "zone",
      providerId: "provider",
      gatewayId: "gateway",
      review: "reviewer",
      run: gatewayPublicationRunner(routeState, events, commit),
      routeMutationFetcher: async (request) => {
        events.push("route");
        const body = (await request.json()) as {
          readonly pattern: string;
          readonly script: string;
        };
        routeState.routes.push({
          zoneId: "zone",
          id: "route-created",
          pattern: body.pattern,
          script: body.script,
        });
        return Response.json({ success: true, result: { id: "route-created" } });
      },
      cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
    },
  );
  expect(recovered).toMatchObject({
    workerReady: true,
    workerCodeExact: true,
    workerVersionId: stagedVersionId,
    workerDeploymentId: stagedDeploymentId,
    mutation: "create",
  });
  expect(events).toEqual(["version-readback", "check", "build", "version-readback", "route"]);
});

test("production reversal restores the exact provider-history predecessor before the route", async () => {
  const adopted: ManagedWorkerGatewayRoute = {
    zoneId: "zone",
    id: "route",
    pattern: productionPattern,
    script: gatewayScript,
  };
  const state = new RollbackGatewayState([adopted]);
  const events: string[] = [];
  const commit = "a".repeat(40);
  const run = async (
    command: readonly string[],
    options?: { readonly env?: Readonly<Record<string, string>>; readonly input?: string },
  ) => {
    const joined = command.join(" ");
    if (joined === "git rev-parse HEAD" || joined === "git rev-parse origin/main") {
      return { exitCode: 0, stdout: `${commit}\n`, stderr: "" };
    }
    if (joined === "git branch --show-current") {
      return { exitCode: 0, stdout: "main\n", stderr: "" };
    }
    if (command[0] === "git" && command[1] === "status") {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (command[0] === "git" && command[1] === "fetch") {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (joined === "bun run check") {
      events.push("check");
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (command.includes("versions") && command.includes("deploy")) {
      expect(command).toContain(`${predecessorVersionId}@100%`);
      events.push("deploy-predecessor");
      state.deployPredecessor();
      writeWranglerEvent(options, {
        type: "version-deploy",
        version: 1,
        worker_name: gatewayScript,
        deployment_id: rollbackDeploymentId,
        version_traffic: { [predecessorVersionId]: 100 },
      });
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected command: ${joined}`);
  };
  const result = await runManagedWorkerGateway(
    {
      surface: "takoserver-managed-worker-gateway",
      action: "apply",
      environment: "production",
      commit,
      reverse: true,
    },
    target("production"),
    {
      state,
      routePattern: productionPattern,
      gatewayScript,
      legacyScript,
      zoneId: "zone",
      providerId: "provider",
      gatewayId: "gateway",
      review: "reviewer",
      run,
      cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
      publicationLease: publicationLease(),
      mutate: {
        async create() {
          throw new Error("not expected");
        },
        async update(update) {
          events.push("route");
          state.routes[0] = { ...adopted, script: update.script };
        },
      },
    },
  );
  expect(events).toEqual(["check", "deploy-predecessor", "route"]);
  expect(result).toMatchObject({
    workerReady: true,
    workerVersionId: predecessorVersionId,
    workerDeploymentId: rollbackDeploymentId,
    workerPreviousVersionId: currentVersionId,
    workerCodeEtag: "predecessor-etag",
    routeStatus: "legacy-adoptable",
    mutation: "reverse",
  });
});

test("run surface uses the concrete Cloudflare route adapter after Worker readback", async () => {
  const routeState = new ReadyGatewayState([]);
  const requests: Request[] = [];
  let requestBody: unknown;
  const result = await runManagedWorkerGateway(
    {
      surface: "takoserver-managed-worker-gateway",
      action: "apply",
      environment: "integration",
      commit: "a".repeat(40),
    },
    target("integration"),
    {
      state: routeState,
      routePattern: pattern,
      gatewayScript,
      legacyScript,
      zoneId: "zone",
      providerId: "provider",
      gatewayId: "gateway",
      review: "reviewer",
      run: gatewayReadyRunner("a".repeat(40)),
      cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
      routeMutationFetcher: async (request) => {
        requests.push(request);
        requestBody = await request.json();
        const body = requestBody as { pattern: string; script: string };
        routeState.routes.push({
          zoneId: "zone",
          id: "route-created",
          pattern: body.pattern,
          script: body.script,
        });
        return Response.json({ success: true, result: { id: "route-created" } });
      },
    },
  );
  expect(result).toMatchObject({ mutation: "create", routeStatus: "ready", workerReady: true });
  expect(requests).toHaveLength(1);
  expect(requests[0]?.method).toBe("POST");
  expect(requests[0]?.url).toContain("/zones/zone/workers/routes");
  expect(requests[0]?.headers.get("authorization")).toBe("Bearer token");
  expect(requestBody).toEqual({ pattern, script: gatewayScript });
});

test("concrete route adapter treats transport loss as indeterminate and never retries", async () => {
  const routeState = new ReadyGatewayState([]);
  const failure = await runManagedWorkerGateway(
    {
      surface: "takoserver-managed-worker-gateway",
      action: "apply",
      environment: "integration",
      commit: "a".repeat(40),
    },
    target("integration"),
    {
      state: routeState,
      routePattern: pattern,
      gatewayScript,
      legacyScript,
      zoneId: "zone",
      providerId: "provider",
      gatewayId: "gateway",
      review: "reviewer",
      run: gatewayReadyRunner("a".repeat(40)),
      cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
      routeMutationFetcher: async () => {
        throw new Error("connection reset after write");
      },
    },
  ).catch((error) => error);
  expect(failure).toMatchObject({ phase: "mutation" });
  expect(failure.message).toContain("acknowledgement is indeterminate");
});
