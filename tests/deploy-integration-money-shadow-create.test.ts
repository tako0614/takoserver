import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type IntegrationMoneyShadowCreateDeclaration,
  type IntegrationMoneyShadowCreateProvider,
  moneyShadowHash,
  runIntegrationMoneyShadowCreate,
} from "../scripts/deploy/integration-money-shadow-create.ts";
import { readMigrationArtifact } from "../scripts/deploy/migrations.ts";
import type { CommandResult } from "../scripts/deploy/process.ts";
import { moneyUnitCutoverSourcePrefixDigest } from "../scripts/deploy/schema-money-unit-cutover.ts";
import { runIntegrationMoneyShadowRehearsal } from "../scripts/deploy/schema-money-unit-rehearsal.ts";

const ACCOUNT = "a".repeat(32);
const GENERATION = "b".repeat(32);
const NAME = `takoserver-ms-${GENERATION}`;
const UUID = "11111111-1111-4111-8111-111111111111";
const COMMIT = "c".repeat(40);
const SOURCE = moneyUnitCutoverSourcePrefixDigest(readMigrationArtifact().files, 92);
const ok = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "" });

function fixture(): {
  root: string;
  declaration: IntegrationMoneyShadowCreateDeclaration;
  provider: IntegrationMoneyShadowCreateProvider;
  calls: string[];
  run: (command: readonly string[]) => Promise<CommandResult>;
} {
  const root = mkdtempSync("/dev/shm/t/money-shadow-create-");
  const custodyDirectory = join(root, "custody");
  mkdirSync(custodyDirectory, { mode: 0o700 });
  const stageOriginReceiptPath = join(root, "stage-origin.json");
  const origin = {
    kind: "takoserver.money-stage-origin-certificate@v1",
    state: "reviewed",
    reviewedAt: "2026-10-14T00:00:00Z",
    reviewEvidenceDigest: moneyShadowHash("reviewed stage generation evidence"),
    accountId: ACCOUNT,
    databaseId: "22222222-2222-4222-8222-222222222222",
    databaseName: `takoserver-i-${"d".repeat(32)}`,
    bucketName: `takoserver-i-${"d".repeat(32)}`,
    sourceCommit: "e".repeat(40),
    generation: "d".repeat(32),
    freshLineage: "v2-0092",
    migrationDigest: SOURCE,
    appliedMigrationsCount: 92,
    schemaShapeDigest: moneyShadowHash("schema"),
    generationApplyLogDigest: moneyShadowHash("apply log"),
    generationStatusLogDigest: moneyShadowHash("status log"),
    statusReadback: "complete-0092",
    statusPresence: "both",
    statusTargetSelection: { d1: false, r2: false, databaseIdExact: null },
    reviewer: "independent reviewer",
    reviewRef: "reviewed-stage-0092",
  };
  const originBytes = `${JSON.stringify(origin)}\n`;
  writeFileSync(stageOriginReceiptPath, originBytes, { mode: 0o600 });
  const declaration: IntegrationMoneyShadowCreateDeclaration = {
    kind: "takoserver.integration-money-shadow-create@v1",
    environment: "integration",
    purpose: "synthetic-money-import-atomicity",
    accountId: ACCOUNT,
    name: NAME,
    stageOriginReceiptPath,
    stageOriginReceiptDigest: moneyShadowHash(originBytes),
    reviewPath: join(root, "review.json"),
    custodyDirectory,
  };
  const calls: string[] = [];
  let created = false;
  const provider: IntegrationMoneyShadowCreateProvider = {
    async listD1(name) {
      calls.push(`list:${name}`);
      return created ? [{ name: NAME, uuid: UUID }] : [];
    },
    async createD1(name) {
      calls.push(`create:${name}`);
      created = true;
      return { name: NAME, uuid: UUID };
    },
    async getD1(id) {
      calls.push(`get:${id}`);
      return { name: NAME, uuid: UUID };
    },
    async readSchemaObjectCount(id) {
      calls.push(`schema:${id}`);
      return 0;
    },
  };
  const run = async (command: readonly string[]): Promise<CommandResult> => {
    const text = command.join(" ");
    if (text.includes("auth token --json"))
      return ok('{"type":"oauth","token":"synthetic-oauth-bearer"}');
    if (text === "git rev-parse HEAD") return ok(`${COMMIT}\n`);
    if (text === "git branch --show-current") return ok("shadow-work\n");
    if (text === "git status --porcelain=v1 -z --untracked-files=all") return ok();
    if (text === "git fetch --quiet --all --prune") return ok();
    if (text === `git branch -r --contains ${COMMIT}`) return ok("  origin/main\n");
    throw new Error(`unexpected test command ${text}`);
  };
  return { root, declaration, provider, calls, run };
}

