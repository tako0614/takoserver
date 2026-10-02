import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { canonicalSchemaShape } from "../scripts/deploy/migrations.ts";
import type { CommandResult } from "../scripts/deploy/process.ts";
import { readProtected0058Snapshot } from "../scripts/deploy/schema-0058-proof.ts";
import type { Protected0058ReferenceQualificationInput } from "../scripts/deploy/schema-0058-reference-qualification.ts";
import { qualifyProtected0058ReferenceCandidate } from "../scripts/deploy/schema-0058-reference-qualification.ts";
import {
  build0058SyntheticFixtureSql,
  runD1Schema0058Rehearsal,
} from "../scripts/deploy/schema-0058-rehearsal.ts";
import {
  persist0058ProtectedReferenceVolumeReceipt,
  read0058ProtectedReferenceVolumeChain,
} from "../scripts/deploy/schema-0058-volume-receipt.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import { MIGRATIONS } from "../src/db-schema.ts";

const root = mkdtempSync(join(tmpdir(), "takoserver-0058-reference-consumer-"));
chmodSync(root, 0o700);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const commit = "a".repeat(40);
const referenceTarget = {
  kind: "takoserver.deploy-target@v2",
  environment: "production",
  accountId: "b".repeat(32),
  workerName: "takoserver-api-production",
  d1: {
    databaseName: "takoserver-runtime-production",
    databaseId: "22222222-2222-4222-8222-222222222222",
  },
  r2: { bucketName: "takoserver-objects-production" },
  publicOrigin: "https://api.production.example.test",
  signing: { currentKeyId: "key-current" },
} satisfies DeployTarget;
const ordinaryTarget = {
  ...referenceTarget,
  environment: "rehearsal",
  accountId: "a".repeat(32),
  workerName: "takoserver-api-rehearsal",
  d1: {
    databaseName: "takoserver-runtime-rehearsal",
    databaseId: "00000000-0000-4000-8000-000000000000",
  },
  r2: { bucketName: "takoserver-objects-rehearsal" },
  publicOrigin: "https://api.rehearsal.example.test",
} satisfies DeployTarget;
const isolatedTarget = {
  accountId: ordinaryTarget.accountId,
  databaseId: "11111111-1111-4111-8111-111111111111",
  databaseName: "takoserver-0058-fixture",
};

