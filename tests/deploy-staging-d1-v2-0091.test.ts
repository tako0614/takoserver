import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertStagingD1NotProduction,
  type IntegrationStorageGenerationProcess,
  runIntegrationStorageGeneration,
} from "../scripts/deploy/integration-storage-generation.ts";
import {
  projectFreshIntegrationV2MigrationArtifact0091,
  readCurrentAuditedMigrationSourceArtifact,
  readSealedFreshIntegrationV2MigrationArtifact0091,
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
  d1: {
    databaseName: "takoserver-i-9b02176262d90b0c414fc97bf7188ffd",
    databaseId: "f079f16e-d4d7-4a51-8383-c4466c99bc53",
  },
  r2: { bucketName: "takoserver-i-9b02176262d90b0c414fc97bf7188ffd" },
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

describe("staging-only v2-0091 D1 profile", () => {
  test("projects exactly the fixed audited 0001-0091 payload", () => {
    const projected = projectFreshIntegrationV2MigrationArtifact0091(
      readCurrentAuditedMigrationSourceArtifact(MIGRATIONS),
    );
    expect(projected.names).toHaveLength(91);
    expect(projected.names.at(-1)).toBe("0091_stripe_events.sql");
    expect(projected.digest).toBe(DIGEST);
  });

  test("a sealed import is exactly 0001-0091: missing, extra or drifted bytes are refused", () => {
    const sealed = join(ROOT, "sealed");
    cpSync(MIGRATIONS, sealed, { recursive: true });
    expect(readSealedFreshIntegrationV2MigrationArtifact0091(sealed).digest).toBe(DIGEST);

    const missing = join(ROOT, "missing");
    cpSync(MIGRATIONS, missing, { recursive: true });
    rmSync(join(missing, "0091_stripe_events.sql"));
    expect(() => readSealedFreshIntegrationV2MigrationArtifact0091(missing)).toThrow(
      "exactly 0001-0091",
    );

    const extra = join(ROOT, "extra");
    cpSync(MIGRATIONS, extra, { recursive: true });
    writeFileSync(join(extra, "0092_future.sql"), "CREATE TABLE future_only (id TEXT);\n");
    expect(() => readSealedFreshIntegrationV2MigrationArtifact0091(extra)).toThrow(
      "exactly 0001-0091",
    );

    const drifted = join(ROOT, "drifted");
    cpSync(MIGRATIONS, drifted, { recursive: true });
    const tail = join(drifted, "0091_stripe_events.sql");
    writeFileSync(tail, `${readFileSync(tail, "utf8")}\n-- drift\n`);
    expect(() => readSealedFreshIntegrationV2MigrationArtifact0091(drifted)).toThrow();
  });

  test("the guard refuses a production-named, non-generated or production-identical D1", () => {
    for (const databaseName of [
      "takoserver-runtime",
      "takoserver-runtime-ga-20260820",
      "takoserver-runtime-integration",
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
});
