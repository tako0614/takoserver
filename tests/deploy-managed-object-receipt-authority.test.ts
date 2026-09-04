import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  inspectManagedObjectReceiptAuthority,
  type ManagedObjectReceiptAuthorityState,
  runManagedObjectReceiptAuthority,
} from "../scripts/deploy/managed-object-receipt-authority.ts";
import {
  MANAGED_OBJECT_RECEIPT_SECRET_NAMES,
  materializeManagedObjectReceiptSecrets,
} from "../scripts/deploy/managed-object-receipt-secrets.ts";
import type { CommandResult } from "../scripts/deploy/process.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import type { WranglerVersionPublicationLease } from "../scripts/deploy/wrangler-state.ts";

const REPOSITORY = join(import.meta.dir, "..");
const ACCOUNT_ID = "a".repeat(32);
const WORKER = "takoserver-managed-object-receipt-authority-integration";
const PROVIDER_INSTALLATION = "cloudflare.wfp.integration";
const VERSION = "11111111-1111-4111-8111-111111111111";
const DEPLOYMENT = "22222222-2222-4222-8222-222222222222";
const COMMIT = "c".repeat(40);
const BUNDLE = "export default { fetch() { return new Response(null, { status: 404 }); } };\n";
const SECRET_VALUES = {
  TAKOSERVER_MANAGED_OBJECT_ACCESS_KEY_ID: "receipt-access-key",
  TAKOSERVER_MANAGED_OBJECT_SECRET_ACCESS_KEY: "receipt-secret-access-key",
  TAKOSERVER_MANAGED_OBJECT_PROOF_SECRET: "receipt-proof-secret",
} as const;

function target(environment: "integration" | "rehearsal" | "production"): DeployTarget {
  const dispatchNamespace = `takoserver-customers-${environment}`;
  return {
    kind: "takoserver.deploy-target@v2",
    environment,
    accountId: ACCOUNT_ID,
    workerName: `takoserver-api-${environment}`,
    d1: { databaseName: "state", databaseId: "00000000-0000-0000-0000-000000000000" },
    r2: { bucketName: "objects" },
    publicOrigin: `https://api-${environment}.example.test`,
    cloudflareProviderExecutor: {
      workerName: `takoserver-cloudflare-provider-executor-${environment}`,
      dispatchNamespace,
      gatewayWorkerName: `takoserver-managed-worker-gateway-${environment}`,
      managedBaseDomain: `${environment}.workers.example.test`,
      providerInstallationId: PROVIDER_INSTALLATION,
      receiptAuthorityWorkerName: `takoserver-managed-object-receipt-authority-${environment}`,
      releaseReadbackQualification: {
        schema: "takoserver.cloudflare-wfp-release-readback-qualification@v1",
        dispatchNamespace,
        rehearsalDigest: `sha256:${"9".repeat(64)}`,
      },
    },
    signing: { currentKeyId: "current-key" },
  };
}

function writeSecrets(path: string, value: Readonly<Record<string, string>> = SECRET_VALUES): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function lease(workerName = WORKER): WranglerVersionPublicationLease {
  return {
    accountId: ACCOUNT_ID,
    workerName,
    async release() {},
  };
}

class AuthorityState implements ManagedObjectReceiptAuthorityState {
  private held:
    | { readonly commit: string; readonly digest: string; readonly source: string }
    | undefined;
  private history: readonly unknown[] = [];
  domains: { hostname: string; service: string }[] = [];

  publish(commit: string, digest: string, source: string): void {
    this.held = { commit, digest, source };
    this.history = [
      {
        id: DEPLOYMENT,
        created_on: "2026-09-04T00:00:00.000Z",
        versions: [{ version_id: VERSION, percentage: 100 }],
      },
    ];
  }

  async workerDeployments(): Promise<readonly unknown[]> {
    return this.history;
  }

