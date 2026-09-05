import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type CloudflareProviderExecutorDependencyInspection,
  type CloudflareProviderExecutorState,
  cloudflareProviderExecutorDependencies,
  inspectCloudflareProviderExecutor,
  planCloudflareProviderExecutor,
  remoteCloudflareProviderExecutorSchema,
  runCloudflareProviderExecutor,
} from "../scripts/deploy/cloudflare-provider-executor.ts";
import {
  CLOUDFLARE_PROVIDER_EXECUTOR_SECRET_NAMES,
  materializeCloudflareProviderExecutorSecrets,
} from "../scripts/deploy/cloudflare-provider-executor-secrets.ts";
import type { CommandResult } from "../scripts/deploy/process.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import type { WranglerVersionPublicationLease } from "../scripts/deploy/wrangler-state.ts";

const REPOSITORY = join(import.meta.dir, "..");
const ACCOUNT_ID = "a".repeat(32);
const COMMIT = "c".repeat(40);
const WORKER = "takoserver-cloudflare-provider-executor-integration";
const GATEWAY = "takoserver-managed-worker-gateway-integration";
const RECEIPTS = "takoserver-managed-object-receipt-authority-integration";
const DISPATCH_NAMESPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VERSION = "11111111-1111-4111-8111-111111111111";
const DEPLOYMENT = "22222222-2222-4222-8222-222222222222";
const PREVIOUS_VERSION = "55555555-5555-4555-8555-555555555555";
const PREVIOUS_DEPLOYMENT = "66666666-6666-4666-8666-666666666666";
const ROLLBACK_DEPLOYMENT = "77777777-7777-4777-8777-777777777777";
const BUNDLE = "export class CloudflareProviderExecutor {}\n";
const SECRETS = {
  CLOUDFLARE_API_TOKEN: "provider-parent-token",
  TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING: "runtime-input-seal-keyring",
} as const;
const DEPENDENCIES: CloudflareProviderExecutorDependencyInspection = {
  ready: true,
  receiptAuthorityReady: true,
  receiptAuthorityVersionId: "33333333-3333-4333-8333-333333333333",
  managedWorkerGatewayReady: true,
  managedWorkerGatewayVersionId: "44444444-4444-4444-8444-444444444444",
};

function target(): DeployTarget {
  return {
    kind: "takoserver.deploy-target@v2",
    environment: "integration",
    accountId: ACCOUNT_ID,
    workerName: "takoserver-api-integration",
    d1: {
      databaseName: "takoserver-runtime-integration",
      databaseId: "00000000-0000-4000-8000-000000000000",
    },
    r2: { bucketName: "takoserver-objects-integration" },
    publicOrigin: "https://api.integration.example.test",
    cloudflareProviderExecutor: {
      workerName: WORKER,
      dispatchNamespace: "takoserver-customers-integration",
      dispatchNamespaceId: DISPATCH_NAMESPACE_ID,
      gatewayWorkerName: GATEWAY,
      managedBaseDomain: "workers.integration.example.test",
      providerInstallationId: "cloudflare.wfp.integration",
      receiptAuthorityWorkerName: RECEIPTS,
    },
    signing: { currentKeyId: "current-key" },
  };
}

class ExecutorState implements CloudflareProviderExecutorState {
  private readonly versions = new Map<
    string,
    { readonly commit: string; readonly digest: string; readonly source: string }
  >();
  private history: readonly unknown[] = [];
  routeOwner: string | null = null;
  driftSettingsAfterRead: number | null = null;
  private settingsReads = 0;

  constructor(private readonly selected: DeployTarget = target()) {}

  publish(commit: string, digest: string, source: string): void {
    const previous = this.history[0];
    this.versions.set(VERSION, { commit, digest, source });
    this.history = [
      deployment(DEPLOYMENT, VERSION, "2026-09-04T00:02:00.000Z"),
      ...(previous === undefined ? [] : [previous]),
    ];
  }

  seedRollback(input: {
    readonly current: { readonly commit: string; readonly source: string };
    readonly previous: { readonly commit: string; readonly source: string };
  }): void {
    this.versions.set(VERSION, {
      ...input.current,
      digest: createHash("sha256").update(input.current.source).digest("hex"),
    });
    this.versions.set(PREVIOUS_VERSION, {
      ...input.previous,
      digest: createHash("sha256").update(input.previous.source).digest("hex"),
    });
    this.history = [
      deployment(DEPLOYMENT, VERSION, "2026-09-04T00:02:00.000Z"),
      deployment(PREVIOUS_DEPLOYMENT, PREVIOUS_VERSION, "2026-09-04T00:01:00.000Z"),
    ];
  }