function databaseThrough0057(): Database {
  const database = new Database(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(
    "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)",
  );
  for (const migration of MIGRATIONS.slice(0, 57)) {
    database.exec(migration.sql);
    database.query("INSERT INTO d1_migrations (name) VALUES (?)").run(migration.name);
  }
  return database;
}

function reader(database: Database, target: typeof isolatedTarget) {
  return {
    target,
    readIdentity: async () => ({ uuid: target.databaseId, name: target.databaseName }),
    readState: async () => {
      const applied = database
        .query("SELECT name FROM d1_migrations ORDER BY id")
        .all()
        .map((row) => String((row as { name: unknown }).name));
      const shape = canonicalSchemaShape(
        database
          .query(
            "SELECT type, name, tbl_name, COALESCE(sql, '') AS sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name",
          )
          .all() as Record<string, unknown>[],
      );
      return {
        applied,
        shape,
        shapeDigest: `sha256:${createHash("sha256").update(shape).digest("hex")}`,
      };
    },
    readSnapshot: async () =>
      readProtected0058Snapshot(
        {
          query: async (_phase, _description, sql) =>
            database.query(sql).all() as Record<string, unknown>[],
        },
        "verification",
      ),
  };
}

let base: Protected0058ReferenceQualificationInput;
let reference: Database;
let isolated: Database;
let originalCustody: string;
let imports = 0;

beforeAll(async () => {
  reference = databaseThrough0057();
  isolated = databaseThrough0057();
  reference.exec(build0058SyntheticFixtureSql());
  const directory = mkdtempSync(join(root, "producer-"));
  chmodSync(directory, 0o700);
  originalCustody = join(directory, "target.json");
  writeFileSync(
    originalCustody,
    `${JSON.stringify({ kind: "takoserver.d1-0058-isolated-rehearsal-target@v1", ...isolatedTarget, disposableFixtureCustody: true, writersQuiesced: true, credentialScopeReviewed: true })}\n`,
    { mode: 0o600 },
  );
  chmodSync(originalCustody, 0o600);

  const run = async (originalCommand: readonly string[]): Promise<CommandResult> => {
    const command =
      originalCommand[0] === "timeout" && originalCommand[1] !== "--version"
        ? originalCommand.slice(4)
        : originalCommand;
    const key = command.join(" ");
    const migrationName = MIGRATIONS[57]?.name;
    if (!migrationName) throw new Error("0058 migration fixture is absent");
    const ok = (stdout: string): CommandResult => ({ exitCode: 0, stdout, stderr: "" });
    if (key === "git rev-parse HEAD") return ok(`${commit}\n`);
    if (key === "git branch --show-current") return ok("release/schema\n");
    if (key === "git status --porcelain=v1 -z --untracked-files=all") return ok("");
    if (key === "git fetch --quiet --all --prune") return ok("");
    if (key === `git branch -r --contains ${commit}`) return ok("  origin/release-schema\n");
    if (key === "bun run check:migrations") return ok("green\n");
    if (key === "timeout --version") return ok("GNU coreutils timeout\n");
    if (command.includes("migrations") && command.includes("apply")) {
      const path = command[command.indexOf("--config") + 1];
      if (!path) throw new Error("missing config");
      const sql = readFileSync(
        join(dirname(path), "query-probe-migrations", migrationName),
        "utf8",
      );
      try {
        isolated.transaction(() => {
          isolated.exec(sql);
          isolated.query("INSERT INTO d1_migrations (name) VALUES (?)").run(migrationName);
        })();
      } catch (error) {
        if (String(error).includes("UNIQUE constraint failed: d1_migrations.name"))
          return {
            exitCode: 1,
            stdout: "",
            stderr: "UNIQUE constraint failed: d1_migrations.name",
          };
        throw error;
      }
      throw new Error("query rollback probe unexpectedly succeeded");
    }
    const queryIndex = command.indexOf("--command");
    if (queryIndex >= 0) {
      const sql = command[queryIndex + 1];
      const config = command[command.indexOf("--config") + 1];
      if (!sql || !config) throw new Error("missing D1 query input");
      const selectedId = JSON.parse(readFileSync(config, "utf8")).d1_databases[0].database_id;
      const database = selectedId === referenceTarget.d1.databaseId ? reference : isolated;
      return ok(`${JSON.stringify([{ success: true, results: database.query(sql).all() }])}\n`);
    }
    const fileIndex = command.indexOf("--file");
    if (fileIndex >= 0) {
      const path = command[fileIndex + 1];
      if (!path) throw new Error("missing D1 file");
      const sql = readFileSync(path, "utf8");
      if (path.endsWith("rollback-probe.sql")) {
        try {
          isolated.transaction(() => {
            isolated.exec(sql);
            isolated.query("INSERT INTO d1_migrations (name) VALUES (?)").run(migrationName);
          })();
        } catch (error) {
          if (String(error).includes("UNIQUE constraint failed: d1_migrations.name"))
            return {
              exitCode: 1,
              stdout: "",
              stderr: "UNIQUE constraint failed: d1_migrations.name",
            };
          throw error;
        }
        throw new Error("import rollback probe unexpectedly succeeded");
      }
      isolated.exec(sql);
      if (path.endsWith("migration-import.sql")) imports += 1;
      return ok("executed file\n");
    }
    throw new Error(`unexpected command: ${key}`);
  };
  const previousReviewer = process.env.TAKOSERVER_INDEPENDENT_REVIEW;
  process.env.TAKOSERVER_INDEPENDENT_REVIEW = "reviewer@example.test";
  try {
    const produced = await runD1Schema0058Rehearsal(
      { action: "apply", environment: "rehearsal", commit },
      ordinaryTarget,
      {
        custodyPath: originalCustody,
        outputDirectory: join(directory, "output"),
        run,
        cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "isolated-test-token" },
        protectedReference: {
          environment: "production",
          target: referenceTarget,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "reference-test-token" },
        },
        fetcher: async (request) => {
          const selected = request.url.includes(referenceTarget.d1.databaseId)
            ? referenceTarget.d1
            : isolatedTarget;
          return new Response(
            JSON.stringify({
              success: true,
              result: { uuid: selected.databaseId, name: selected.databaseName },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      },
    );
    expect(produced).toMatchObject({
      kind: "takoserver.d1-0058-protected-reference-volume@v1",
      qualification: "injected-runner-local-test-only",
      readyForProtectedApply: false,
    });
  } finally {
    if (previousReviewer === undefined) delete process.env.TAKOSERVER_INDEPENDENT_REVIEW;
    else process.env.TAKOSERVER_INDEPENDENT_REVIEW = previousReviewer;
  }
  base = {
    custodyPath: originalCustody,
    referenceEnvironment: "production",
    reference: reader(reference, {
      accountId: referenceTarget.accountId,
      databaseId: referenceTarget.d1.databaseId,
      databaseName: referenceTarget.d1.databaseName,
    }),
    isolated: reader(isolated, isolatedTarget),
    sourceCommit: commit,
    remoteRef: "origin/release-schema",
    maxImportElapsedMs: 60_000,
  };
});

afterAll(() => {
  reference?.close();
  isolated?.close();
});

function receiptCopy(label: string, states = ["prepared", "dispatched", "qualified"]): string {
  const directory = mkdtempSync(join(root, `${label}-`));
  chmodSync(directory, 0o700);
  const custody = join(directory, "target.json");
  for (const state of states) {
    copyFileSync(
      `${originalCustody}.0058-protected-reference-volume-${state}.json`,
      `${custody}.0058-protected-reference-volume-${state}.json`,
    );
  }
  return custody;
}

test("actual producer receipt and audited SQLite readbacks yield only a portable candidate", async () => {
  const candidate = await qualifyProtected0058ReferenceCandidate(base);
  expect(candidate).toMatchObject({
    kind: "takoserver.d1-0058-protected-reference-candidate@v1",
    evidenceClass: "injected-runner-portable-test-only",
    transitionCandidate: {
      binding: { environment: "production", target: base.reference.target },
    },
  });
  expect(candidate.transitionCandidate.importArtifact.bytes).toBeGreaterThan(0);
  expect(
    candidate.transitionCandidate.binding.before.snapshot.counts.cloudflare_managed_worker_receipts,
  ).toBeGreaterThan(0);
  expect(imports).toBe(1);
});

test("forged receipt, missing dispatch and expired candidate refuse", async () => {
  const custody = receiptCopy("forgery");
  const path = `${custody}.0058-protected-reference-volume-qualified.json`;
  const receipt = JSON.parse(readFileSync(path, "utf8"));
  receipt.binding.referenceBytes += 1;
  writeFileSync(path, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  await expect(
    qualifyProtected0058ReferenceCandidate({ ...base, custodyPath: custody }),
  ).rejects.toThrow();
  const noDispatch = receiptCopy("no-dispatch");
  rmSync(`${noDispatch}.0058-protected-reference-volume-dispatched.json`);
  await expect(
    qualifyProtected0058ReferenceCandidate({ ...base, custodyPath: noDispatch }),
  ).rejects.toThrow();
  const expired = receiptCopy("expired", ["prepared", "dispatched"]);
  const current = read0058ProtectedReferenceVolumeChain(originalCustody).qualified;
  if (current === null) throw new Error("producer did not issue a qualified receipt");
  const { digest: _digest, ...payload } = current;
  persist0058ProtectedReferenceVolumeReceipt(expired, {
    ...payload,
    observedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    expiresAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  });
  await expect(
    qualifyProtected0058ReferenceCandidate({ ...base, custodyPath: expired }),
  ).rejects.toThrow();
});

test("receipt expiry during bounded readbacks refuses before returning a candidate", async () => {
  const custody = receiptCopy("mid-read-expiry", ["prepared", "dispatched"]);
  const current = read0058ProtectedReferenceVolumeChain(originalCustody).qualified;
  if (current === null) throw new Error("producer did not issue a qualified receipt");
  const { digest: _digest, ...payload } = current;
  const expiresAt = Date.now() + 3_000;
  persist0058ProtectedReferenceVolumeReceipt(custody, {
    ...payload,
    observedAt: new Date(expiresAt - 60 * 60 * 1000).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
  });
  let readStarted = false;
  await expect(
    qualifyProtected0058ReferenceCandidate({
      ...base,
      custodyPath: custody,
      reference: {
        ...base.reference,
        readSnapshot: async () => {
          if (!readStarted) {
            readStarted = true;
            await new Promise((resolve) =>
              setTimeout(resolve, Math.max(1, expiresAt - Date.now() + 20)),
            );
          }
          return base.reference.readSnapshot();
        },
      },
    }),
  ).rejects.toThrow(/expired/u);
  expect(readStarted).toBe(true);
});

test("reference identity, source, canonical shape and timing target mismatches refuse", async () => {
  await expect(
    qualifyProtected0058ReferenceCandidate({ ...base, sourceCommit: "c".repeat(40) }),
  ).rejects.toThrow();
  await expect(
    qualifyProtected0058ReferenceCandidate({ ...base, remoteRef: "origin/other" }),
  ).rejects.toThrow();
  await expect(
    qualifyProtected0058ReferenceCandidate({ ...base, maxImportElapsedMs: 0 }),
  ).rejects.toThrow();
  const accepted = await qualifyProtected0058ReferenceCandidate(base);
  await expect(
    qualifyProtected0058ReferenceCandidate({
      ...base,
      maxImportElapsedMs: accepted.elapsedMs - 1,
    }),
  ).rejects.toThrow(/time target/u);
  await expect(
    qualifyProtected0058ReferenceCandidate({ ...base, referenceEnvironment: "integration" }),
  ).rejects.toThrow(/target or audited source/u);
  await expect(
    qualifyProtected0058ReferenceCandidate({
      ...base,
      reference: {
        ...base.reference,
        target: { ...base.reference.target, accountId: "c".repeat(32) },
      },
    }),
  ).rejects.toThrow(/target or audited source/u);
  await expect(
    qualifyProtected0058ReferenceCandidate({
      ...base,
      reference: {
        ...base.reference,
        readIdentity: async () => ({ uuid: "wrong", name: referenceTarget.d1.databaseName }),
      },
    }),
  ).rejects.toThrow();
  await expect(
    qualifyProtected0058ReferenceCandidate({
      ...base,
      isolated: {
        ...base.isolated,
        readState: async () => ({ ...(await base.isolated.readState()), applied: [] }),
      },
    }),
  ).rejects.toThrow();
  await expect(
    qualifyProtected0058ReferenceCandidate({
      ...base,
      reference: {
        ...base.reference,
        readState: async () => ({
          ...(await base.reference.readState()),
          shapeDigest: "sha256:bad",
        }),
      },
    }),
  ).rejects.toThrow(/canonical lineage, shape/u);
});

test("reference and isolated data or readback drift refuse without import replay", async () => {
  const snapshot = await base.reference.readSnapshot();
  await expect(
    qualifyProtected0058ReferenceCandidate({
      ...base,
      reference: {
        ...base.reference,
        readSnapshot: async () => ({ ...snapshot, bytes: snapshot.bytes + 1 }),
      },
    }),
  ).rejects.toThrow();
  let reads = 0;
  await expect(
    qualifyProtected0058ReferenceCandidate({
      ...base,
      reference: {
        ...base.reference,
        readSnapshot: async () => {
          reads += 1;
          return reads === 1 ? snapshot : { ...snapshot, bytes: snapshot.bytes + 1 };
        },
      },
    }),
  ).rejects.toThrow();
  const fixture = await base.isolated.readSnapshot();
  await expect(
    qualifyProtected0058ReferenceCandidate({
      ...base,
      isolated: {
        ...base.isolated,
        readSnapshot: async () => ({ ...fixture, digest: `sha256:${"f".repeat(64)}` }),
      },
    }),
  ).rejects.toThrow();
  await expect(
    qualifyProtected0058ReferenceCandidate({
      ...base,
      isolated: {
        ...base.isolated,
        readSnapshot: async () => ({
          ...fixture,
          counts: {
            ...fixture.counts,
            cloudflare_managed_worker_receipts: 0,
          },
        }),
      },
    }),
  ).rejects.toThrow(/volume bounds/u);
  expect(imports).toBe(1);
});
