import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeployError } from "../scripts/deploy/errors.ts";
import type { IntegrationStorageGenerationTargetVerificationOptions } from "../scripts/deploy/integration-storage-generation.ts";
import {
  type IntegrationWorkerBootstrapOptions,
  type IntegrationWorkerBootstrapSchemaReader,
  type IntegrationWorkerBootstrapState,
  runIntegrationWorkerBootstrap,
} from "../scripts/deploy/integration-worker-bootstrap.ts";
import { canonicalSchemaShape, type D1SchemaState } from "../scripts/deploy/migrations.ts";
import type { CommandResult } from "../scripts/deploy/process.ts";
import { expectedWorkerSecrets } from "../scripts/deploy/realized-config.ts";
import type { SigningDatabase, SigningPublicKeyRow } from "../scripts/deploy/signing.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import type {
  WorkerProcess,
  WorkerProviderExecutorQualification,
} from "../scripts/deploy/worker.ts";
import { expectedExactBindingClosure } from "../scripts/deploy/worker-state.ts";
import type {
  WranglerLifecycleDeployment,
  WranglerVersionPublicationLease,
} from "../scripts/deploy/wrangler-state.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import {
  applyQualifiedMigrationNames,
  copyCurrentSchemaFixture,
} from "./helpers/audited-schema-fixture.ts";

const COMMIT = "a".repeat(40);
const ACCOUNT_ID = "b".repeat(32);
const WORKER_NAME = "takoserver-api-integration";
const ACCOUNT_SUBDOMAIN = "takoserver-integration";
const VERSION_ID = "00000000-0000-4000-8000-000000000001";
const DEPLOYMENT_ID = "00000000-0000-4000-8000-000000000002";
const BUNDLE = "export default {fetch(){return new Response('ok')}};\n";
const BUNDLE_DIGEST = createHash("sha256").update(BUNDLE).digest("hex");
const PUBLIC_ORIGIN = `https://${WORKER_NAME}.${ACCOUNT_SUBDOMAIN}.workers.dev`;
const SCHEDULES = ["*/5 * * * *"] as const;
const EXPECTED_BOOTSTRAP_TEST_COMMAND = [
  "bun",
  "test",
  "--timeout",
  "60000",
  "--bail=1",
  "tests/deploy-integration-worker-bootstrap.test.ts",
  "tests/deploy-integration-storage-generation.test.ts",
  "tests/deploy-signing.test.ts",
  "tests/deploy-realized-config-v2.test.ts",
  "tests/deploy-worker-artifact.test.ts",
  "tests/deploy-worker-composition.test.ts",
  "tests/deploy-worker-state.test.ts",
  "tests/deploy-wrangler-state.test.ts",
  "tests/deploy-cloudflare-state.test.ts",
  "tests/deploy-worker.test.ts",
  "tests/entry-worker-origin.test.ts",
  "tests/entry-worker-operator-authority.test.ts",
  "tests/entry-worker-startup.test.ts",
  "tests/runtime-input-seal-keyring.test.ts",
  "tests/worker-production-composition.test.ts",
] as const;