  async workerVersion(): Promise<unknown> {
    return { id: VERSION, resources: { script: { etag: "etag-authority" } } };
  }

  async workerVersionWithModules(): Promise<unknown> {
    if (!this.held) return {};
    return authorityVersion(this.held);
  }

  async workerSettings(): Promise<unknown> {
    return { workers_dev: false, preview_urls: false };
  }

  async workerSubdomain(): Promise<{
    readonly enabled: boolean;
    readonly previewsEnabled: boolean;
  }> {
    return { enabled: false, previewsEnabled: false };
  }

  async workerRoutes(): Promise<readonly never[]> {
    return [];
  }

  async workerDomains(): Promise<
    readonly { readonly hostname: string; readonly service: string }[]
  > {
    return this.domains;
  }
}

function authorityVersion(held: {
  readonly commit: string;
  readonly digest: string;
  readonly source: string;
}): unknown {
  return {
    id: VERSION,
    annotations: {
      "workers/message": `takoserver-managed-object-receipt-authority:${held.commit}:${held.digest}`,
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
        content_base64: Buffer.from(held.source).toString("base64"),
      },
    ],
    bindings: [
      {
        name: "OBJECT_RECEIPTS",
        type: "durable_object_namespace",
        class_name: "TakoserverManagedObjectReceipt",
      },
      { name: "MANAGED_PROVIDER_ID", type: "plain_text", text: PROVIDER_INSTALLATION },
      {
        name: "TAKOSERVER_MANAGED_OBJECT_ACCOUNT_ID",
        type: "plain_text",
        text: ACCOUNT_ID,
      },
      ...MANAGED_OBJECT_RECEIPT_SECRET_NAMES.map((name) => ({ name, type: "secret_text" })),
    ],
  };
}

function runner(
  state: AuthorityState,
  commands: string[][],
  input: {
    readonly failDeploy?: boolean;
    readonly workerName?: string;
  } = {},
) {
  const workerName = input.workerName ?? WORKER;
  return async (
    command: readonly string[],
    options?: { readonly env?: Readonly<Record<string, string>> },
  ): Promise<CommandResult> => {
    commands.push([...command]);
    const joined = command.join(" ");
    if (joined === "git rev-parse HEAD") return result(`${COMMIT}\n`);
    if (joined === "git branch --show-current") return result("feature/receipt-authority\n");
    if (joined === "git status --porcelain=v1 -z --untracked-files=all") return result("");
    if (joined === "git fetch --quiet --all --prune") return result("");
    if (joined === `git branch -r --contains ${COMMIT}`) {
      return result("  origin/feature/receipt-authority\n");
    }
    if (joined === "bun run check") return result("green\n");
    if (command.includes("--dry-run")) {
      const outdir = command[command.indexOf("--outdir") + 1];
      if (!outdir) throw new Error("authority dry-run omitted its outdir");
      writeFileSync(join(outdir, "worker.js"), BUNDLE);
      return result("built\n");
    }
    if (command[1] === "deploy" && !command.includes("--dry-run")) {
      const secretsFlag = command.flatMap((value, index) =>
        value === "--secrets-file" ? [index] : [],
      );
      expect(secretsFlag).toHaveLength(1);
      const secretsPath = command[(secretsFlag[0] as number) + 1];
      expect(secretsPath).toBeDefined();
      expect(readFileSync(secretsPath as string, "utf8")).toBe(
        `${JSON.stringify(SECRET_VALUES, null, 2)}\n`,
      );
      expect(Number(lstatSync(secretsPath as string).mode & 0o777)).toBe(0o400);
      expect(command.join("\0")).not.toContain(
        SECRET_VALUES.TAKOSERVER_MANAGED_OBJECT_PROOF_SECRET,
      );
      expect(options?.env).not.toHaveProperty("TAKOSERVER_MANAGED_OBJECT_SECRET_ACCESS_KEY");
      if (input.failDeploy) return result("", 1, "connection reset");
      const message = command[command.indexOf("--message") + 1];
      const digest = message?.split(":")[2];
      const configPath = command[command.indexOf("--config") + 1];
      if (!digest || !configPath) throw new Error("authority deploy omitted exact metadata");
      const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
      expect(JSON.stringify(config)).not.toContain("receipt-secret-access-key");
      expect(config).toMatchObject({
        name: workerName,
        workers_dev: false,
        preview_urls: false,
        migrations: [{ tag: "v1", new_sqlite_classes: ["TakoserverManagedObjectReceipt"] }],
      });
      state.publish(COMMIT, digest, readFileSync(join(dirname(configPath), "worker.js"), "utf8"));
      const outputPath = options?.env?.WRANGLER_OUTPUT_FILE_PATH;
      if (!outputPath) throw new Error("authority deploy omitted Wrangler output path");
      writeFileSync(
        outputPath,
        `${JSON.stringify({
          type: "deploy",
          version: 1,
          worker_name: workerName,
          worker_tag: null,
          version_id: VERSION,
          targets: [],
          worker_name_overridden: false,
          timestamp: "2026-09-04T00:00:00.000Z",
        })}\n`,
      );
      return result("deployed\n");
    }
    throw new Error(`unexpected command: ${joined}`);
  };
}

