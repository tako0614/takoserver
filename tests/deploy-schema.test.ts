import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeployError } from "../scripts/deploy/errors.ts";
import type { D1SchemaState } from "../scripts/deploy/migrations.ts";
import type { CommandResult } from "../scripts/deploy/process.ts";
import {
  exactReceiptPath,
  runD1Schema,
  type SchemaProcess,
  type SchemaReader,
} from "../scripts/deploy/schema.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";

const COMMIT = "a".repeat(40);
const target = {
  kind: "takoserver.deploy-target@v2",
  environment: "rehearsal",
  accountId: "a".repeat(32),
  workerName: "takoserver-api-rehearsal",
  d1: {
    databaseName: "takoserver-runtime-rehearsal",
    databaseId: "00000000-0000-4000-8000-000000000000",
  },
  r2: { bucketName: "takoserver-objects-rehearsal" },
  publicOrigin: "https://api.rehearsal.example.test",
  signing: { currentKeyId: "key-current" },
} satisfies DeployTarget;

function migrations(root: string): string {
  const directory = join(root, "source-migrations");
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(directory, "0001_first.sql"), "CREATE TABLE first (id TEXT);\n");
  writeFileSync(join(directory, "0002_second.sql"), "CREATE TABLE second (id TEXT);\n");
  return directory;
}

function processFixture(environment: "rehearsal" | "production") {
  const calls: string[][] = [];
  const run: SchemaProcess = async (command): Promise<CommandResult> => {
    calls.push([...command]);
    const key = command.join(" ");
    if (key === "git rev-parse HEAD") return ok(`${COMMIT}\n`);
    if (key === "git branch --show-current") {
      return ok(environment === "production" ? "main\n" : "release/schema\n");
    }
    if (key === "git status --porcelain=v1 -z --untracked-files=all") return ok("");
    if (key === "git fetch --quiet origin main") return ok("");
    if (key === "git rev-parse origin/main") return ok(`${COMMIT}\n`);
    if (key === "git fetch --quiet --all --prune") return ok("");
    if (key === `git branch -r --contains ${COMMIT}`) return ok("  origin/release-schema\n");
    if (key === "bun run check:migrations") return ok("green\n");
    if (command.includes("migrations") && command.includes("apply")) return ok("applied 0002\n");
    throw new Error(`unexpected command: ${key}`);
  };
  return { run, calls };
}

function readerSequence(states: readonly D1SchemaState[]): SchemaReader {
  let reads = 0;
  return {
    async read() {
      return states[Math.min(reads++, states.length - 1)] as D1SchemaState;
    },
  };
}

const PRE: D1SchemaState = {
  applied: ["0001_first.sql"],
  shape: "pre-shape\n",
  shapeDigest: `sha256:${"1".repeat(64)}`,
};
const POST: D1SchemaState = {
  applied: ["0001_first.sql", "0002_second.sql"],
  shape: "post-shape\n",
  shapeDigest: `sha256:${"2".repeat(64)}`,
};

