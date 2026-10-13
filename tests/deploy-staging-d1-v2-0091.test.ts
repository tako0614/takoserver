import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertStagingD1NotProduction,
  type IntegrationStorageGenerationProcess,
  isGeneratedIntegrationStorageTarget,
  runIntegrationStorageGeneration,
} from "../scripts/deploy/integration-storage-generation.ts";
import {
  projectFreshIntegrationV2MigrationArtifact0091,
  projectFreshIntegrationV2MigrationArtifact0092,
  readCurrentAuditedMigrationSourceArtifact,
  readSealedFreshIntegrationV2MigrationArtifact0091,
  readSealedFreshIntegrationV2MigrationArtifact0092,
} from "../scripts/deploy/schema.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";

/**
 * The staging-only 0001-0091 profile creates a brand-new integration D1 and
 * nothing else. Each test here holds one of the properties that keep it away
 * from production: the fixed payload, the generated-name rule, and the
 * production identity comparison before creation and before any SQL.
 */

const MIGRATIONS = resolve(import.meta.dir, "../migrations");
const ROOT = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "takoserver-staging-d1-0091-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const DIGEST = "sha256:152aefa3c0577809d419d95be2bc8878aa9a390a4ee40bfbf5501c32bf058bef";
const GENERATION = "d".repeat(32);
const GENERATED = `takoserver-i-${GENERATION}`;
const PRODUCTION_D1 = {
  databaseName: "takoserver-runtime",
  databaseId: "85c5a15d-a80f-42fe-a907-7ec0d86e008e",
} as const;

const target = {
  kind: "takoserver.deploy-target@v2",
  environment: "integration",
  accountId: "b".repeat(32),
  workerName: "takoserver-api-integration",
  // The selected target's current pair: never the generated one, never touched.
  d1: {
    databaseName: `takoserver-i-${"e".repeat(32)}`,
    databaseId: "00000000-0000-4000-8000-000000000088",
  },
  r2: { bucketName: `takoserver-i-${"e".repeat(32)}` },
  publicOrigin: "https://takoserver-api-integration.example.workers.dev",
  signing: { currentKeyId: "integration-current" },
} satisfies DeployTarget;

const invocation = {
  action: "apply",
  environment: "integration",
  commit: "c".repeat(40),
  generation: GENERATION,
  freshLineage: "v2-0091",
} as const;

function ok(stdout: string) {
  return { exitCode: 0, stdout, stderr: "" };
}

/** Clean exact source and green migration gate; records any SQL import. */
function sourceRun(imports: string[]): IntegrationStorageGenerationProcess {
  return async (command) => {
    const key = command.join(" ");
    if (key === "git rev-parse HEAD") return ok(`${"c".repeat(40)}\n`);
    if (key === "git branch --show-current") return ok("staging-d1-test\n");
    if (key === "git status --porcelain=v1 -z --untracked-files=all") return ok("");
    if (key === "bun run check:migrations") return ok("green\n");
    if (command.includes("execute")) {
      imports.push(key);
      return ok("imported\n");
    }
    throw new Error(`unexpected command ${key}`);
  };
}