  restorePrevious(): void {
    this.history = [
      deployment(ROLLBACK_DEPLOYMENT, PREVIOUS_VERSION, "2026-09-04T00:03:00.000Z"),
      deployment(DEPLOYMENT, VERSION, "2026-09-04T00:02:00.000Z"),
      deployment(PREVIOUS_DEPLOYMENT, PREVIOUS_VERSION, "2026-09-04T00:01:00.000Z"),
    ];
  }

  async workerDeployments(workerName: string): Promise<readonly unknown[]> {
    return workerName === WORKER ? this.history : [];
  }

  async workerVersion(): Promise<unknown> {
    return { id: VERSION };
  }

  async workerVersionWithModules(workerName: string, versionId: string): Promise<unknown> {
    const version = this.versions.get(versionId);
    if (workerName !== WORKER || version === undefined) return {};
    return executorVersion(version, versionId, this.selected);
  }

  async workerSettings(): Promise<unknown> {
    this.settingsReads += 1;
    const drifted =
      this.driftSettingsAfterRead !== null && this.settingsReads >= this.driftSettingsAfterRead;
    return { workers_dev: drifted, preview_urls: false };
  }

  async workerSubdomain(): Promise<{
    readonly enabled: boolean;
    readonly previewsEnabled: boolean;
  }> {
    return { enabled: false, previewsEnabled: false };
  }

  async workerRoutes(): Promise<
    readonly {
      readonly zoneId: string;
      readonly id: string;
      readonly pattern: string;
      readonly script: string | null;
    }[]
  > {
    return this.routeOwner === null
      ? []
      : [
          {
            zoneId: "zone",
            id: "route",
            pattern: "executor.example.test/*",
            script: this.routeOwner,
          },
        ];
  }

  async workerDomains(): Promise<
    readonly { readonly hostname: string; readonly service: string }[]
  > {
    return [];
  }

  async workerSecrets(): Promise<readonly unknown[]> {
    return CLOUDFLARE_PROVIDER_EXECUTOR_SECRET_NAMES.map((name) => ({
      name,
      type: "secret_text",
    }));
  }

  async dispatchNamespace(): Promise<unknown> {
    return dispatchNamespaceMetadata();
  }
}

function dispatchNamespaceMetadata(): unknown {
  return dispatchNamespaceMetadataWithId(DISPATCH_NAMESPACE_ID);
}

function dispatchNamespaceMetadataWithId(namespaceId: string): unknown {
  return {
    created_by: "a".repeat(32),
    created_on: "2026-09-04T00:00:00Z",
    modified_by: "a".repeat(32),
    modified_on: "2026-09-04T00:00:00Z",
    namespace_id: namespaceId,
    namespace_name: "takoserver-customers-integration",
    script_count: 1,
    trusted_workers: false,
  };
}