describe("integration money shadow create authority", () => {
  test("requires exact reviewed binding, dispatches once, and proves empty native identity", async () => {
    const f = fixture();
    try {
      const invocation = { action: "status", environment: "integration", commit: COMMIT } as const;
      const options = { provider: f.provider, run: f.run, cloudflareEnvironment: {} };
      const createDeclarationPath = join(f.root, "create-declaration.json");
      const createDeclarationBytes = `${JSON.stringify(f.declaration)}\n`;
      writeFileSync(createDeclarationPath, createDeclarationBytes, { mode: 0o600 });
      const status = await runIntegrationMoneyShadowCreate(f.declaration, invocation, options);
      expect(status.readyForApply).toBe(false);
      expect(status.binding).toMatchObject({
        credentialSource: "wrangler-oauth",
        stageOrigin: { accountId: ACCOUNT },
      });
      const evidencePath = join(f.root, "review-evidence.txt");
      const evidence =
        "independent review of the exact staging origin, new name and OAuth source\n";
      writeFileSync(evidencePath, evidence, { mode: 0o600 });
      writeFileSync(
        f.declaration.reviewPath,
        `${JSON.stringify({
          kind: "takoserver.integration-money-shadow-create-review@v1",
          bindingDigest: status.bindingDigest,
          decision: "approved",
          evidencePath,
          evidenceDigest: moneyShadowHash(evidence),
          reviewer: "independent reviewer",
          reviewedAt: "2026-10-14T00:00:00Z",
        })}\n`,
        { mode: 0o600 },
      );
      const applied = await runIntegrationMoneyShadowCreate(
        f.declaration,
        { ...invocation, action: "apply" },
        options,
      );
      expect(applied).toMatchObject({
        databaseId: UUID,
        schemaObjectCount: 0,
        credentialSource: "wrangler-oauth",
      });
      expect(f.calls.filter((call) => call.startsWith("create:"))).toHaveLength(1);
      expect(
        JSON.parse(
          readFileSync(join(f.declaration.custodyDirectory, "create.dispatched.json"), "utf8"),
        ).bindingDigest,
      ).toBe(status.bindingDigest);
      expect(
        (await runIntegrationMoneyShadowCreate(f.declaration, invocation, options)).custody,
      ).toBe("terminal");
      const rehearsalCustody = join(f.root, "rehearsal-custody");
      mkdirSync(rehearsalCustody, { mode: 0o700 });
      await expect(
        runIntegrationMoneyShadowRehearsal(
          {
            kind: "takoserver.integration-money-shadow-rehearsal@v1",
            environment: "integration",
            purpose: "synthetic-money-import-atomicity",
            accountId: ACCOUNT,
            databaseName: NAME,
            databaseId: UUID,
            stageOriginReceiptPath: f.declaration.stageOriginReceiptPath,
            stageOriginReceiptDigest: f.declaration.stageOriginReceiptDigest,
            createDeclarationPath,
            createDeclarationDigest: moneyShadowHash(createDeclarationBytes),
            createReceiptPath: join(f.declaration.custodyDirectory, "create.terminal.json"),
            createReceiptDigest: moneyShadowHash(
              readFileSync(join(f.declaration.custodyDirectory, "create.terminal.json")),
            ),
            reviewPath: join(f.root, "phase-review.json"),
            custodyDirectory: rehearsalCustody,
            snapshotPath: join(f.root, "failure-probe-before.sql"),
            phase: "seed",
          },
          invocation,
          {
            run: f.run,
            cloudflareEnvironment: {},
            provider: {
              async getD1() {
                throw new Error("reached exact shadow native provider");
              },
              async listD1() {
                return [];
              },
            },
          },
        ),
      ).rejects.toThrow("reached exact shadow native provider");
      await expect(
        runIntegrationMoneyShadowCreate(f.declaration, { ...invocation, action: "apply" }, options),
      ).rejects.toThrow("no adoption or retry");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test("rejects token source, foreign origin, ordinary name, and production selector before create", async () => {
    const f = fixture();
    try {
      const invocation = { action: "apply", environment: "integration", commit: COMMIT } as const;
      await expect(
        runIntegrationMoneyShadowCreate(f.declaration, invocation, {
          provider: f.provider,
          run: f.run,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "explicit" },
        }),
      ).rejects.toThrow("requires canonical Wrangler OAuth");
      await expect(
        runIntegrationMoneyShadowCreate(
          { ...f.declaration, accountId: "f".repeat(32) },
          invocation,
          {
            provider: f.provider,
            run: f.run,
            cloudflareEnvironment: {},
          },
        ),
      ).rejects.toThrow("staging 0092 origin");
      await expect(
        runIntegrationMoneyShadowCreate(
          { ...f.declaration, name: `takoserver-r-${GENERATION}` },
          invocation,
          {
            provider: f.provider,
            run: f.run,
            cloudflareEnvironment: {},
          },
        ),
      ).rejects.toThrow("exact integration-only declaration");
      await expect(
        runIntegrationMoneyShadowCreate(
          f.declaration,
          { ...invocation, environment: "production" } as never,
          {
            provider: f.provider,
            run: f.run,
            cloudflareEnvironment: {},
          },
        ),
      ).rejects.toThrow("integration status/apply");
      expect(f.calls).toEqual([]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test("malformed protected review cannot silently become absence", async () => {
    const f = fixture();
    try {
      writeFileSync(f.declaration.reviewPath, "{bad", { mode: 0o600 });
      await expect(
        runIntegrationMoneyShadowCreate(
          f.declaration,
          { action: "status", environment: "integration", commit: COMMIT },
          {
            provider: f.provider,
            run: f.run,
            cloudflareEnvironment: {},
          },
        ),
      ).rejects.toThrow("malformed");
      expect(f.calls.filter((call) => call.startsWith("create:"))).toHaveLength(0);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test("lost create acknowledgement retains dispatch and never replays the POST", async () => {
    const f = fixture();
    try {
      const invocation = { action: "status", environment: "integration", commit: COMMIT } as const;
      const options = {
        run: f.run,
        cloudflareEnvironment: {},
        provider: {
          ...f.provider,
          async createD1(name: string) {
            f.calls.push(`create:${name}`);
            throw new Error("network ACK lost");
          },
        },
      };
      const status = await runIntegrationMoneyShadowCreate(f.declaration, invocation, options);
      const evidencePath = join(f.root, "evidence.txt");
      const evidence = "reviewed exact shadow create binding\n";
      writeFileSync(evidencePath, evidence, { mode: 0o600 });
      writeFileSync(
        f.declaration.reviewPath,
        `${JSON.stringify({
          kind: "takoserver.integration-money-shadow-create-review@v1",
          bindingDigest: status.bindingDigest,
          decision: "approved",
          evidencePath,
          evidenceDigest: moneyShadowHash(evidence),
          reviewer: "independent reviewer",
          reviewedAt: "2026-10-14T00:00:00Z",
        })}\n`,
        { mode: 0o600 },
      );
      await expect(
        runIntegrationMoneyShadowCreate(f.declaration, { ...invocation, action: "apply" }, options),
      ).rejects.toThrow("ACK unknown");
      expect(
        (await runIntegrationMoneyShadowCreate(f.declaration, invocation, options)).custody,
      ).toBe("dispatched");
      await expect(
        runIntegrationMoneyShadowCreate(f.declaration, { ...invocation, action: "apply" }, options),
      ).rejects.toThrow("no adoption or retry");
      expect(f.calls.filter((call) => call.startsWith("create:"))).toHaveLength(1);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});