const fixtureRoot = mkdtempSync(join(tmpdir(), "takoserver-integration-worker-bootstrap-tests-"));
const sourceRoot = join(fixtureRoot, "source");
mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
copyCurrentSchemaFixture(join(sourceRoot, "migrations"));
writeFileSync(
  join(sourceRoot, "wrangler.jsonc"),
  `${JSON.stringify(
    {
      name: "takoserver-api",
      compatibility_date: "2026-08-17",
      compatibility_flags: ["nodejs_compat"],
      workers_dev: true,
      preview_urls: false,
      triggers: { crons: SCHEDULES },
      ai: { binding: "AI" },
      d1_databases: [{ binding: "STATE_DB", migrations_dir: "migrations" }],
      r2_buckets: [{ binding: "OBJECTS" }],
      version_metadata: { binding: "WORKER_VERSION" },
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);

const APPLIED = applyQualifiedMigrationNames();
const EXPECTED_SHAPE = applicationShape(join(sourceRoot, "migrations"), APPLIED);
const COMPLETE_SCHEMA = schemaState(APPLIED, EXPECTED_SHAPE);
const WRONG_SCHEMA = schemaState(APPLIED, "[]\n");
// The first v2 Worker bootstrap is qualified against the fixed 0075 payload,
// not the newer source-only 0076 inventory copied into sourceRoot.
const V2_APPLIED = MIGRATIONS.slice(0, 75).map(({ name }) => name);
const COMPLETE_V2_SCHEMA = schemaState(
  V2_APPLIED,
  applicationShape(join(sourceRoot, "migrations"), V2_APPLIED),
);
const WRONG_V2_SCHEMA = schemaState(V2_APPLIED, "[]\n");
// An explicit fresh v2-0088 generation already carries 0081 private inputs.
const V2_0088_APPLIED = MIGRATIONS.slice(0, 88).map(({ name }) => name);
const COMPLETE_V2_0088_SCHEMA = schemaState(
  V2_0088_APPLIED,
  applicationShape(join(sourceRoot, "migrations"), V2_0088_APPLIED),
);

const keyMaterial = makeKeyMaterial();
const signingRow: SigningPublicKeyRow = {
  keyId: "integration-signing-current",
  publicJwk: JSON.stringify({ kty: "OKP", crv: "Ed25519", x: keyMaterial.publicX }),
  createdAtEpochSeconds: 1_700_000_000,
  revokedAtEpochSeconds: null,
};

const target = {
  kind: "takoserver.deploy-target@v2",
  environment: "integration",
  accountId: ACCOUNT_ID,
  workerName: WORKER_NAME,
  d1: {
    databaseName: "takoserver-runtime-integration",
    databaseId: "00000000-0000-4000-8000-000000000010",
  },
  r2: { bucketName: "takoserver-objects-integration" },
  publicOrigin: PUBLIC_ORIGIN,
  signing: { currentKeyId: signingRow.keyId },
} satisfies DeployTarget;

const V2_GENERATION = "d".repeat(32);
const v2Target = {
  ...target,
  d1: {
    databaseName: `takoserver-i-${V2_GENERATION}`,
    databaseId: "00000000-0000-4000-8000-000000000075",
  },
  r2: { bucketName: `takoserver-i-${V2_GENERATION}` },
  // The historical 0075 payload has no 0081 schema, so it cannot carry an
  // artifact Form configuration; see the v2-0088 target below.
  takoformV2: {
    config: JSON.stringify({
      documentation: "https://docs.example.test/v2",
      authenticationDocumentation: "https://docs.example.test/v2/authentication",
    }),
  },
} satisfies DeployTarget;

const V2_ARTIFACT_CONFIG = JSON.stringify({
  documentation: "https://docs.example.test/v2",
  authenticationDocumentation: "https://docs.example.test/v2/authentication",
  sqliteMigrationSet: { targetKey: "test-sqlite", heldArtifacts: [] },
});
const v2Target0088 = {
  ...v2Target,
  d1: { ...v2Target.d1, databaseId: "00000000-0000-4000-8000-000000000088" },
  takoformV2: { config: V2_ARTIFACT_CONFIG, storageLineage: "v2-0088" },
} satisfies DeployTarget;

const runtimeInputSealKeyring = JSON.stringify({
  current: {
    id: "runtime-current",
    key: Buffer.alloc(32, 7).toString("base64url"),
  },
});

afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

describe("Takoserver integration Worker bootstrap", () => {
  test("rejects production and rehearsal before provider, credentials, or state effects", async () => {
    const calls: string[] = [];
    const run: WorkerProcess = async () => {
      calls.push("run");
      throw new Error("credential access should not occur");
    };
    for (const environment of ["production", "rehearsal"] as const) {
      const error = await rejectedError(
        runIntegrationWorkerBootstrap(
          { action: "apply", environment, commit: COMMIT },
          { ...target, environment },
          { run },
        ),
      );
      expect(error).toBeInstanceOf(DeployError);
      expect(error).toMatchObject({ phase: "preflight" });
    }
    expect(calls).toEqual([]);
  });

  test("status on exact absence is read-only and never reads secret inputs", async () => {
    const fixture = bootstrapFixture({ target });
    const result = await runIntegrationWorkerBootstrap(
      { action: "status", environment: "integration", commit: COMMIT },
      target,
      {
        state: fixture.state,
        run: async () => {
          throw new Error("status must not resolve credentials");
        },
      },
    );
    expect(result).toMatchObject({
      state: "absent",
      ready: false,
      moneyUnitSchemaReady: false,
      mutationApplied: false,
      deploymentId: null,
      versionId: null,
    });
    expect(fixture.stateCalls).toEqual(
      expect.arrayContaining([
        "workerScripts",
        "workerDeployments",
        "workerDomains",
        "workerRoutes",
      ]),
    );
    expect(fixture.stateCalls).not.toContain("workerSecrets");
    expect(fixture.stateCalls).not.toContain("workerSchedules");
    expect(fixture.secretReads).toBe(0);
    expect(fixture.lifecycleCalls).toHaveLength(0);
  });

  test("default signing D1 reads use the bootstrap's selected Wrangler for status", async () => {
    const wranglerPath = "/private/runtime/node_modules/.bin/wrangler";
    const statusFixture = bootstrapFixture({ target, initiallyPublished: true });
    const status = await runIntegrationWorkerBootstrap(
      { action: "status", environment: "integration", commit: COMMIT },
      target,
      {
        state: statusFixture.state,
        run: statusFixture.run,
        sourceRepositoryRoot: sourceRoot,
        schemaReader: statusFixture.schemaReader,
        r2Identity: statusFixture.r2Identity,
        wranglerPath,
      },
    );
    expect(status).toMatchObject({ state: "drift", ready: false, moneyUnitSchemaReady: false });
    expectDefaultSigningReaderPath(statusFixture.commands, wranglerPath);
  });

  test("status accepts native Worker settings without config-only workers.dev flags", async () => {
    const fixture = bootstrapFixture({ target, initiallyPublished: true });
    const result = await readPublishedStatus(fixture);
    expect(result).toMatchObject({ state: "drift", ready: false, moneyUnitSchemaReady: false });
    expect(fixture.stateCalls).toContain("workerSettings");
  });

  test("status still refuses disabled workers.dev or enabled previews from account subdomain readback", async () => {
    for (const subdomain of [
      { enabled: false, previewsEnabled: false },
      { enabled: true, previewsEnabled: true },
    ]) {
      const fixture = bootstrapFixture({ target, initiallyPublished: true, subdomain });
      const result = await readPublishedStatus(fixture);
      expect(result).toMatchObject({ state: "drift", ready: false });
      expect(fixture.stateCalls).toContain("workerSubdomain");
      expect(fixture.stateCalls).not.toContain("workerSettings");
    }
  });

  test("status rejects contradictory optional workers.dev settings when present", async () => {
    for (const settingsOverrides of [{ workers_dev: false }, { preview_urls: true }]) {
      const fixture = bootstrapFixture({
        target,
        initiallyPublished: true,
        settingsOverrides,
      });
      const result = await readPublishedStatus(fixture);
      expect(result).toMatchObject({ state: "drift", ready: false });
      expect(fixture.stateCalls).toContain("workerSettings");
    }
  });

  test("apply refuses every existing or orphan native owner before lifecycle", async () => {
    const cases = [
      { label: "script", scripts: [WORKER_NAME] },
      {
        label: "route",
        routes: [{ zoneId: "zone", id: "route", pattern: "example.test/*", script: WORKER_NAME }],
      },
      { label: "domain", domains: [{ hostname: "api.example.test", service: WORKER_NAME }] },
      {
        label: "history",
        history: [deployment("old-deployment", "00000000-0000-4000-8000-000000000003")],
      },
    ] as const;
    for (const entry of cases) {
      const fixture = bootstrapFixture({
        target,
        ...("scripts" in entry ? { initialScripts: entry.scripts } : {}),
        ...("routes" in entry ? { initialRoutes: entry.routes } : {}),
        ...("domains" in entry ? { initialDomains: entry.domains } : {}),
        ...("history" in entry ? { initialHistory: entry.history } : {}),
      });
      const error = await rejectedError(
        runIntegrationWorkerBootstrap(
          { action: "apply", environment: "integration", commit: COMMIT },
          target,
          {
            state: fixture.state,
            run: fixture.run,
            cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          },
        ),
      );
      expect(error).toBeInstanceOf(DeployError);
      expect(error).toHaveProperty("phase", "preflight");
      expect(error.message).toContain("never adopted");
      expect(fixture.lifecycleCalls).toHaveLength(0);
      expect(fixture.secretReads).toBe(0);
      expect(entry.label).toBeTruthy();
    }
  });

  test("v2 absent status separates native create eligibility from exact 0075 storage qualification", async () => {
    const fixture = bootstrapFixture({ target: v2Target });
    const input = {
      run: fixture.run,
      state: fixture.state,
      sourceRepositoryRoot: sourceRoot,
      v2StorageVerification: v2StorageOptions(v2Target),
    } satisfies IntegrationWorkerBootstrapOptions;
    const ready = await runIntegrationWorkerBootstrap(
      { action: "status", environment: "integration", commit: COMMIT },
      v2Target,
      input,
    );
    expect(ready).toMatchObject({
      state: "not_published",
      ready: false,
      nativeCreateEligible: true,
      storageQualified: true,
      mutationApplied: false,
    });
    const stale = await runIntegrationWorkerBootstrap(
      { action: "status", environment: "integration", commit: COMMIT },
      v2Target,
      { ...input, v2StorageVerification: v2StorageOptions(v2Target, async () => WRONG_V2_SCHEMA) },
    );
    expect(stale).toMatchObject({ ready: false, storageQualified: false });
    expect(fixture.lifecycleCalls).toHaveLength(0);
    expect(fixture.commands).toHaveLength(0);
  });

  test("v2 artifact Forms on the historical 0075 lineage are refused before any provider effect", async () => {
    const artifactOn0075 = {
      ...v2Target,
      takoformV2: { config: V2_ARTIFACT_CONFIG },
    } satisfies DeployTarget;
    const fixture = bootstrapFixture({ target: artifactOn0075 });
    const secretDirectory = writeSecretDirectory(artifactOn0075);
    try {
      await expect(apply(fixture, { secretDirectory })).rejects.toThrow(
        "configured v2 artifact Forms require the complete 0081 schema",
      );
      expect(fixture.lifecycleCalls).toHaveLength(0);
      expect(fixture.commands).toHaveLength(0);
    } finally {
      rmSync(secretDirectory, { recursive: true, force: true });
    }
  });

  test("every frozen fresh bootstrap lineage refuses USD-micros Worker publication before mutation", async () => {
    const cases = [
      { selected: target, count: 66 },
      { selected: v2Target, count: 75 },
      { selected: v2Target0088, count: 88 },
      {
        selected: {
          ...v2Target0088,
          takoformV2: { ...v2Target0088.takoformV2, storageLineage: "v2-0089" as const },
        },
        count: 89,
      },
      {
        selected: {
          ...v2Target0088,
          takoformV2: { ...v2Target0088.takoformV2, storageLineage: "v2-0091" as const },
        },
        count: 91,
      },
    ] as const;
    for (const { selected, count } of cases) {
      const fixture = bootstrapFixture({ target: selected });
      const applied = MIGRATIONS.slice(0, count).map(({ name }) => name);
      const schema = schemaState(
        applied,
        applicationShape(join(sourceRoot, "migrations"), applied),
      );
      const error = await rejectedError(
        apply(fixture, { schemaReader: { read: async () => schema } }),
      );
      expect(error).toBeInstanceOf(DeployError);
      expect(error).toHaveProperty("phase", "preflight");
      expect(error.message).toContain("0094_wallet_usd_micros.sql");
      expect(fixture.lifecycleCalls).toHaveLength(0);
      expect(fixture.secretReads).toBe(0);
      expect(fixture.commands.some((command) => command.includes("--dry-run"))).toBe(false);
    }
  });
});

interface FixtureOptions {
  readonly target: DeployTarget;
  readonly initiallyPublished?: boolean;
  readonly initialScripts?: readonly string[];
  readonly initialHistory?: readonly unknown[];
  readonly initialDomains?: readonly { readonly hostname: string; readonly service: string }[];
  readonly initialRoutes?: readonly {
    readonly zoneId: string;
    readonly id: string;
    readonly pattern: string;
    readonly script: string | null;
  }[];
  readonly schemaMode?: "complete" | "wrong";
  readonly signingMode?: "valid" | "revoked" | "malformed";
  readonly provider?: WorkerProviderExecutorQualification;
  readonly gateFailure?: CommandResult;
  readonly gateFailureAt?: "typecheck" | "tests";
  readonly subdomain?: { readonly enabled: boolean; readonly previewsEnabled: boolean };
  readonly settingsOverrides?: Readonly<Record<string, unknown>>;
  readonly postAckDrift?: "schema" | "signing" | "schedule";
  readonly finalNativeRace?: boolean;
  readonly lostAcknowledgement?: boolean;
}

interface BootstrapFixture {
  readonly target: DeployTarget;
  readonly run: WorkerProcess;
  readonly commands: string[][];
  readonly buildEnvironments: Readonly<Record<string, string>>[];
  readonly state: IntegrationWorkerBootstrapState;
  readonly stateCalls: string[];
  readonly schemaReader: IntegrationWorkerBootstrapSchemaReader;
  readonly signingDatabase: Pick<SigningDatabase, "readKey">;
  readonly r2Identity: {
    read(phase: "preflight" | "verification"): Promise<{ bucketName: string }>;
  };
  readonly provider?: WorkerProviderExecutorQualification;
  readonly providerReads: number;
  readonly lifecycleCalls: Parameters<
    NonNullable<IntegrationWorkerBootstrapOptions["deployLifecycle"]>
  >[0][];
  readonly deployLifecycle: NonNullable<IntegrationWorkerBootstrapOptions["deployLifecycle"]>;
  readonly lease: WranglerVersionPublicationLease;
  readonly secretReads: number;
  readonly buildEnvironmentsMutable: Readonly<Record<string, string>>[];
  readonly lifecycleSecrets: Readonly<Record<string, string>> | undefined;
  readonly secretFileSeen: string | undefined;
  readonly configContents: string | undefined;
  readonly uploaded: boolean;
}

function bootstrapFixture(options: FixtureOptions): BootstrapFixture {
  const target = options.target;
  const commands: string[][] = [];
  const buildEnvironmentsMutable: Readonly<Record<string, string>>[] = [];
  const stateCalls: string[] = [];
  const lifecycleCalls: Parameters<
    NonNullable<IntegrationWorkerBootstrapOptions["deployLifecycle"]>
  >[0][] = [];
  const control = {
    published: options.initiallyPublished ?? false,
    raced: false,
    message: null as string | null,
    postAckDrift: options.postAckDrift,
    signingMode: options.signingMode ?? "valid",
    scheduleDrift: false,
    lifecycleSecrets: undefined as Readonly<Record<string, string>> | undefined,
    secretFileSeen: undefined as string | undefined,
    uploaded: false,
    providerReads: 0,
  };

  const run: WorkerProcess = async (command, input = {}) => {
    commands.push([...command]);
    if (command.join(" ") === "git rev-parse HEAD") return ok(`${COMMIT}\n`);
    if (command.join(" ") === "git branch --show-current") return ok("integration-worker\n");
    if (command.join(" ") === "git status --porcelain=v1 -z --untracked-files=all") return ok("");
    if (command.join(" ") === "bun run typecheck:worker") return gateResult(options, "typecheck");
    if (sameCommand(command, EXPECTED_BOOTSTRAP_TEST_COMMAND)) return gateResult(options, "tests");
    if (command[1] === "d1" && command[2] === "execute" && command.includes("--command")) {
      return ok(
        JSON.stringify([
          {
            success: true,
            results: [
              {
                key_id: signingRow.keyId,
                public_jwk: signingRow.publicJwk,
                created_at_epoch_seconds: signingRow.createdAtEpochSeconds,
                revoked_at_epoch_seconds: signingRow.revokedAtEpochSeconds,
              },
            ],
          },
        ]),
      );
    }
    if (command.includes("--dry-run")) {
      const index = command.indexOf("--outdir");
      const out = index < 0 ? undefined : command[index + 1];
      if (typeof out !== "string") throw new Error("missing dry-run output");
      mkdirSync(out, { recursive: true, mode: 0o700 });
      writeFileSync(join(out, "index.js"), BUNDLE, { mode: 0o600 });
      writeFileSync(join(out, "index.js.map"), "{}\n", { mode: 0o600 });
      writeFileSync(join(out, "README.md"), "generated by Wrangler\n", { mode: 0o600 });
      buildEnvironmentsMutable.push(input.env ?? {});
      return ok("Total Upload: 1 KiB\n");
    }
    throw new Error(`unexpected command ${command.join(" ")}`);
  };

  const state: IntegrationWorkerBootstrapState = {
    async workerScripts() {
      stateCalls.push("workerScripts");
      return control.published || control.raced
        ? [target.workerName]
        : (options.initialScripts ?? []);
    },
    async workerDeployments() {
      stateCalls.push("workerDeployments");
      return control.published || control.raced
        ? [deployment(DEPLOYMENT_ID, VERSION_ID)]
        : (options.initialHistory ?? []);
    },
    async workerDomains() {
      stateCalls.push("workerDomains");
      return options.initialDomains ?? [];
    },
    async workerRoutes() {
      stateCalls.push("workerRoutes");
      return options.initialRoutes ?? [];
    },
    async workerVersion(workerName, versionId) {
      stateCalls.push(`workerVersion:${workerName}:${versionId}`);
      if (!control.published && !control.raced) throw new Error("version unavailable");
      return versionForTarget(
        target,
        control.message ?? `takoserver-worker:${COMMIT}:${BUNDLE_DIGEST}`,
      );
    },
    async workerVersionWithModules(workerName, versionId) {
      stateCalls.push(`workerVersionWithModules:${workerName}:${versionId}`);
      if (!control.published && !control.raced) throw new Error("version unavailable");
      return versionForTarget(
        target,
        control.message ?? `takoserver-worker:${COMMIT}:${BUNDLE_DIGEST}`,
      );
    },
    async workerSecrets() {
      stateCalls.push("workerSecrets");
      return expectedWorkerSecrets(target).map((name) => ({ name, type: "secret_text" }));
    },
    async workerSubdomain() {
      stateCalls.push("workerSubdomain");
      return options.subdomain ?? { enabled: true, previewsEnabled: false };
    },
    async workerAccountSubdomain() {
      stateCalls.push("workerAccountSubdomain");
      return ACCOUNT_SUBDOMAIN;
    },
    async workerSchedules() {
      stateCalls.push("workerSchedules");
      return control.scheduleDrift ? ["0 * * * *"] : [...SCHEDULES];
    },
    async workerSettings() {
      stateCalls.push("workerSettings");
      return {
        placement: { mode: "smart" },
        compatibility_date: "2026-08-17",
        compatibility_flags: ["nodejs_compat"],
        usage_model: "standard",
        tags: [],
        tail_consumers: [],
        logpush: false,
        observability: { enabled: true },
        annotations: {},
        bindings: [],
        ...options.settingsOverrides,
      };
    },
  };

  const schemaReader: IntegrationWorkerBootstrapSchemaReader = {
    async read() {
      return options.schemaMode === "wrong" ||
        (control.postAckDrift === "schema" && control.published)
        ? target.takoformV2 === undefined
          ? WRONG_SCHEMA
          : WRONG_V2_SCHEMA
        : target.takoformV2 === undefined
          ? COMPLETE_SCHEMA
          : completeV2Schema(target);
    },
  };
  const signingDatabase: Pick<SigningDatabase, "readKey"> = {
    async readKey(keyId) {
      if (control.signingMode === "revoked") {
        return {
          ...signingRow,
          keyId,
          revokedAtEpochSeconds: signingRow.createdAtEpochSeconds + 1,
        };
      }
      if (control.signingMode === "malformed") {
        return { ...signingRow, keyId, publicJwk: "{}" };
      }
      if (control.postAckDrift === "signing" && control.published) {
        return {
          ...signingRow,
          keyId,
          publicJwk: JSON.stringify({
            kty: "OKP",
            crv: "Ed25519",
            x: Buffer.alloc(32, 8).toString("base64url"),
          }),
        };
      }
      return { ...signingRow, keyId };
    },
  };
  const r2Identity = {
    async read() {
      return { bucketName: target.r2.bucketName };
    },
  };
  const provider = options.provider;
  const providerQualification = provider
    ? {
        read: async (phase: "preflight" | "verification") => {
          control.providerReads += 1;
          return await provider.read(phase);
        },
      }
    : undefined;

  const lifecycleSecretsHolder = {
    value: undefined as Readonly<Record<string, string>> | undefined,
    path: undefined as string | undefined,
    configContents: undefined as string | undefined,
    uploaded: false,
  };
  const deployLifecycle: NonNullable<IntegrationWorkerBootstrapOptions["deployLifecycle"]> = async (
    input,
  ) => {
    lifecycleCalls.push(input);
    lifecycleSecretsHolder.configContents = readFileSync(input.configPath, "utf8");
    lifecycleSecretsHolder.path = input.secretsFilePath;
    if (input.secretsFilePath === undefined) throw new Error("missing temporary secrets file");
    lifecycleSecretsHolder.value = JSON.parse(
      readFileSync(input.secretsFilePath, "utf8"),
    ) as Record<string, string>;
    if (options.finalNativeRace === true) {
      control.raced = true;
      await input.assertCurrentStillExpected();
      throw new Error("native race should have fenced");
    }
    await input.assertCurrentStillExpected();
    control.message = input.message;
    control.published = true;
    lifecycleSecretsHolder.uploaded = true;
    if (options.lostAcknowledgement === true) {
      throw new Error("lost acknowledgement");
    }
    if (control.postAckDrift === "schedule") control.scheduleDrift = true;
    return {
      versionId: VERSION_ID,
      targets: [target.workerName],
    } satisfies WranglerLifecycleDeployment;
  };

  const lease: WranglerVersionPublicationLease = {
    accountId: target.accountId,
    workerName: target.workerName,
    async release() {},
  };

  return {
    target,
    run,
    commands,
    buildEnvironments: buildEnvironmentsMutable,
    buildEnvironmentsMutable,
    state,
    stateCalls,
    schemaReader,
    signingDatabase,
    r2Identity,
    ...(providerQualification === undefined ? {} : { provider: providerQualification }),
    get providerReads() {
      return control.providerReads;
    },
    lifecycleCalls,
    deployLifecycle,
    lease,
    get secretReads() {
      return 0;
    },
    get lifecycleSecrets() {
      return lifecycleSecretsHolder.value;
    },
    get secretFileSeen() {
      return lifecycleSecretsHolder.path;
    },
    get configContents() {
      return lifecycleSecretsHolder.configContents;
    },
    get uploaded() {
      return lifecycleSecretsHolder.uploaded;
    },
  };
}

async function apply(
  fixture: BootstrapFixture,
  extra: Partial<IntegrationWorkerBootstrapOptions> = {},
  useDefaultSigningDatabase = false,
): Promise<Record<string, unknown>> {
  return await runIntegrationWorkerBootstrap(
    { action: "apply", environment: "integration", commit: COMMIT },
    fixture.target,
    {
      run: fixture.run,
      state: fixture.state,
      sourceRepositoryRoot: sourceRoot,
      schemaReader: fixture.schemaReader,
      ...(useDefaultSigningDatabase ? {} : { signingDatabase: fixture.signingDatabase }),
      r2Identity: fixture.r2Identity,
      ...(fixture.provider === undefined
        ? {}
        : { providerExecutorQualification: fixture.provider }),
      deployLifecycle: fixture.deployLifecycle,
      publicationLease: fixture.lease,
      cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
      review: "independent-reviewer",
      fetcher: publishedProductFetcher(fixture.target),
      ...(fixture.target.takoformV2 === undefined
        ? {}
        : { v2StorageVerification: v2StorageOptions(fixture.target) }),
      ...extra,
    },
  );
}

async function readPublishedStatus(fixture: BootstrapFixture): Promise<Record<string, unknown>> {
  return await runIntegrationWorkerBootstrap(
    { action: "status", environment: "integration", commit: COMMIT },
    fixture.target,
    {
      run: fixture.run,
      state: fixture.state,
      sourceRepositoryRoot: sourceRoot,
      schemaReader: fixture.schemaReader,
      signingDatabase: fixture.signingDatabase,
      r2Identity: fixture.r2Identity,
      ...(fixture.target.takoformV2 === undefined
        ? {}
        : { v2StorageVerification: v2StorageOptions(fixture.target) }),
    },
  );
}

function completeV2Schema(selectedTarget: DeployTarget): D1SchemaState {
  return selectedTarget.takoformV2?.storageLineage === "v2-0088"
    ? COMPLETE_V2_0088_SCHEMA
    : COMPLETE_V2_SCHEMA;
}

function v2StorageOptions(
  selectedTarget: DeployTarget,
  readState: () => Promise<D1SchemaState> = async () => completeV2Schema(selectedTarget),
): IntegrationStorageGenerationTargetVerificationOptions {
  return {
    provider: {
      async getD1(id) {
        return { uuid: id, name: selectedTarget.d1.databaseName };
      },
      async getR2(name) {
        return { name };
      },
    },
    reader: { read: readState },
  };
}

function expectDefaultSigningReaderPath(commands: readonly string[][], wranglerPath: string): void {
  const signingReads = commands.filter(
    (command) => command[1] === "d1" && command[2] === "execute" && command.includes("--command"),
  );
  expect(signingReads.length).toBeGreaterThan(0);
  for (const command of signingReads) expect(command[0]).toBe(wranglerPath);
}

function gateResult(options: FixtureOptions, gate: "typecheck" | "tests"): CommandResult {
  return options.gateFailureAt === gate ? (options.gateFailure ?? ok("green\n")) : ok("green\n");
}

function sameCommand(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function makeKeyMaterial(): { readonly publicX: string; readonly privateRaw: string } {
  const pair = generateKeyPairSync("ed25519");
  const privateValue = pair.privateKey.export({ format: "jwk" }) as {
    readonly d: string;
    readonly x: string;
  };
  const privateJwk = {
    crv: "Ed25519",
    d: privateValue.d,
    ext: true,
    key_ops: ["sign"],
    kty: "OKP",
    x: privateValue.x,
  };
  return { publicX: privateValue.x, privateRaw: JSON.stringify(privateJwk) };
}

function writeSecretDirectory(
  selectedTarget: DeployTarget,
  keyring = runtimeInputSealKeyring,
): string {
  const directory = mkdtempSync(join(fixtureRoot, "secrets-"));
  const values: Record<string, string> = { TAKOSERVER_SIGNING_KEY: keyMaterial.privateRaw };
  if (selectedTarget.edgeSupplies !== undefined)
    values.TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING = keyring;
  if (selectedTarget.takoformV2 !== undefined) {
    values.TAKOSERVER_TAKOFORM_V2_CURSOR_KEY = Buffer.alloc(32, 9).toString("base64url");
  }
  for (const name of expectedWorkerSecrets(selectedTarget)) {
    const value = values[name];
    if (value === undefined) throw new Error(`missing fixture secret ${name}`);
    writeFileSync(join(directory, name), value, { mode: 0o600 });
  }
  return directory;
}

function versionForTarget(selectedTarget: DeployTarget, message: string): Record<string, unknown> {
  const expected = expectedExactBindingClosure(selectedTarget, {
    workerArtifactDigest: `sha256:${BUNDLE_DIGEST}`,
  });
  const bindings = Object.entries(expected).flatMap(([name, requirement]) =>
    requirement === null ? [] : [{ name, type: requirement.type, ...requirement.fields }],
  );
  return {
    id: VERSION_ID,
    annotations: {
      "workers/message": message,
      "workers/triggered_by": "upload",
    },
    compatibility_date: "2026-08-17",
    compatibility_flags: ["nodejs_compat"],
    bindings,
    main_module: "worker.js",
    modules: [
      {
        name: "worker.js",
        content_type: "application/javascript+module",
        content_base64: Buffer.from(BUNDLE).toString("base64"),
      },
    ],
  };
}

function deployment(id: string, versionId: string): Record<string, unknown> {
  return {
    id,
    created_on: "2026-09-12T01:00:00Z",
    versions: [{ version_id: versionId, percentage: 100 }],
  };
}

function schemaState(applied: readonly string[], shape: string): D1SchemaState {
  return {
    applied,
    shape,
    shapeDigest: `sha256:${createHash("sha256").update(shape).digest("hex")}`,
  };
}

function applicationShape(directory: string, applied: readonly string[]): string {
  const database = new Database(":memory:");
  try {
    for (const name of applied) {
      database.exec(readFileSync(join(directory, name), "utf8"));
    }
    const rows = database
      .query(
        "SELECT type, name, tbl_name, COALESCE(sql, '') AS sql " +
          "FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all() as Record<string, unknown>[];
    return canonicalSchemaShape(
      rows.filter(
        (row) =>
          row.name !== "d1_migrations" &&
          row.tbl_name !== "d1_migrations" &&
          row.name !== "_cf_KV" &&
          row.tbl_name !== "_cf_KV",
      ),
    );
  } finally {
    database.close();
  }
}

function publishedProductFetcher(selectedTarget: DeployTarget) {
  return async (input: string): Promise<Response> => {
    const pathname = new URL(input).pathname;
    if (pathname === "/.well-known/takoserver") {
      return Response.json({
        product: "takoserver",
        apiVersion: "v1",
        endpoints: {
          api: selectedTarget.publicOrigin,
          openapi: `${selectedTarget.publicOrigin}/openapi.json`,
        },
      });
    }
    if (pathname === "/openapi.json") {
      return Response.json({ servers: [{ url: selectedTarget.publicOrigin }] });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  };
}

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

async function rejectedError(operation: Promise<unknown>): Promise<DeployError | Error> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as DeployError | Error;
  }
  throw new Error("Expected the operation to reject");
}
