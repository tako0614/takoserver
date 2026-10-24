import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveExpectedApplicationShape } from "../scripts/deploy/application-schema-shape.ts";
import { DeployError } from "../scripts/deploy/errors.ts";
import {
  buildFreshMoneyPreservedPreEpochImport,
  composeFreshMoneyPreservedImport,
} from "../scripts/deploy/fresh-money-preserved.ts";
import type { IntegrationStorageGenerationTargetVerificationOptions } from "../scripts/deploy/integration-storage-generation.ts";
import {
  FRESH_MONEY_PRESERVED_HOST_REQUIRES_WRITER,
  type IntegrationWorkerBootstrapOptions,
  type IntegrationWorkerBootstrapSchemaReader,
  type IntegrationWorkerBootstrapState,
  runIntegrationWorkerBootstrap,
} from "../scripts/deploy/integration-worker-bootstrap.ts";
import {
  canonicalSchemaShape,
  type D1SchemaState,
  readMigrationArtifact,
} from "../scripts/deploy/migrations.ts";
import { mintFreshMoneyWriterEpoch } from "../scripts/deploy/money-fresh-writer-epoch.ts";
import type { CommandResult } from "../scripts/deploy/process.ts";
import { expectedWorkerSecrets } from "../scripts/deploy/realized-config.ts";
import { projectFreshIntegrationV2MigrationArtifact0100 } from "../scripts/deploy/schema.ts";
import type { SigningDatabase, SigningPublicKeyRow } from "../scripts/deploy/signing.ts";
import { type DeployTarget, parseDeployTarget } from "../scripts/deploy/target.ts";
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
import { SHARED_AUTH_STAGING_PROFILE } from "../src/shared-auth-oidc-client.ts";
import { frameHostMigrationSql } from "../src/sqlite-migration-policy.ts";
import {
  applyQualifiedMigrationNames,
  copyCurrentSchemaFixture,
} from "./helpers/audited-schema-fixture.ts";