function result(stdout: string, exitCode = 0, stderr = ""): CommandResult {
  return { exitCode, stdout, stderr };
}

test("checked-in configs keep receipt authority route-less and gateway credential-free", () => {
  const authorityConfig = JSON.parse(
    readFileSync(join(REPOSITORY, "wrangler.managed-object-receipt-authority.jsonc"), "utf8"),
  ) as Record<string, unknown>;
  const gatewayConfig = JSON.parse(
    readFileSync(join(REPOSITORY, "wrangler.managed-worker-gateway.jsonc"), "utf8"),
  ) as Record<string, unknown>;
  expect(authorityConfig).toMatchObject({
    workers_dev: false,
    preview_urls: false,
    secrets: { required: MANAGED_OBJECT_RECEIPT_SECRET_NAMES },
    durable_objects: {
      bindings: [{ name: "OBJECT_RECEIPTS", class_name: "TakoserverManagedObjectReceipt" }],
    },
    migrations: [{ tag: "v1", new_sqlite_classes: ["TakoserverManagedObjectReceipt"] }],
  });
  expect(authorityConfig).not.toHaveProperty("routes");
  expect(authorityConfig).not.toHaveProperty("route");
  expect(JSON.stringify(gatewayConfig)).not.toContain("OBJECT_RECEIPTS");
  for (const secretName of MANAGED_OBJECT_RECEIPT_SECRET_NAMES) {
    expect(JSON.stringify(gatewayConfig)).not.toContain(secretName);
  }

  const packageJson = JSON.parse(readFileSync(join(REPOSITORY, "package.json"), "utf8")) as {
    readonly scripts: Readonly<Record<string, string>>;
  };
  expect(packageJson.scripts.check).toContain("check:managed-object-receipt-authority-types");
  expect(packageJson.scripts.check).toContain("typecheck:managed-object-receipt-authority");
  expect(packageJson.scripts.check).toContain("build:managed-object-receipt-authority");
});

test("receipt authority is not ready while an account-level custom domain targets it", async () => {
  const state = new AuthorityState();
  const digest = "d".repeat(64);
  state.publish(COMMIT, digest, BUNDLE);
  state.domains.push({ hostname: "receipt.example.test", service: WORKER });

  await expect(
    inspectManagedObjectReceiptAuthority("preflight", state, {
      scriptName: WORKER,
      providerInstallationId: PROVIDER_INSTALLATION,
      accountId: ACCOUNT_ID,
      commit: COMMIT,
      bundleDigestHex: digest,
    }),
  ).resolves.toMatchObject({ status: "drift", ready: false, routeLess: false });
});

