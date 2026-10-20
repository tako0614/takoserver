import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildFreshStripeRealmClaim } from "../scripts/deploy/fresh-stripe-realm-claim.ts";
import {
  type IntegrationStorageGenerationProcess,
  isGeneratedIntegrationStorageTarget,
  runIntegrationStorageGeneration,
} from "../scripts/deploy/integration-storage-generation.ts";
import {
  projectFreshIntegrationV2MigrationArtifact0100,
  readCurrentAuditedMigrationSourceArtifact,
  readSealedFreshIntegrationV2MigrationArtifact0100,
} from "../scripts/deploy/schema.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";

/**
 * The staging-only plain 0001-0100 serving profile. Its import is the only
 * place its Stripe realm pin can come from: the guarded claim after the last
 * migration, inside the one file this surface seals and digests. The Money
 * suffix and preserved-shape histories are separate generations.
 */

const MIGRATIONS = resolve(import.meta.dir, "../migrations");
const ROOT = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "takoserver-staging-d1-0100-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const DIGEST = "sha256:ef9b62429718904c90f904bf10abd337fdba0d5a8cb1cee8bc50e5e6c20ed3ac";
const GENERATION = "f".repeat(32);

const target = {
  kind: "takoserver.deploy-target@v2",
  environment: "integration",
  accountId: "b".repeat(32),
  workerName: "takoserver-api-integration",
  d1: {
    databaseName: `takoserver-i-${"e".repeat(32)}`,
    databaseId: "00000000-0000-4000-8000-000000000100",
  },
  r2: { bucketName: `takoserver-i-${"e".repeat(32)}` },
  publicOrigin: "https://takoserver-api-integration.example.workers.dev",
  signing: { currentKeyId: "integration-current" },
} satisfies DeployTarget;

function ok(stdout: string) {
  return { exitCode: 0, stdout, stderr: "" };
}

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

describe("staging-only plain v2-0100 D1 profile", () => {
  const projected = projectFreshIntegrationV2MigrationArtifact0100(
    readCurrentAuditedMigrationSourceArtifact(MIGRATIONS),
  );

  test("projects exactly the fixed audited 0001-0100 payload", () => {
    expect(projected.names).toHaveLength(100);
    expect(projected.names.at(-1)).toBe("0100_hosted_on_demand.sql");
    expect(projected.digest).toBe(DIGEST);
  });

  test("a sealed import is exactly 0001-0100: missing, extra or drifted bytes are refused", () => {
    const seal = (directory: string) => {
      mkdirSync(directory, { recursive: true });
      for (const file of projected.files) cpSync(file.path, join(directory, file.name));
    };
    const sealed = join(ROOT, "sealed");
    seal(sealed);
    expect(readSealedFreshIntegrationV2MigrationArtifact0100(sealed).digest).toBe(DIGEST);
    const missing = join(ROOT, "missing");
    seal(missing);
    rmSync(join(missing, "0100_hosted_on_demand.sql"));
    expect(() => readSealedFreshIntegrationV2MigrationArtifact0100(missing)).toThrow(
      "exactly 0001-0100",
    );
    const extra = join(ROOT, "extra");
    seal(extra);
    writeFileSync(join(extra, "0101_future.sql"), "CREATE TABLE future_only (id TEXT);\n");
    expect(() => readSealedFreshIntegrationV2MigrationArtifact0100(extra)).toThrow(
      "exactly 0001-0100",
    );
    const drifted = join(ROOT, "drifted");
    seal(drifted);
    const path = join(drifted, "0100_hosted_on_demand.sql");
    writeFileSync(path, `${readFileSync(path, "utf8")}\n-- drift\n`);
    expect(() => readSealedFreshIntegrationV2MigrationArtifact0100(drifted)).toThrow();
  });

  test("the claim requires every financial history table these migrations create to be empty", () => {
    const claim = buildFreshStripeRealmClaim(projected.files);
    expect(claim.mode).toBe("test");
    for (const table of ["stripe_events", "ledger", "idempotency", "wallet_credit_lots"])
      expect(claim.sql).toContain(`NOT EXISTS (SELECT 1 FROM "${table}" LIMIT 1)`);
    expect(claim.sql).toContain("WHERE NOT EXISTS (SELECT 1 FROM stripe_mode_realm)");
  });

  test("applying v2-0100 without the production target is refused before any provider call", async () => {
    let providerCalls = 0;
    const trap = async (): Promise<never> => {
      providerCalls += 1;
      throw new Error("no provider call is allowed");
    };
    const imports: string[] = [];
    await expect(
      runIntegrationStorageGeneration(
        {
          action: "apply",
          environment: "integration",
          commit: "c".repeat(40),
          generation: GENERATION,
          freshLineage: "v2-0100",
        },
        target,
        {
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
        },
      ),
    ).rejects.toThrow("requires TAKOSERVER_DEPLOY_TARGET_PRODUCTION");
    expect(providerCalls).toBe(0);
    expect(imports).toEqual([]);
  });

  test("an operator staging pair never stands in for the plain generation", () => {
    const config = JSON.stringify({
      documentation: "https://docs.example.test/v2",
      authenticationDocumentation: "https://docs.example.test/v2/authentication",
    });
    const staging = "takoserver-staging-throwaway-0100-example";
    const pair = {
      ...target,
      d1: { databaseName: staging, databaseId: "00000000-0000-4000-8000-000000000101" },
      r2: { bucketName: staging },
      takoformV2: { config, storageLineage: "v2-0100" as const },
    } satisfies DeployTarget;
    expect(isGeneratedIntegrationStorageTarget(pair, "integration")).toBe(false);
    expect(
      isGeneratedIntegrationStorageTarget(
        {
          ...pair,
          d1: { databaseName: `takoserver-i-${GENERATION}`, databaseId: pair.d1.databaseId },
          r2: { bucketName: `takoserver-i-${GENERATION}` },
        },
        "integration",
      ),
    ).toBe(true);
  });
});