function executorVersion(
  current: {
    readonly commit: string;
    readonly digest: string;
    readonly source: string;
  },
  versionId = VERSION,
  selected = target(),
): unknown {
  const topology = selected.cloudflareProviderExecutor;
  if (!topology) throw new Error("missing topology");
  return {
    id: versionId,
    annotations: {
      "workers/message": `takoserver-cloudflare-provider-executor:${current.commit}:${current.digest}`,
    },
    main_module: "worker.js",
    compatibility_date: "2026-08-31",
    compatibility_flags: ["nodejs_compat"],
    modules: [
      {
        name: "worker.js",
        content_type: "application/javascript+module",
        content_base64: Buffer.from(current.source).toString("base64"),
      },
    ],
    bindings: [
      { name: "STATE_DB", type: "d1", database_id: selected.d1.databaseId },
      { name: "OBJECTS", type: "r2_bucket", bucket_name: selected.r2.bucketName },
      {
        name: "DISPATCHER",
        type: "dispatch_namespace",
        namespace: topology.dispatchNamespace,
      },
      {
        name: "SQLITE_DATABASES",
        type: "durable_object_namespace",
        class_name: "TakoserverManagedWorkerSqlite",
        script_name: topology.gatewayWorkerName,
      },
      {
        name: "MANAGED_WORKER_AUTHORITY",
        type: "service",
        service: topology.gatewayWorkerName,
        entrypoint: "TakoserverManagedWorkerAuthority",
      },
      {
        name: "MANAGED_OBJECT_RECEIPT_AUTHORITY",
        type: "service",
        service: topology.receiptAuthorityWorkerName,
        entrypoint: "TakoserverManagedObjectReceiptAuthority",
      },
      { name: "PUBLIC_ORIGIN", type: "plain_text", text: selected.publicOrigin },
      { name: "CLOUDFLARE_ACCOUNT_ID", type: "plain_text", text: selected.accountId },
      { name: "TAKOSERVER_ENVIRONMENT", type: "plain_text", text: selected.environment },
      { name: "TAKOSERVER_ZONES", type: "plain_text", text: "[]" },
      {
        name: "TAKOSERVER_CLOUDFLARE_DISPATCH_NAMESPACE",
        type: "plain_text",
        text: topology.dispatchNamespace,
      },
      {
        name: "TAKOSERVER_MANAGED_WORKER_GATEWAY_NAME",
        type: "plain_text",
        text: topology.gatewayWorkerName,
      },
      {
        name: "TAKOSERVER_MANAGED_BASE_DOMAIN",
        type: "plain_text",
        text: topology.managedBaseDomain,
      },
      {
        name: "TAKOSERVER_CLOUDFLARE_PROVIDER_INSTALLATION_ID",
        type: "plain_text",
        text: topology.providerInstallationId,
      },
      {
        name: "TAKOSERVER_MANAGED_OBJECT_RECEIPT_AUTHORITY_NAME",
        type: "plain_text",
        text: topology.receiptAuthorityWorkerName,
      },
      ...CLOUDFLARE_PROVIDER_EXECUTOR_SECRET_NAMES.map((name) => ({
        name,
        type: "secret_text",
      })),
    ],
  };
}

function dependencies(ready = true) {
  return {
    async read(): Promise<CloudflareProviderExecutorDependencyInspection> {
      return { ...DEPENDENCIES, ready };
    },
  };
}

function schema(ready = true) {
  return {
    async read() {
      return ready;
    },
  };
}