test("secret materialization accepts only the canonical closed private file", () => {
  const sourceRoot = mkdtempSync(join(tmpdir(), "takoserver-receipt-secret-source-"));
  const releaseRoot = mkdtempSync(join(tmpdir(), "takoserver-receipt-secret-release-"));
  const source = join(sourceRoot, "secrets.json");
  try {
    writeSecrets(source);
    const materialized = materializeManagedObjectReceiptSecrets({
      sourcePath: source,
      releaseRoot,
    });
    expect(materialized.names).toEqual(MANAGED_OBJECT_RECEIPT_SECRET_NAMES);
    expect(readFileSync(materialized.path, "utf8")).toBe(
      `${JSON.stringify(SECRET_VALUES, null, 2)}\n`,
    );
    expect(Number(lstatSync(materialized.path).mode & 0o777)).toBe(0o600);
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
    rmSync(releaseRoot, { recursive: true, force: true });
  }
});

test("secret materialization rejects repository output, links, mode, size, and shape drift", () => {
  const sourceRoot = mkdtempSync(join(tmpdir(), "takoserver-receipt-secret-invalid-"));
  const releaseRoot = mkdtempSync(join(tmpdir(), "takoserver-receipt-secret-output-"));
  const repositoryRoot = mkdtempSync(join(REPOSITORY, ".receipt-secret-output-"));
  const source = join(sourceRoot, "secrets.json");
  try {
    writeSecrets(source);
    expect(() =>
      materializeManagedObjectReceiptSecrets({ sourcePath: source, releaseRoot: repositoryRoot }),
    ).toThrow("must stay outside the repository");
    expect(existsSync(join(repositoryRoot, "managed-object-receipt-secrets.json"))).toBe(false);

    chmodSync(source, 0o644);
    expect(() =>
      materializeManagedObjectReceiptSecrets({ sourcePath: source, releaseRoot }),
    ).toThrow("mode-0600");
    chmodSync(source, 0o600);

    const hardlink = join(sourceRoot, "hardlink.json");
    linkSync(source, hardlink);
    expect(() =>
      materializeManagedObjectReceiptSecrets({ sourcePath: source, releaseRoot }),
    ).toThrow("single-link");
    rmSync(hardlink);

    const symlink = join(sourceRoot, "symlink.json");
    symlinkSync(source, symlink);
    expect(() =>
      materializeManagedObjectReceiptSecrets({ sourcePath: symlink, releaseRoot }),
    ).toThrow("link-free");
    rmSync(symlink);

    writeSecrets(source, {
      ...SECRET_VALUES,
      EXTRA_SECRET: "not-allowed",
    });
    expect(() =>
      materializeManagedObjectReceiptSecrets({ sourcePath: source, releaseRoot }),
    ).toThrow("exact closed set");
    expect(existsSync(join(releaseRoot, "managed-object-receipt-secrets.json"))).toBe(false);

    writeFileSync(source, JSON.stringify(SECRET_VALUES), { mode: 0o600 });
    chmodSync(source, 0o600);
    expect(() =>
      materializeManagedObjectReceiptSecrets({ sourcePath: source, releaseRoot }),
    ).toThrow("canonical");

    writeSecrets(source, {
      ...SECRET_VALUES,
      TAKOSERVER_MANAGED_OBJECT_PROOF_SECRET: "x".repeat(17 * 1024),
    });
    expect(() =>
      materializeManagedObjectReceiptSecrets({ sourcePath: source, releaseRoot }),
    ).toThrow("bounded size");

    chmodSync(releaseRoot, 0o755);
    writeSecrets(source);
    expect(() =>
      materializeManagedObjectReceiptSecrets({ sourcePath: source, releaseRoot }),
    ).toThrow("owned mode-0700");
    expect(existsSync(join(releaseRoot, "managed-object-receipt-secrets.json"))).toBe(false);
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
    rmSync(releaseRoot, { recursive: true, force: true });
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("fresh authority publication is atomic and removes its copied secrets from caller output", async () => {
  const sourceRoot = mkdtempSync(join(tmpdir(), "takoserver-receipt-apply-source-"));
  const output = mkdtempSync(join(tmpdir(), "takoserver-receipt-apply-output-"));
  const source = join(sourceRoot, "secrets.json");
  const state = new AuthorityState();
  const commands: string[][] = [];
  writeSecrets(source);
  try {
    const applied = await runManagedObjectReceiptAuthority(
      {
        surface: "takoserver-managed-object-receipt-authority",
        action: "apply",
        environment: "integration",
        commit: COMMIT,
      },
      target("integration"),
      {
        state,
        secretsPath: source,
        outputDirectory: output,
        review: "reviewer@example.test",
        publicationLease: lease(),
        run: runner(state, commands),
      },
    );
    expect(applied).toMatchObject({
      kind: "takoserver.managed-object-receipt-authority-apply@v1",
      workerVersionId: VERSION,
      workerDeploymentId: DEPLOYMENT,
      routeLess: true,
      secretNames: MANAGED_OBJECT_RECEIPT_SECRET_NAMES,
      secretPublication: "atomic-wrangler-secrets-file",
      lifecycle: "v1-created",
      ready: true,
    });
    const publications = commands.filter(
      (command) => command[1] === "deploy" && !command.includes("--dry-run"),
    );
    expect(publications).toHaveLength(1);
    const publication = publications[0] as string[];
    expect(publication[publication.indexOf("--secrets-file") + 1]).toBe(
      join(output, "release", "managed-object-receipt-secrets.json"),
    );
    expect(publication).not.toContain(source);
    expect(commands.some((command) => command.includes("versions"))).toBe(false);
    expect(existsSync(join(output, "release", "managed-object-receipt-secrets.json"))).toBe(false);
    expect(readFileSync(source, "utf8")).toContain("receipt-proof-secret");
    expect(JSON.stringify(applied)).not.toContain("receipt-proof-secret");
    expect(JSON.stringify(applied)).not.toContain(source);
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  }
});

test("failed authority publication preserves the primary error and still removes copied secrets", async () => {
  const sourceRoot = mkdtempSync(join(tmpdir(), "takoserver-receipt-failure-source-"));
  const output = mkdtempSync(join(tmpdir(), "takoserver-receipt-failure-output-"));
  const source = join(sourceRoot, "secrets.json");
  const state = new AuthorityState();
  const commands: string[][] = [];
  writeSecrets(source);
  try {
    const failure = await runManagedObjectReceiptAuthority(
      {
        surface: "takoserver-managed-object-receipt-authority",
        action: "apply",
        environment: "integration",
        commit: COMMIT,
      },
      target("integration"),
      {
        state,
        secretsPath: source,
        outputDirectory: output,
        review: "reviewer@example.test",
        publicationLease: lease(),
        run: runner(state, commands, { failDeploy: true }),
      },
    ).catch((error) => error);
    expect(failure).toMatchObject({ phase: "mutation" });
    expect(failure.message).toContain("acknowledgement is indeterminate");
    expect(failure.message).not.toContain("cleanup failed");
    expect(existsSync(join(output, "release", "managed-object-receipt-secrets.json"))).toBe(false);
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  }
});

test("fresh rehearsal emits evidence that the matching production bootstrap consumes", async () => {
  const sourceRoot = mkdtempSync(join(tmpdir(), "takoserver-receipt-rehearsal-source-"));
  const output = mkdtempSync(join(tmpdir(), "takoserver-receipt-rehearsal-output-"));
  const productionOutput = mkdtempSync(join(tmpdir(), "takoserver-receipt-production-output-"));
  const evidenceRoot = mkdtempSync(join(tmpdir(), "takoserver-receipt-rehearsal-evidence-"));
  const source = join(sourceRoot, "secrets.json");
  const evidence = join(evidenceRoot, "authority-lifecycle.json");
  const workerName = "takoserver-managed-object-receipt-authority-rehearsal";
  const state = new AuthorityState();
  const commands: string[][] = [];
  writeSecrets(source);
  try {
    const applied = await runManagedObjectReceiptAuthority(
      {
        surface: "takoserver-managed-object-receipt-authority",
        action: "apply",
        environment: "rehearsal",
        commit: COMMIT,
      },
      target("rehearsal"),
      {
        state,
        cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "test-token" },
        secretsPath: source,
        outputDirectory: output,
        rehearsalReceiptPath: evidence,
        review: "reviewer@example.test",
        publicationLease: lease(workerName),
        run: runner(state, commands, { workerName }),
      },
    );
    expect(applied.lifecycleRehearsalReceiptDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(Number(lstatSync(evidence).mode & 0o777)).toBe(0o600);
    const evidenceBytes = readFileSync(evidence, "utf8");
    expect(JSON.parse(evidenceBytes)).toMatchObject({
      kind: "takoserver.managed-object-receipt-authority-lifecycle-rehearsal@v1",
      commit: COMMIT,
      predecessorMigrationTag: null,
      migrationTag: "v1",
      className: "TakoserverManagedObjectReceipt",
      mutationTargets: [],
      routeLess: true,
    });
    expect(existsSync(join(output, "release", "managed-object-receipt-secrets.json"))).toBe(false);

    const productionWorker = "takoserver-managed-object-receipt-authority-production";
    const productionState = new AuthorityState();
    const productionCommands: string[][] = [];
    const production = await runManagedObjectReceiptAuthority(
      {
        surface: "takoserver-managed-object-receipt-authority",
        action: "apply",
        environment: "production",
        commit: COMMIT,
      },
      target("production"),
      {
        state: productionState,
        cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "test-token" },
        secretsPath: source,
        outputDirectory: productionOutput,
        rehearsalReceiptPath: evidence,
        review: "reviewer@example.test",
        publicationLease: lease(productionWorker),
        run: runner(productionState, productionCommands, { workerName: productionWorker }),
      },
    );
    expect(production).toMatchObject({
      lifecycle: "v1-created",
      lifecycleRehearsalReceiptDigest: applied.lifecycleRehearsalReceiptDigest,
      routeLess: true,
      ready: true,
    });
    expect(readFileSync(evidence, "utf8")).toBe(evidenceBytes);
    expect(
      productionCommands.filter(
        (command) => command[1] === "deploy" && !command.includes("--dry-run"),
      ),
    ).toHaveLength(1);
    expect(
      existsSync(join(productionOutput, "release", "managed-object-receipt-secrets.json")),
    ).toBe(false);
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
    rmSync(productionOutput, { recursive: true, force: true });
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

test("status never reads secret or lifecycle evidence inputs", async () => {
  const status = await runManagedObjectReceiptAuthority(
    {
      surface: "takoserver-managed-object-receipt-authority",
      action: "status",
      environment: "integration",
      commit: COMMIT,
    },
    target("integration"),
    {
      state: new AuthorityState(),
    },
  );
  expect(status).toMatchObject({
    kind: "takoserver.managed-object-receipt-authority-status@v1",
    workerStatus: "absent",
    ready: false,
  });
});

test("receipt authority fails closed without provider executor topology", async () => {
  const { cloudflareProviderExecutor: _executor, ...withoutExecutor } = target("integration");
  await expect(
    runManagedObjectReceiptAuthority(
      {
        surface: "takoserver-managed-object-receipt-authority",
        action: "status",
        environment: "integration",
        commit: COMMIT,
      },
      withoutExecutor,
      { state: new AuthorityState() },
    ),
  ).rejects.toThrow("requires the exact Cloudflare provider executor topology");
});