describe("staging-only v2-0091 and v2-0092 D1 profiles", () => {
  test("projects exactly the fixed audited 0001-0091 payload", () => {
    const projected = projectFreshIntegrationV2MigrationArtifact0091(
      readCurrentAuditedMigrationSourceArtifact(MIGRATIONS),
    );
    expect(projected.names).toHaveLength(91);
    expect(projected.names.at(-1)).toBe("0091_stripe_events.sql");
    expect(projected.digest).toBe(DIGEST);
  });

  test("a sealed import is exactly 0001-0091: missing, extra or drifted bytes are refused", () => {
    const projected = projectFreshIntegrationV2MigrationArtifact0091(
      readCurrentAuditedMigrationSourceArtifact(MIGRATIONS),
    );
    const seal = (directory: string) => {
      mkdirSync(directory, { recursive: true });
      for (const file of projected.files) cpSync(file.path, join(directory, file.name));
    };
    const sealed = join(ROOT, "sealed");
    seal(sealed);
    expect(readSealedFreshIntegrationV2MigrationArtifact0091(sealed).digest).toBe(DIGEST);
    expect(() => readSealedFreshIntegrationV2MigrationArtifact0091(MIGRATIONS)).toThrow(
      "exactly 0001-0091",
    );

    const missing = join(ROOT, "missing");
    seal(missing);
    rmSync(join(missing, "0091_stripe_events.sql"));
    expect(() => readSealedFreshIntegrationV2MigrationArtifact0091(missing)).toThrow(
      "exactly 0001-0091",
    );

    const extra = join(ROOT, "extra");
    seal(extra);
    writeFileSync(join(extra, "0092_future.sql"), "CREATE TABLE future_only (id TEXT);\n");
    expect(() => readSealedFreshIntegrationV2MigrationArtifact0091(extra)).toThrow(
      "exactly 0001-0091",
    );

    const drifted = join(ROOT, "drifted");
    seal(drifted);
    const tail = join(drifted, "0091_stripe_events.sql");
    writeFileSync(tail, `${readFileSync(tail, "utf8")}\n-- drift\n`);
    expect(() => readSealedFreshIntegrationV2MigrationArtifact0091(drifted)).toThrow();
  });

  test("the guard refuses a production-named, non-generated or production-identical D1", () => {
    for (const databaseName of [
      "takoserver-runtime",
      "takoserver-runtime-ga-20260820",
      "takoserver-runtime-integration",
      `takoserver-p-${"a".repeat(32)}`,
      "takoserver-i-short",
      `takoserver-i-${"D".repeat(32)}`,
    ]) {
      expect(() => assertStagingD1NotProduction({ databaseName }, PRODUCTION_D1)).toThrow(
        "not a generated integration D1",
      );
    }
    expect(() =>
      assertStagingD1NotProduction(
        { databaseName: GENERATED, databaseId: PRODUCTION_D1.databaseId },
        PRODUCTION_D1,
      ),
    ).toThrow("production target's D1");
    expect(() =>
      assertStagingD1NotProduction(
        { databaseName: GENERATED, databaseId: "00000000-0000-4000-8000-000000000091" },
        PRODUCTION_D1,
      ),
    ).not.toThrow();
    expect(() =>
      assertStagingD1NotProduction({ databaseName: GENERATED }, undefined),
    ).not.toThrow();
  });

  test("applying v2-0091 without the production target is refused before any provider call", async () => {
    let providerCalls = 0;
    const trap = async (): Promise<never> => {
      providerCalls += 1;
      throw new Error("no provider call is allowed");
    };
    const imports: string[] = [];
    await expect(
      runIntegrationStorageGeneration(invocation, target, {
        provider: {
          listD1: trap,
          getD1: trap,
          createD1: trap,
          listR2: trap,
          getR2: trap,
          createR2: trap,
        },
        run: sourceRun(imports),
        review: "test-review",
      }),
    ).rejects.toThrow("requires TAKOSERVER_DEPLOY_TARGET_PRODUCTION");
    expect(providerCalls).toBe(0);
    expect(imports).toEqual([]);
  });

  test("status records which production D1 the guard compared", async () => {
    const provider = {
      async listD1() {
        return [];
      },
      async listR2() {
        return [];
      },
    };
    const run = sourceRun([]);
    const compared = await runIntegrationStorageGeneration(
      { ...invocation, action: "status" },
      target,
      { provider: provider as never, run, productionD1: PRODUCTION_D1 },
    );
    expect(compared).toMatchObject({
      d1: { databaseName: GENERATED, present: false },
      presence: "absent",
      readyForApply: true,
      productionD1Guard: {
        compared: "naming-and-production-target",
        productionDatabaseName: PRODUCTION_D1.databaseName,
        productionDatabaseId: PRODUCTION_D1.databaseId,
      },
    });
    const namingOnly = await runIntegrationStorageGeneration(
      { ...invocation, action: "status" },
      target,
      { provider: provider as never, run },
    );
    expect(namingOnly).toMatchObject({ productionD1Guard: { compared: "naming-only" } });
  });

  test("a new D1 whose id is the production D1's stops before any SQL or R2", async () => {
    let created = false;
    let r2Created = false;
    const imports: string[] = [];
    const provider = {
      async listD1(name: string) {
        return created ? [{ name, uuid: PRODUCTION_D1.databaseId }] : [];
      },
      async getD1() {
        return { name: GENERATED, uuid: PRODUCTION_D1.databaseId };
      },
      async createD1(name: string) {
        created = true;
        return { name, uuid: PRODUCTION_D1.databaseId };
      },
      async listR2() {
        return [];
      },
      async getR2(name: string) {
        return { name };
      },
      async createR2(name: string) {
        r2Created = true;
        return { name };
      },
    };
    await expect(
      runIntegrationStorageGeneration(invocation, target, {
        provider,
        run: sourceRun(imports),
        review: "test-review",
        productionD1: PRODUCTION_D1,
        reader: {
          read: async () => {
            throw new Error("no schema read before the identity guard");
          },
        },
      }),
    ).rejects.toThrow("production target's D1");
    expect(created).toBe(true);
    expect(imports).toEqual([]);
    expect(r2Created).toBe(false);
  });

  test("the CLI reads the production target only from an absolute path, before any provider read", () => {
    const integrationPath = join(ROOT, "integration-target.json");
    writeFileSync(integrationPath, JSON.stringify(target), { mode: 0o600 });
    const run = (production: string) =>
      Bun.spawnSync(
        [
          process.execPath,
          "--no-env-file",
          "scripts/deploy.ts",
          "takoserver-integration-storage-generation",
          "--status",
          "--environment=integration",
          `--commit=${"c".repeat(40)}`,
          `--generation=${GENERATION}`,
          "--fresh-lineage=v2-0091",
        ],
        {
          cwd: resolve(import.meta.dir, ".."),
          env: {
            PATH: process.env.PATH ?? "",
            TAKOSERVER_DEPLOY_TARGET_INTEGRATION: integrationPath,
            TAKOSERVER_DEPLOY_TARGET_PRODUCTION: production,
          },
        },
      );
    const relative = run("relative/production-target.json");
    expect(relative.exitCode).toBe(2);
    expect(new TextDecoder().decode(relative.stderr)).toContain(
      "TAKOSERVER_DEPLOY_TARGET_PRODUCTION must be an absolute path",
    );
    const missingPath = join(ROOT, "missing-production-target.json");
    const missing = run(missingPath);
    expect(missing.exitCode).toBe(2);
    expect(new TextDecoder().decode(missing.stderr)).toContain(missingPath);
  });

  test("an operator staging pair stands in for a generated pair only on a staging-only lineage", () => {
    const config = JSON.stringify({
      documentation: "https://docs.example.test/v2",
      authenticationDocumentation: "https://docs.example.test/v2/authentication",
    });
    const staging = "takoserver-staging-throwaway-0091-example";
    const pair = (name: string, storageLineage?: "v2-0088" | "v2-0089" | "v2-0091" | "v2-0092") =>
      ({
        ...target,
        d1: { databaseName: name, databaseId: "00000000-0000-4000-8000-000000000091" },
        r2: { bucketName: name },
        ...(storageLineage === undefined ? {} : { takoformV2: { config, storageLineage } }),
      }) satisfies DeployTarget;
    expect(isGeneratedIntegrationStorageTarget(pair(staging, "v2-0091"), "integration")).toBe(true);
    expect(isGeneratedIntegrationStorageTarget(pair(staging, "v2-0092"), "integration")).toBe(true);
    for (const lineage of [undefined, "v2-0088", "v2-0089"] as const) {
      expect(isGeneratedIntegrationStorageTarget(pair(staging, lineage), "integration")).toBe(
        false,
      );
    }
    for (const name of [
      "takoserver-runtime-staging",
      "takoserver-staging-",
      "takoserver-staging-UPPER",
      "takoserver-staging-ends-with-dash-",
      `takoserver-staging-${"a".repeat(60)}`,
    ]) {
      expect(isGeneratedIntegrationStorageTarget(pair(name, "v2-0091"), "integration")).toBe(false);
    }
    expect(
      isGeneratedIntegrationStorageTarget(
        { ...pair(staging, "v2-0091"), r2: { bucketName: `${staging}-other` } },
        "integration",
      ),
    ).toBe(false);
    expect(isGeneratedIntegrationStorageTarget(pair(staging, "v2-0091"), "production")).toBe(false);
  });

  test("the staging-only v2-0092 profile is exactly the fixed 0001-0092 payload", () => {
    const projected = projectFreshIntegrationV2MigrationArtifact0092(
      readCurrentAuditedMigrationSourceArtifact(MIGRATIONS),
    );
    expect(projected.names).toHaveLength(92);
    expect(projected.names.at(-1)).toBe("0092_org_wallet_lifecycle.sql");
    expect(projected.digest).toBe(
      "sha256:6f7c1016b7ffeeb7c02006cdb8e55dc7919bfc2aeaf04c090001dcf423454be2",
    );
    // The 0091 profile stays pinned to its own 91 files despite the newer tail.
    expect(
      projectFreshIntegrationV2MigrationArtifact0091(
        readCurrentAuditedMigrationSourceArtifact(MIGRATIONS),
      ).digest,
    ).toBe(DIGEST);
    const seal = (directory: string) => {
      mkdirSync(directory, { recursive: true });
      for (const file of projected.files) cpSync(file.path, join(directory, file.name));
    };
    const sealed = join(ROOT, "sealed-0092");
    seal(sealed);
    expect(readSealedFreshIntegrationV2MigrationArtifact0092(sealed).digest).toBe(projected.digest);
    const extra = join(ROOT, "extra-0092");
    seal(extra);
    writeFileSync(join(extra, "0093_future.sql"), "CREATE TABLE future_only (id TEXT);\n");
    expect(() => readSealedFreshIntegrationV2MigrationArtifact0092(extra)).toThrow(
      "exactly 0001-0092",
    );
    const missing = join(ROOT, "missing-0092");
    seal(missing);
    rmSync(join(missing, "0092_org_wallet_lifecycle.sql"));
    expect(() => readSealedFreshIntegrationV2MigrationArtifact0092(missing)).toThrow(
      "exactly 0001-0092",
    );
    const drifted = join(ROOT, "drifted-0092");
    seal(drifted);
    const tail = join(drifted, "0092_org_wallet_lifecycle.sql");
    writeFileSync(tail, `${readFileSync(tail, "utf8")}\n-- drift\n`);
    expect(() => readSealedFreshIntegrationV2MigrationArtifact0092(drifted)).toThrow();
  });

  test("applying v2-0092 without the production target is refused before any provider call", async () => {
    let providerCalls = 0;
    const trap = async (): Promise<never> => {
      providerCalls += 1;
      throw new Error("no provider call is allowed");
    };
    await expect(
      runIntegrationStorageGeneration({ ...invocation, freshLineage: "v2-0092" }, target, {
        provider: {
          listD1: trap,
          getD1: trap,
          createD1: trap,
          listR2: trap,
          getR2: trap,
          createR2: trap,
        },
        run: sourceRun([]),
        review: "test-review",
      }),
    ).rejects.toThrow("staging-only v2-0092 profile requires TAKOSERVER_DEPLOY_TARGET_PRODUCTION");
    expect(providerCalls).toBe(0);
  });
});