function writeSecrets(path: string): void {
  writeFileSync(path, `${JSON.stringify(SECRETS, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function lease(): WranglerVersionPublicationLease {
  return { accountId: ACCOUNT_ID, workerName: WORKER, async release() {} };
}

function runner(
  state: ExecutorState,
  commands: { command: string[]; env: Record<string, string> }[],
) {
  return async (
    command: readonly string[],
    options?: { readonly env?: Readonly<Record<string, string>> },
  ): Promise<CommandResult> => {
    commands.push({ command: [...command], env: { ...(options?.env ?? {}) } });
    const joined = command.join(" ");
    if (joined === "git rev-parse HEAD") return result(`${COMMIT}\n`);
    if (joined === "git branch --show-current") return result("feature/provider-executor\n");
    if (joined === "git status --porcelain=v1 -z --untracked-files=all") return result("");
    if (joined === "bun run check") return result("green\n");
    if (command.includes("--dry-run")) {
      const outdir = command[command.indexOf("--outdir") + 1];
      if (!outdir) throw new Error("dry-run omitted output");
      writeFileSync(join(outdir, "worker.js"), BUNDLE);
      expect(options?.env).toEqual({});
      return result("built\n");
    }
    if (command[1] === "deploy" && !command.includes("--dry-run")) {
      const secretPath = command[command.indexOf("--secrets-file") + 1];
      const configPath = command[command.indexOf("--config") + 1];
      const message = command[command.indexOf("--message") + 1];
      if (!secretPath || !configPath || !message) throw new Error("publication closure missing");
      expect(readFileSync(secretPath, "utf8")).toBe(`${JSON.stringify(SECRETS, null, 2)}\n`);
      expect(Number(lstatSync(secretPath).mode & 0o777)).toBe(0o400);
      expect(command.join("\0")).not.toContain(SECRETS.CLOUDFLARE_API_TOKEN);
      expect(options?.env).toEqual(
        expect.objectContaining({ CLOUDFLARE_API_TOKEN: SECRETS.CLOUDFLARE_API_TOKEN }),
      );
      expect(options?.env).not.toHaveProperty("TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING");
      const realized = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
      expect(realized).toMatchObject({
        name: WORKER,
        workers_dev: false,
        preview_urls: false,
      });
      expect(realized).not.toHaveProperty("routes");
      expect(realized).not.toHaveProperty("migrations");
      expect(JSON.stringify(realized)).not.toContain(SECRETS.CLOUDFLARE_API_TOKEN);
      const parts = message.split(":");
      const digest = parts.at(-1);
      if (!digest) throw new Error("publication digest missing");
      state.publish(COMMIT, digest, readFileSync(join(dirname(configPath), "worker.js"), "utf8"));
      const outputPath = options?.env?.WRANGLER_OUTPUT_FILE_PATH;
      if (!outputPath) throw new Error("publication output path missing");
      writeFileSync(
        outputPath,
        `${JSON.stringify({
          type: "deploy",
          version: 1,
          worker_name: WORKER,
          worker_tag: null,
          version_id: VERSION,
          targets: [],
          worker_name_overridden: false,
          timestamp: "2026-09-04T00:02:00.000Z",
        })}\n`,
      );
      return result("deployed\n");
    }
    throw new Error(`unexpected command: ${joined}`);
  };
}

function rollbackRunner(
  state: ExecutorState,
  commands: { command: string[]; env: Record<string, string> }[],
) {
  return async (
    command: readonly string[],
    options?: { readonly env?: Readonly<Record<string, string>> },
  ): Promise<CommandResult> => {
    commands.push({ command: [...command], env: { ...(options?.env ?? {}) } });
    const joined = command.join(" ");
    if (joined === "git rev-parse HEAD") return result(`${COMMIT}\n`);
    if (joined === "git branch --show-current") return result("feature/provider-executor\n");
    if (joined === "git status --porcelain=v1 -z --untracked-files=all") return result("");
    if (joined === "bun run check") return result("green\n");
    if (command[1] === "versions" && command[2] === "deploy") {
      expect(command).toContain(`${PREVIOUS_VERSION}@100%`);
      expect(command).not.toContain("--secrets-file");
      state.restorePrevious();
      const outputPath = options?.env?.WRANGLER_OUTPUT_FILE_PATH;
      if (!outputPath) throw new Error("rollback output path missing");
      writeFileSync(
        outputPath,
        `${JSON.stringify({
          type: "version-deploy",
          version: 1,
          worker_name: WORKER,
          worker_tag: null,
          deployment_id: ROLLBACK_DEPLOYMENT,
          version_traffic: { [PREVIOUS_VERSION]: 100 },
          timestamp: "2026-09-04T00:03:00.000Z",
        })}\n`,
      );
      return result("restored\n");
    }
    throw new Error(`unexpected command: ${joined}`);
  };
}

test("checked-in executor topology is route-less and credential ownership is closed", () => {
  const config = JSON.parse(
    readFileSync(join(REPOSITORY, "wrangler.cloudflare-provider-executor.jsonc"), "utf8"),
  ) as Record<string, unknown>;
  expect(config).toMatchObject({
    workers_dev: false,
    preview_urls: false,
    secrets: { required: CLOUDFLARE_PROVIDER_EXECUTOR_SECRET_NAMES },
  });
  expect(config).not.toHaveProperty("routes");
  expect(config).not.toHaveProperty("route");
  expect(config).not.toHaveProperty("migrations");
  const entry = readFileSync(join(REPOSITORY, "src/entry-cloudflare-provider-executor.ts"), "utf8");
  expect(entry).toContain("export default {};");
  expect(entry).not.toMatch(/export\s+default\s*\{[^}]*fetch/su);

  const packageJson = JSON.parse(readFileSync(join(REPOSITORY, "package.json"), "utf8")) as {
    readonly scripts: Readonly<Record<string, string>>;
  };
  expect(packageJson.scripts.check).toContain("check:cloudflare-provider-executor-types");
  expect(packageJson.scripts.check).toContain("typecheck:cloudflare-provider-executor");
  expect(packageJson.scripts.check).toContain("build:cloudflare-provider-executor");
});

test("executor secrets materialize only from an external canonical owner-only file", () => {
  const sourceRoot = mkdtempSync(join(tmpdir(), "takoserver-executor-secret-source-"));
  const releaseRoot = mkdtempSync(join(tmpdir(), "takoserver-executor-secret-release-"));
  const repositoryRoot = mkdtempSync(join(REPOSITORY, ".executor-secret-output-"));
  const source = join(sourceRoot, "secrets.json");
  try {
    writeSecrets(source);
    const held = materializeCloudflareProviderExecutorSecrets({
      sourcePath: source,
      releaseRoot,
    });
    expect(held.names).toEqual(CLOUDFLARE_PROVIDER_EXECUTOR_SECRET_NAMES);
    expect(Number(lstatSync(held.path).mode & 0o777)).toBe(0o600);
    expect(readFileSync(held.path, "utf8")).toBe(`${JSON.stringify(SECRETS, null, 2)}\n`);
    expect(() =>
      materializeCloudflareProviderExecutorSecrets({
        sourcePath: source,
        releaseRoot: repositoryRoot,
      }),
    ).toThrow("must stay outside the repository");

    writeFileSync(source, `${JSON.stringify({ ...SECRETS, EXTRA: "no" }, null, 2)}\n`);
    expect(() =>
      materializeCloudflareProviderExecutorSecrets({ sourcePath: source, releaseRoot }),
    ).toThrow("exact closed set");
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
    rmSync(releaseRoot, { recursive: true, force: true });
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("executor inspection requires exact code, bindings, settings, secrets and no route", async () => {
  const state = new ExecutorState();
  const digest = createHash("sha256").update(BUNDLE).digest("hex");
  state.publish(COMMIT, digest, BUNDLE);
  const exact = await inspectCloudflareProviderExecutor(
    "preflight",
    state,
    schema(),
    dependencies(),
    target(),
    { commit: COMMIT },
  );
  expect(exact).toMatchObject({
    status: "ready",
    ready: true,
    managedExact: true,
    routeLess: true,
    schemaReady: true,
    bindingsExact: true,
    secretsExact: true,
    settingsExact: true,
    migrationExact: true,
  });
  expect(planCloudflareProviderExecutor(exact, false)).toBe("publish");

  state.routeOwner = WORKER;
  const routed = await inspectCloudflareProviderExecutor(
    "preflight",
    state,
    schema(),
    dependencies(),
    target(),
    { commit: COMMIT },
  );
  expect(routed).toMatchObject({ status: "drift", ready: false, routeLess: false });
  expect(planCloudflareProviderExecutor(routed, false)).toBe("refuse");
});

test("dependency proof enforces receipt authority then the exact managed gateway route", async () => {
  const selected = target();
  const topology = selected.cloudflareProviderExecutor;
  if (!topology) throw new Error("missing topology");
  let gatewayRouteOwner: string | null = GATEWAY;
  let gatewayExtraRoute = false;
  let gatewayCustomDomain = false;
  let receiptCustomDomain = false;
  let observedDispatchNamespaceId = DISPATCH_NAMESPACE_ID;
  const state: CloudflareProviderExecutorState = {
    async dispatchNamespace() {
      return dispatchNamespaceMetadataWithId(observedDispatchNamespaceId);
    },
    async workerDeployments(workerName) {
      if (workerName === RECEIPTS) {
        return [
          deployment(
            "88888888-8888-4888-8888-888888888888",
            DEPENDENCIES.receiptAuthorityVersionId as string,
            "2026-09-04T00:00:00.000Z",
          ),
        ];
      }
      if (workerName === GATEWAY) {
        return [
          deployment(
            "99999999-9999-4999-8999-999999999999",
            DEPENDENCIES.managedWorkerGatewayVersionId as string,
            "2026-09-04T00:01:00.000Z",
          ),
        ];
      }
      return [];
    },
    async workerVersion() {
      return {};
    },
    async workerVersionWithModules(workerName, versionId) {
      return workerName === RECEIPTS
        ? receiptAuthorityVersion(versionId, selected)
        : workerName === GATEWAY
          ? gatewayVersion(versionId, selected)
          : {};
    },
    async workerSettings() {
      return { workers_dev: false, preview_urls: false };
    },
    async workerSubdomain() {
      return { enabled: false, previewsEnabled: false };
    },
    async workerRoutes() {
      const expected =
        gatewayRouteOwner === null
          ? []
          : [
              {
                zoneId: "zone",
                id: "gateway-route",
                pattern: `*.${topology.managedBaseDomain}/*`,
                script: gatewayRouteOwner,
              },
            ];
      return gatewayExtraRoute
        ? [
            ...expected,
            {
              zoneId: "other-zone",
              id: "unexpected-gateway-route",
              pattern: "unexpected.example.test/*",
              script: GATEWAY,
            },
          ]
        : expected;
    },
    async workerDomains() {
      return [
        ...(gatewayCustomDomain ? [{ hostname: "unexpected.example.test", service: GATEWAY }] : []),
        ...(receiptCustomDomain ? [{ hostname: "receipt.example.test", service: RECEIPTS }] : []),
      ];
    },
    async workerSecrets(workerName) {
      return workerName === GATEWAY
        ? [{ name: "TAKOSERVER_MANAGED_SQLITE_ADMIN_SECRET", type: "secret_text" }]
        : [];
    },
  };
  const proof = cloudflareProviderExecutorDependencies(state, selected, COMMIT);
  await expect(proof.read("preflight")).resolves.toMatchObject({
    ready: true,
    receiptAuthorityReady: true,
    managedWorkerGatewayReady: true,
  });
  observedDispatchNamespaceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  await expect(proof.read("preflight")).resolves.toMatchObject({
    ready: false,
  });
  observedDispatchNamespaceId = DISPATCH_NAMESPACE_ID;
  gatewayRouteOwner = "wrong-gateway";
  await expect(proof.read("preflight")).resolves.toMatchObject({
    ready: false,
    receiptAuthorityReady: true,
    managedWorkerGatewayReady: false,
  });
  gatewayRouteOwner = GATEWAY;
  gatewayExtraRoute = true;
  await expect(proof.read("preflight")).resolves.toMatchObject({
    ready: false,
    managedWorkerGatewayReady: false,
  });
  gatewayExtraRoute = false;
  gatewayCustomDomain = true;
  await expect(proof.read("preflight")).resolves.toMatchObject({
    ready: false,
    managedWorkerGatewayReady: false,
  });
  gatewayCustomDomain = false;
  receiptCustomDomain = true;
  await expect(proof.read("preflight")).resolves.toMatchObject({
    ready: false,
    receiptAuthorityReady: false,
    managedWorkerGatewayReady: true,
  });

  const { dispatchNamespaceId: _dispatchNamespaceId, ...bootstrapTopology } = topology;
  const bootstrapTarget: DeployTarget = {
    ...selected,
    cloudflareProviderExecutor: bootstrapTopology,
  };
  await expect(
    cloudflareProviderExecutorDependencies(state, bootstrapTarget, COMMIT).read("preflight"),
  ).rejects.toThrow("explicit target id pin");
});

test("schema proof requires migration 0045 and the exact CAS table and index", async () => {
  const queries: string[] = [];
  const run = async (command: readonly string[]): Promise<CommandResult> => {
    const sql = command[command.indexOf("--command") + 1];
    if (!sql) throw new Error("schema query omitted SQL");
    queries.push(sql);
    const rows = sql.startsWith("SELECT name")
      ? [{ name: "0045_cloudflare_provider_executor_operations.sql" }]
      : sql.startsWith("PRAGMA table_info")
        ? [
            ["operation_id", "TEXT", 1, null, 1],
            ["tenant_id", "TEXT", 1, null, 0],
            ["resource_uid", "TEXT", 1, null, 0],
            ["host_fingerprint", "TEXT", 1, null, 0],
            ["mutation_kind", "TEXT", 1, null, 0],
            ["logical_intent_digest", "TEXT", 1, null, 0],
            ["created_at", "INTEGER", 1, null, 0],
          ].map(([name, type, notnull, dflt_value, pk], cid) => ({
            cid,
            name,
            type,
            notnull,
            dflt_value,
            pk,
          }))
        : ["tenant_id", "resource_uid", "created_at"].map((name, seqno) => ({
            seqno,
            cid: seqno + 1,
            name,
          }));
    return result(JSON.stringify([{ success: true, results: rows }]));
  };
  const reader = remoteCloudflareProviderExecutorSchema(
    "/tmp/provider-executor-wrangler.jsonc",
    { CLOUDFLARE_API_TOKEN: "redacted" },
    run,
  );
  await expect(reader.read("preflight")).resolves.toBe(true);
  expect(queries).toHaveLength(3);
  expect(queries).toContain("PRAGMA table_info('tf_cloudflare_provider_executor_operations')");
  expect(queries).toContain(
    "PRAGMA index_info('tf_cloudflare_provider_executor_operations_resource')",
  );
});

test("executor apply publishes the sealed code and two secrets atomically after dependencies", async () => {
  const state = new ExecutorState();
  const sourceRoot = mkdtempSync(join(tmpdir(), "takoserver-executor-source-"));
  const outputRoot = mkdtempSync(join(tmpdir(), "takoserver-executor-output-"));
  const secretPath = join(sourceRoot, "secrets.json");
  const calls: { command: string[]; env: Record<string, string> }[] = [];
  try {
    writeSecrets(secretPath);
    const resultValue = await runCloudflareProviderExecutor(
      {
        surface: "cloudflare-provider-executor",
        action: "apply",
        environment: "integration",
        commit: COMMIT,
      },
      target(),
      {
        state,
        schema: schema(),
        dependencies: dependencies(),
        secretsPath: secretPath,
        run: runner(state, calls),
        outputDirectory: outputRoot,
        review: "reviewer@example.test",
        publicationLease: lease(),
      },
    );
    expect(resultValue).toMatchObject({
      kind: "takoserver.cloudflare-provider-executor-apply@v1",
      mutation: "create",
      ready: true,
      routeLess: true,
      versionId: VERSION,
      deploymentId: DEPLOYMENT,
      previousVersionId: null,
      secretNames: CLOUDFLARE_PROVIDER_EXECUTOR_SECRET_NAMES,
    });
    expect(
      existsSync(join(outputRoot, "release", "cloudflare-provider-executor-secrets.json")),
    ).toBe(false);
    expect(calls.filter(({ command }) => command.join(" ") === "bun run check")).toHaveLength(1);
    expect(calls.filter(({ command }) => command.includes("--dry-run"))).toHaveLength(1);
    expect(calls.filter(({ command }) => command.includes("--secrets-file"))).toHaveLength(1);
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test("executor refuses publication until schema and dependency order are exact", async () => {
  const state = new ExecutorState();
  const sourceRoot = mkdtempSync(join(tmpdir(), "takoserver-executor-refusal-"));
  const secretPath = join(sourceRoot, "secrets.json");
  const calls: { command: string[]; env: Record<string, string> }[] = [];
  try {
    writeSecrets(secretPath);
    const refusal = await runCloudflareProviderExecutor(
      {
        surface: "cloudflare-provider-executor",
        action: "apply",
        environment: "integration",
        commit: COMMIT,
      },
      target(),
      {
        state,
        schema: schema(false),
        dependencies: dependencies(false),
        secretsPath: secretPath,
        run: runner(state, calls),
        review: "reviewer@example.test",
        publicationLease: lease(),
      },
    ).catch((error: unknown) => error);
    expect((refusal as Error).message).toContain("not an exact managed predecessor");
    expect(calls).toHaveLength(0);
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
  }
});

test("executor reverse restores only the exact provider-history predecessor", async () => {
  const state = new ExecutorState();
  const previousCommit = "d".repeat(40);
  state.seedRollback({
    current: { commit: COMMIT, source: BUNDLE },
    previous: {
      commit: previousCommit,
      source: "export class CloudflareProviderExecutor { previous = true; }\n",
    },
  });
  const sourceRoot = mkdtempSync(join(tmpdir(), "takoserver-executor-rollback-source-"));
  const outputRoot = mkdtempSync(join(tmpdir(), "takoserver-executor-rollback-output-"));
  const secretPath = join(sourceRoot, "secrets.json");
  const calls: { command: string[]; env: Record<string, string> }[] = [];
  try {
    writeSecrets(secretPath);
    const restored = await runCloudflareProviderExecutor(
      {
        surface: "cloudflare-provider-executor",
        action: "apply",
        environment: "integration",
        commit: COMMIT,
        reverse: true,
      },
      target(),
      {
        state,
        schema: schema(),
        dependencies: dependencies(),
        secretsPath: secretPath,
        run: rollbackRunner(state, calls),
        outputDirectory: outputRoot,
        review: "reviewer@example.test",
        publicationLease: lease(),
      },
    );
    expect(restored).toMatchObject({
      mutation: "rollback",
      deployedCommit: previousCommit,
      versionId: PREVIOUS_VERSION,
      deploymentId: ROLLBACK_DEPLOYMENT,
      previousVersionId: VERSION,
      secretPublication: "restored-with-predecessor-version",
      ready: true,
    });
    expect(calls.some(({ command }) => command.includes("--dry-run"))).toBe(false);
    expect(calls.filter(({ command }) => command[1] === "versions")).toHaveLength(1);
    expect(
      existsSync(join(outputRoot, "release", "cloudflare-provider-executor-secrets.json")),
    ).toBe(false);
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test("executor reverse re-fences the full route-less closure before traffic mutation", async () => {
  const state = new ExecutorState();
  state.seedRollback({
    current: { commit: COMMIT, source: BUNDLE },
    previous: {
      commit: "d".repeat(40),
      source: "export class CloudflareProviderExecutor { previous = true; }\n",
    },
  });
  state.driftSettingsAfterRead = 2;
  const sourceRoot = mkdtempSync(join(tmpdir(), "takoserver-executor-rollback-drift-source-"));
  const secretPath = join(sourceRoot, "secrets.json");
  const calls: { command: string[]; env: Record<string, string> }[] = [];
  try {
    writeSecrets(secretPath);
    const failure = await runCloudflareProviderExecutor(
      {
        surface: "cloudflare-provider-executor",
        action: "apply",
        environment: "integration",
        commit: COMMIT,
        reverse: true,
      },
      target(),
      {
        state,
        schema: schema(),
        dependencies: dependencies(),
        secretsPath: secretPath,
        run: rollbackRunner(state, calls),
        review: "reviewer@example.test",
        publicationLease: lease(),
      },
    ).catch((error: unknown) => error);
    expect((failure as Error).message).toContain("re-fence failed");
    expect(calls.filter(({ command }) => command[1] === "versions")).toHaveLength(0);
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
  }
});

function deployment(id: string, versionId: string, createdOn: string): unknown {
  return { id, created_on: createdOn, versions: [{ version_id: versionId, percentage: 100 }] };
}

function receiptAuthorityVersion(versionId: string, selected: DeployTarget): unknown {
  const topology = selected.cloudflareProviderExecutor;
  if (!topology) throw new Error("missing topology");
  const source = "export class TakoserverManagedObjectReceiptAuthority {}\n";
  const digest = createHash("sha256").update(source).digest("hex");
  return {
    id: versionId,
    annotations: {
      "workers/message": `takoserver-managed-object-receipt-authority:${COMMIT}:${digest}`,
    },
    main_module: "worker.js",
    compatibility_date: "2026-08-31",
    compatibility_flags: ["nodejs_compat"],
    migration_tag: "v1",
    migrations: {},
    modules: [
      {
        name: "worker.js",
        content_type: "application/javascript+module",
        content_base64: Buffer.from(source).toString("base64"),
      },
    ],
    bindings: [
      {
        name: "OBJECT_RECEIPTS",
        type: "durable_object_namespace",
        class_name: "TakoserverManagedObjectReceipt",
      },
      {
        name: "MANAGED_PROVIDER_ID",
        type: "plain_text",
        text: topology.providerInstallationId,
      },
      {
        name: "TAKOSERVER_MANAGED_OBJECT_ACCOUNT_ID",
        type: "plain_text",
        text: selected.accountId,
      },
      ...[
        "TAKOSERVER_MANAGED_OBJECT_ACCESS_KEY_ID",
        "TAKOSERVER_MANAGED_OBJECT_SECRET_ACCESS_KEY",
        "TAKOSERVER_MANAGED_OBJECT_PROOF_SECRET",
      ].map((name) => ({ name, type: "secret_text" })),
    ],
  };
}

function gatewayVersion(versionId: string, selected: DeployTarget): unknown {
  const topology = selected.cloudflareProviderExecutor;
  if (!topology) throw new Error("missing topology");
  const source = "export default { fetch() { return new Response('gateway'); } };\n";
  const digest = createHash("sha256").update(source).digest("hex");
  return {
    id: versionId,
    annotations: {
      "workers/message": `takoserver-managed-worker-gateway:${COMMIT}:${digest}`,
    },
    main_module: "worker.js",
    compatibility_date: "2026-08-31",
    compatibility_flags: ["nodejs_compat"],
    migration_tag: "v1",
    migrations: {},
    modules: [
      {
        name: "worker.js",
        content_type: "application/javascript+module",
        content_base64: Buffer.from(source).toString("base64"),
      },
    ],
    bindings: [
      { name: "STATE_DB", type: "d1", database_id: selected.d1.databaseId },
      {
        name: "DISPATCHER",
        type: "dispatch_namespace",
        namespace: topology.dispatchNamespace,
      },
      {
        name: "SQLITE_DATABASES",
        type: "durable_object_namespace",
        class_name: "TakoserverManagedWorkerSqlite",
      },
      { name: "MANAGED_PROVIDER_ID", type: "plain_text", text: "cloudflare" },
      {
        name: "TAKOSERVER_MANAGED_WORKER_GATEWAY_ID",
        type: "plain_text",
        text: "gateway-integration",
      },
      { name: "TAKOSERVER_ENVIRONMENT", type: "plain_text", text: "integration" },
      { name: "TAKOSERVER_MANAGED_SQLITE_ADMIN_SECRET", type: "secret_text" },
    ],
  };
}

function result(stdout: string, exitCode = 0, stderr = ""): CommandResult {
  return { exitCode, stdout, stderr };
}