const COMMIT = "a".repeat(40);
const ACCOUNT_ID = "b".repeat(32);
const WORKER_NAME = "takoserver-api-integration";
const ACCOUNT_SUBDOMAIN = "takoserver-integration";
const FRESH_AUTH103_ACCOUNT_SUBDOMAIN = "shoutatomiyama0614";
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
const V2_0100_APPLIED = MIGRATIONS.slice(0, 100).map(({ name }) => name);
const COMPLETE_V2_0100_SCHEMA = schemaState(
  V2_0100_APPLIED,
  applicationShape(join(sourceRoot, "migrations"), V2_0100_APPLIED),
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
const AUTH103_WORKER_NAME = new URL(SHARED_AUTH_STAGING_PROFILE.publicOrigin).hostname.split(
  ".",
)[0];
if (AUTH103_WORKER_NAME === undefined)
  throw new Error("Auth103 fixture Worker name is unavailable");
const freshAuth103QuiescedTarget = {
  ...v2Target0088,
  workerName: AUTH103_WORKER_NAME,
  publicOrigin: SHARED_AUTH_STAGING_PROFILE.publicOrigin,
  takoformV2: { ...v2Target0088.takoformV2, storageLineage: "v2-0100" },
  auth103NativeProfile: "root-shared-auth-staging-v1",
  schemaMaintenanceMode: "pre-auth103-quiesced",
} satisfies DeployTarget;

const runtimeInputSealKeyring = JSON.stringify({
  current: {
    id: "runtime-current",
    key: Buffer.alloc(32, 7).toString("base64url"),
  },
});

afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

describe("Takoserver integration Worker bootstrap", () => {
  test("old and foreign Auth103 origins refuse status and apply before credentials or native reads", async () => {
    for (const origin of [
      "https://integration-money-8732b77a789fd563406269261bf09e71.shoutatomiyama0614.workers.dev",
      "https://integration-foreign.shoutatomiyama0614.workers.dev",
    ]) {
      const workerName = new URL(origin).hostname.split(".")[0];
      if (workerName === undefined) throw new Error("origin lacks a Worker name");
      const selected = { ...freshAuth103QuiescedTarget, workerName, publicOrigin: origin };
      for (const action of ["status", "apply"] as const) {
        const fixture = bootstrapFixture({ target: selected });
        let credentialCalls = 0;
        const run: WorkerProcess = async () => {
          credentialCalls++;
          throw new Error("unexpected credential or build access");
        };
        for (const state of [undefined, fixture.state]) {
          const error = await rejectedError(
            runIntegrationWorkerBootstrap(
              { action, environment: "integration", commit: COMMIT },
              selected,
              { run, ...(state === undefined ? {} : { state }) },
            ),
          );
          expect(error).toBeInstanceOf(DeployError);
          expect(error.message).toContain("exact fresh v2-0100 quiesced profile");
        }
        expect(credentialCalls).toBe(0);
        expect(fixture.stateCalls).toEqual([]);
      }
    }
  });

  test("fresh Auth103 origin still uses the independent account workers.dev subdomain", async () => {
    const fixture = bootstrapFixture({
      target: freshAuth103QuiescedTarget,
      accountSubdomain: "crossed-account",
    });
    const error = await rejectedError(apply(fixture));
    expect(error).toBeInstanceOf(DeployError);
    expect(error.message).toContain("selected workers.dev origin does not match");
    expect(fixture.lifecycleCalls).toHaveLength(0);
  });

  test("Auth103 first publication rejects a mixed profile before credentials or native reads", async () => {
    const { schemaMaintenanceMode: omittedMode, ...noMode } = freshAuth103QuiescedTarget;
    const { auth103NativeProfile: omittedProfile, ...noProfile } = freshAuth103QuiescedTarget;
    void omittedMode;
    void omittedProfile;
    const cases = [
      noMode,
      noProfile,
      {
        ...freshAuth103QuiescedTarget,
        takoformV2: {
          ...freshAuth103QuiescedTarget.takoformV2,
          storageLineage: "v2-0088" as const,
        },
      },
    ];
    for (const selected of cases) {
      let effects = 0;
      const error = await rejectedError(
        runIntegrationWorkerBootstrap(
          { action: "apply", environment: "integration", commit: COMMIT },
          selected,
          {
            run: async () => {
              effects++;
              throw new Error("unexpected credential or build access");
            },
          },
        ),
      );
      expect(error).toBeInstanceOf(DeployError);
      expect(error.message).toContain("exact fresh v2-0100 quiesced profile");
      expect(effects).toBe(0);
    }
  });

  test("fresh Auth103 quiesced first publication requires its original source build before upload", async () => {
    const selected = freshAuth103QuiescedTarget;
    const fixture = bootstrapFixture({
      target: selected,
      accountSubdomain: FRESH_AUTH103_ACCOUNT_SUBDOMAIN,
    });
    const secretDirectory = writeSecretDirectory(selected);
    const shape = deriveExpectedApplicationShape(
      projectFreshIntegrationV2MigrationArtifact0100(
        readMigrationArtifact(join(sourceRoot, "migrations")),
      ).files,
    );
    const tables = (JSON.parse(shape) as { type: string; name: string }[])
      .filter((row) => row.type === "table")
      .map((row) => row.name);
    const seeded = new Set([
      "tf_cloudflare_provider_invocation_epoch",
      "tf_v2_operation_acceptance_counter",
      "money_unit_policy",
      "stripe_mode_realm",
    ]);
    try {
      const error = await rejectedError(
        apply(fixture, {
          secretDirectory,
          freshV2DataReader: {
            read: async () => ({
              tableCounts: Object.fromEntries(
                tables.map((name) => [name, seeded.has(name) ? 1 : 0]),
              ),
              ledgerRows: 100,
              foreignKeyViolations: 0,
              invocationEpoch: [
                {
                  singleton: 1,
                  epoch_id: null,
                  state: "closed",
                  opened_at_ms: null,
                  closed_at_ms: null,
                },
              ],
              acceptanceCounter: [{ id: 1, last_order: 0, last_operation_id: null }],
              moneyUnitPolicy: [
                {
                  singleton: 1,
                  ledger_unit: "usd-micros-v2",
                  historical_usage_unit: "microcent-v1",
                  cash_unit: "usd-cents-v1",
                },
              ],
              stripeRealm: [{ singleton: 1, mode: "test", pinned_at: "2026-10-20T09:37:06.426Z" }],
            }),
          },
        }),
      );
      expect(error).toBeInstanceOf(DeployError);
      expect(error.message).toContain("Auth103");
      expect(fixture.lifecycleCalls).toHaveLength(0);
    } finally {
      rmSync(secretDirectory, { recursive: true, force: true });
    }
  });

  test("a quiesced Auth103 Worker cannot be reported as normal Host ready", async () => {
    const fixture = bootstrapFixture({
      target: freshAuth103QuiescedTarget,
      accountSubdomain: FRESH_AUTH103_ACCOUNT_SUBDOMAIN,
      initiallyPublished: true,
    });
    const status = await readPublishedStatus(fixture);
    expect(status).toMatchObject({
      state: "drift",
      ready: false,
      deployedCommit: COMMIT,
      storageQualified: true,
      versionId: VERSION_ID,
    });
  });
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

  test("a fresh Money-preserved 0100 target without its selected writer is refused by apply and published status", async () => {
    const preserved = {
      ...v2Target0088,
      takoformV2: {
        ...v2Target0088.takoformV2,
        storageLineage: "v2-0100-money-preserved" as const,
      },
    } satisfies DeployTarget;
    const refusal = FRESH_MONEY_PRESERVED_HOST_REQUIRES_WRITER;
    const fixture = bootstrapFixture({ target: preserved });
    const error = await rejectedError(apply(fixture));
    expect(error).toBeInstanceOf(DeployError);
    expect(error).toHaveProperty("phase", "preflight");
    expect(error.message).toBe(refusal);
    expect(fixture.lifecycleCalls).toHaveLength(0);
    expect(fixture.secretReads).toBe(0);
    expect(fixture.commands.some((command) => command.includes("--dry-run"))).toBe(false);
    // Status of an already published Worker reads the same selected artifact;
    // status is value-free, so the refusal surfaces as drift, never ready.
    const published = bootstrapFixture({ target: preserved, initiallyPublished: true });
    expect(await readPublishedStatus(published)).toMatchObject({ state: "drift", ready: false });
    expect(published.lifecycleCalls).toHaveLength(0);
  });
});

describe("fresh v2-0100-money-preserved first Host", () => {
  test("the unserved readback requires the retained minted epoch, not any well-formed epoch", async () => {
    const generation = "f".repeat(32);
    const databaseName = `integration-takoserver-${generation}`;
    const databaseId = "00000000-0000-4000-8000-0000000001d0";
    const binding = { accountId: ACCOUNT_ID, databaseId, databaseName, generation };
    const minted = mintFreshMoneyWriterEpoch(binding);
    const selected = parseDeployTarget(
      {
        ...target,
        d1: { databaseName, databaseId },
        r2: { bucketName: databaseName },
        takoformV2: { config: V2_ARTIFACT_CONFIG, storageLineage: "v2-0100-money-preserved" },
        moneyCutoverWriterPolicy: "transaction-fenced-usd-micros-v1",
        moneyCutoverWriterEpoch: minted.epoch,
      },
      "fresh money-preserved target",
      "integration",
    );
    const recordDirectory = mkdtempSync(join(fixtureRoot, "epoch-record-"));
    const recordPath = join(recordDirectory, "money-fresh-writer-epoch.json");
    writeFileSync(recordPath, `${JSON.stringify(minted)}\n`, { mode: 0o600, flag: "wx" });
    const preEpoch = buildFreshMoneyPreservedPreEpochImport(
      projectFreshIntegrationV2MigrationArtifact0100(
        readMigrationArtifact(join(sourceRoot, "migrations")),
      ).files,
    );
    const unserved =
      "fresh v2 storage generation already holds data beyond its seeds and signing registration; first Host publication refused";
    // The D1 holds the target's minted epoch, or a different but well-formed
    // epoch (another genuine mint for the same D1).
    for (const [rowRecord, refused] of [
      [mintFreshMoneyWriterEpoch(binding), true],
      [minted, false],
    ] as const) {
      const database = new Database(":memory:");
      try {
        const sql = composeFreshMoneyPreservedImport(preEpoch, rowRecord).sql;
        for (const statement of frameHostMigrationSql(sql)) database.exec(statement);
        const applied = (
          database.query("SELECT name FROM d1_migrations ORDER BY id").all() as { name: string }[]
        ).map(({ name }) => name);
        const state = schemaState(
          applied,
          canonicalSchemaShape(
            database
              .query(
                "SELECT type, name, tbl_name, COALESCE(sql, '') AS sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name",
              )
              .all() as Record<string, unknown>[],
          ),
        );
        const fixture = bootstrapFixture({ target: selected });
        let localReads = 0;
        // Every D1 SELECT of the unserved readback is answered by the local D1.
        const run: WorkerProcess = async (command, input) => {
          if (command.includes("execute") && command.includes("--command")) {
            localReads++;
            const query = command[command.indexOf("--command") + 1] ?? "";
            return ok(JSON.stringify([{ success: true, results: database.query(query).all() }]));
          }
          return await fixture.run(command, input);
        };
        const outcome = await apply(fixture, {
          run,
          schemaReader: { read: async () => state },
          v2StorageVerification: v2StorageOptions(selected, async () => state),
          freshMoneyWriterEpochRecordPath: recordPath,
        }).then(
          () => "published",
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        );
        expect(localReads).toBeGreaterThan(0);
        if (refused) {
          expect(outcome).toBe(unserved);
          expect(fixture.lifecycleCalls).toHaveLength(0);
        } else expect(outcome).not.toBe(unserved);
      } finally {
        database.close();
      }
    }
  });
});

interface FixtureOptions {
  readonly target: DeployTarget;
  readonly accountSubdomain?: string;
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
      return options.accountSubdomain ?? ACCOUNT_SUBDOMAIN;
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
  if (selectedTarget.takoformV2?.storageLineage === "v2-0100") return COMPLETE_V2_0100_SCHEMA;
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
  if (selectedTarget.auth103NativeProfile !== undefined) {
    values.TAKOSERVER_SHARED_AUTH_CLIENT_SECRET = "fixture-shared-auth-client-secret";
    values.TAKOSERVER_SHARED_AUTH_SESSION_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString(
      "base64url",
    );
  }
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