describe("forward-only D1 schema surface", () => {
  test("refuses a receipt path whose symlinked parent lands inside any Git repository", () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-schema-receipt-link-"));
    try {
      chmodSync(root, 0o700);
      const repository = join(root, "other-repository");
      const privateDirectory = join(repository, "private");
      mkdirSync(join(repository, ".git"), { recursive: true });
      mkdirSync(privateDirectory, { mode: 0o700 });
      const link = join(root, "linked-parent");
      symlinkSync(privateDirectory, link, "dir");
      expect(() => exactReceiptPath(join(link, "receipt.json"))).toThrow("Git repository");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("status reports the exact ordered pending suffix without mutation", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-schema-status-"));
    try {
      const fixture = processFixture("rehearsal");
      const result = await runD1Schema(
        { action: "status", environment: "rehearsal", commit: COMMIT },
        target,
        {
          run: fixture.run,
          reader: readerSequence([PRE]),
          migrationDirectory: migrations(root),
          outputDirectory: join(root, "work"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      );
      expect(result).toMatchObject({
        kind: "takoserver.d1-schema-status@v2",
        appliedMigrations: ["0001_first.sql"],
        pendingMigrations: ["0002_second.sql"],
        schemaShapeDigest: PRE.shapeDigest,
      });
      expect(fixture.calls).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("apply refuses an empty pending suffix instead of reporting green", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-schema-current-"));
    try {
      const fixture = processFixture("rehearsal");
      const current = { ...POST, applied: ["0001_first.sql", "0002_second.sql"] };
      const failure = await runD1Schema(
        { action: "apply", environment: "rehearsal", commit: COMMIT },
        target,
        {
          run: fixture.run,
          reader: readerSequence([current]),
          migrationDirectory: migrations(root),
          outputDirectory: join(root, "work"),
          receiptPath: join(root, "receipt.json"),
          review: "reviewer@example.test",
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      ).catch((error) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect(failure.message).toContain("no pending D1 migration");
      expect(fixture.calls.some((call) => call.includes("apply"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rehearsal applies the exact sealed suffix once, reads it back, and writes a 0600 receipt", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-schema-rehearsal-"));
    try {
      chmodSync(root, 0o700);
      const fixture = processFixture("rehearsal");
      const receiptPath = join(root, "receipt.json");
      const result = await runD1Schema(
        { action: "apply", environment: "rehearsal", commit: COMMIT },
        target,
        {
          run: fixture.run,
          reader: readerSequence([PRE, PRE, POST]),
          migrationDirectory: migrations(root),
          outputDirectory: join(root, "work"),
          receiptPath,
          review: "reviewer@example.test",
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      );
      expect(result).toMatchObject({
        kind: "takoserver.d1-schema-apply@v2",
        pendingMigrations: ["0002_second.sql"],
        postShapeDigest: POST.shapeDigest,
        rollback: "forward repair only: D1 migrations have no down path",
      });
      expect(
        fixture.calls.filter((call) => call.join(" ") === "bun run check:migrations"),
      ).toHaveLength(1);
      const applies = fixture.calls.filter(
        (call) => call.includes("migrations") && call.includes("apply"),
      );
      expect(applies).toHaveLength(1);
      expect(applies[0]).toContain(target.d1.databaseName);
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
      expect(receipt).toMatchObject({
        kind: "takoserver.d1-schema-rehearsal-receipt@v1",
        commit: COMMIT,
        pendingMigrations: ["0002_second.sql"],
        preShapeDigest: PRE.shapeDigest,
        postShapeDigest: POST.shapeDigest,
      });
      expect(Bun.file(receiptPath).size).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("production requires the exact rehearsal digest and shape before its one apply", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-schema-production-"));
    try {
      chmodSync(root, 0o700);
      const migrationDirectory = migrations(root);
      const rehearsal = processFixture("rehearsal");
      const receiptPath = join(root, "receipt.json");
      await runD1Schema({ action: "apply", environment: "rehearsal", commit: COMMIT }, target, {
        run: rehearsal.run,
        reader: readerSequence([PRE, PRE, POST]),
        migrationDirectory,
        outputDirectory: join(root, "rehearsal-work"),
        receiptPath,
        review: "reviewer@example.test",
        cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
      });
      const productionTarget = { ...target, environment: "production" as const };
      const production = processFixture("production");
      const result = await runD1Schema(
        { action: "apply", environment: "production", commit: COMMIT },
        productionTarget,
        {
          run: production.run,
          reader: readerSequence([PRE, PRE, POST]),
          migrationDirectory,
          outputDirectory: join(root, "production-work"),
          receiptPath,
          review: "second-reviewer@example.test",
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      );
      expect(result).toMatchObject({
        environment: "production",
        postShapeDigest: POST.shapeDigest,
      });
      expect(
        production.calls.filter((call) => call.includes("migrations") && call.includes("apply")),
      ).toHaveLength(1);

      const malformed = JSON.parse(readFileSync(receiptPath, "utf8"));
      malformed.preShapeDigest = `sha256:${"9".repeat(64)}`;
      writeFileSync(join(root, "bad-receipt.json"), `${JSON.stringify(malformed)}\n`, {
        mode: 0o600,
      });
      const refusedProcess = processFixture("production");
      const refused = await runD1Schema(
        { action: "apply", environment: "production", commit: COMMIT },
        productionTarget,
        {
          run: refusedProcess.run,
          reader: readerSequence([PRE, PRE]),
          migrationDirectory,
          outputDirectory: join(root, "refused-work"),
          receiptPath: join(root, "bad-receipt.json"),
          review: "second-reviewer@example.test",
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      ).catch((error) => error);
      expect(refused).toBeInstanceOf(DeployError);
      expect(refused.message).toContain("rehearsal receipt");
      expect(refusedProcess.calls.some((call) => call.includes("apply"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}
