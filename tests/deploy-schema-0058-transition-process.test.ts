import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  watch,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  applicationSchemaMatches,
  deriveExpectedApplicationShape,
} from "../scripts/deploy/application-schema-shape.ts";
import { buildD1MigrationImport } from "../scripts/deploy/d1-migration-import.ts";
import { canonicalSchemaShape, readMigrationArtifact } from "../scripts/deploy/migrations.ts";
import { readProtected0058Snapshot } from "../scripts/deploy/schema-0058-proof.ts";
import { build0058SyntheticFixtureSql } from "../scripts/deploy/schema-0058-rehearsal.ts";

const roots: string[] = [];
const children = new Set<ChildProcess>();
const childScript = resolve(import.meta.dir, "helpers/protected-0058-process-child.ts");
const timeoutMs = 20_000;

afterEach(async () => {
  for (const child of children) await terminateOwnedChild(child);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function waitForPath(path: string): Promise<void> {
  const directory = dirname(path);
  if (existsSync(path)) return;
  await new Promise<void>((resolvePromise, reject) => {
    const watcher = watch(directory, () => {
      if (existsSync(path)) {
        clearTimeout(timer);
        watcher.close();
        resolvePromise();
      }
    });
    const timer = setTimeout(() => {
      watcher.close();
      reject(new Error(`timed out waiting for process proof marker: ${path.split("/").at(-1)}`));
    }, timeoutMs);
    if (existsSync(path)) {
      clearTimeout(timer);
      watcher.close();
      resolvePromise();
    }
  });
}

function waitForExit(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(
      () => reject(new Error("owned Bun child exceeded its exit deadline")),
      timeoutMs,
    );
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      children.delete(child);
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
}

async function terminateOwnedChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    children.delete(child);
    return;
  }
  child.kill("SIGKILL");
  try {
    await waitForExit(child);
  } catch {
    children.delete(child);
    throw new Error("owned Bun child could not be reaped before cleanup deadline");
  }
}

function spawnChild(root: string, mode: string, configPath: string): ChildProcess {
  const home = join(root, "home");
  const temp = join(root, "tmp");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(temp, { recursive: true, mode: 0o700 });
  const path = `${dirname(process.execPath)}:/usr/bin:/bin`;
  const child = spawn(process.execPath, ["--no-env-file", childScript, mode, configPath], {
    cwd: resolve(import.meta.dir, ".."),
    env: {
      HOME: home,
      TMPDIR: temp,
      PATH: path,
      LANG: "C",
      NO_COLOR: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  return child;
}

function prepareFixture() {
  const root = mkdtempSync(join(tmpdir(), "takoserver-0058-process-reopen-"));
  roots.push(root);
  const databasePath = join(root, "fixture.sqlite");
  const seed = new Database(":memory:");
  seed.exec("PRAGMA synchronous = OFF");
  seed.exec("PRAGMA foreign_keys = ON");
  seed.exec(
    "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)",
  );
  const artifact = readMigrationArtifact(resolve(import.meta.dir, "../migrations"));
  for (const migration of artifact.files.slice(0, 57)) {
    seed.exec(readFileSync(migration.path, "utf8"));
    seed.query("INSERT INTO d1_migrations (name) VALUES (?)").run(migration.name);
  }
  seed.exec(build0058SyntheticFixtureSql());
  const serialized = seed.serialize();
  seed.close();
  writeFileSync(databasePath, serialized, { mode: 0o600, flag: "wx" });
  const serializedFile = openSync(databasePath, "r");
  try {
    fsyncSync(serializedFile);
  } finally {
    closeSync(serializedFile);
  }
  const db = new Database(databasePath);
  db.exec("PRAGMA foreign_keys = ON");
  const readState = () => {
    const applied = db
      .query("SELECT name FROM d1_migrations ORDER BY id")
      .all()
      .map((row) => String((row as { name: unknown }).name));
    const shape = canonicalSchemaShape(
      db
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
  };
  const queryReader = {
    async query(_phase: string, _description: string, sql: string) {
      return db.query(sql).all() as Record<string, unknown>[];
    },
  };
  const snapshotPromise = readProtected0058Snapshot(queryReader, "verification");
  return { root, databasePath, db, artifact, readState, snapshotPromise };
}

function expectedConfiguration(
  fixture: ReturnType<typeof prepareFixture>,
  snapshot: Awaited<typeof fixture.snapshotPromise>,
) {
  const prefix = fixture.artifact.files.slice(0, 58);
  const migration = prefix[57];
  if (!migration) throw new Error("canonical 0058 migration source is missing");
  const imported = buildD1MigrationImport([migration], { freshLedger: false });
  const before = fixture.readState();
  const custodyPath = join(fixture.root, "attempt");
  const markerDirectory = join(fixture.root, "markers");
  mkdirSync(markerDirectory, { mode: 0o700 });
  const target = {
    kind: "takoserver.deploy-target@v2" as const,
    environment: "integration" as const,
    accountId: "a".repeat(32),
    workerName: "takoserver-api-integration",
    d1: { databaseName: "fixture-0058", databaseId: "00000000-0000-4000-8000-000000000058" },
    r2: { bucketName: "fixture-objects" },
    publicOrigin: "https://integration.example.test",
    signing: { currentKeyId: "test-key" },
  };
  const binding = {
    environment: "integration" as const,
    target: {
      accountId: target.accountId,
      databaseId: target.d1.databaseId,
      databaseName: target.d1.databaseName,
    },
    source: {
      commit: "b".repeat(40),
      prefix: prefix.map(({ name, digest }) => ({ name, digest })),
      importDigest: imported.digest,
      importBytes: imported.bytes,
    },
    before: { lineage: before.applied, shapeDigest: before.shapeDigest, snapshot },
  };
  const configPath = join(fixture.root, "child-config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      databasePath: fixture.databasePath,
      custodyPath,
      leaseRoot: join(fixture.root, "leases"),
      markerDirectory,
      binding,
      target,
    }),
    { mode: 0o600, flag: "wx" },
  );
  return {
    configPath,
    custodyPath,
    markerDirectory,
    binding,
    target,
    imported,
    expectedPostShape: deriveExpectedApplicationShape(prefix),
  };
}

test("a killed post-import process reopens read-only without a second import", async () => {
  expect(Bun.version).toBe("1.4.0");
  const fixture = prepareFixture();
  try {
    const snapshot = await fixture.snapshotPromise;
    expect(snapshot.counts.cloudflare_managed_worker_receipts).toBe(4);
    expect(snapshot.maxBlobBytes).toBeGreaterThan(0);
    const configuration = expectedConfiguration(fixture, snapshot);
    fixture.db.close();

    const first = spawnChild(fixture.root, "dispatch-after-import", configuration.configPath);
    await waitForPath(join(configuration.markerDirectory, "physical-import-completed"));
    expect(existsSync(`${configuration.custodyPath}.0058-protected-dispatched.json`)).toBe(true);
    expect(existsSync(join(configuration.markerDirectory, "acknowledgement-returned"))).toBe(false);
    first.kill("SIGKILL");
    const killed = await waitForExit(first);
    expect(killed.signal).toBe("SIGKILL");

    const reopened = spawnChild(fixture.root, "reconcile", configuration.configPath);
    const completed = await waitForExit(reopened);
    expect(completed.code).toBe(0);
    const response = JSON.parse(completed.stdout.trim()) as {
      kind: string;
      externalDispatches: number;
      result: Record<string, unknown>;
    };
    expect(response).toMatchObject({
      kind: "reconciled",
      externalDispatches: 0,
      result: {
        kind: "takoserver.d1-schema-0058-readonly-reconciliation@v1",
        providerAcknowledgement: "reconciled-complete-without-second-apply",
        readyForApply: false,
      },
    });
    expect(existsSync(join(configuration.markerDirectory, "unexpected-external-dispatch"))).toBe(
      false,
    );

    const db = new Database(fixture.databasePath);
    try {
      db.exec("PRAGMA foreign_keys = ON");
      const applied = db
        .query("SELECT name FROM d1_migrations ORDER BY id")
        .all()
        .map((row) => String((row as { name: unknown }).name));
      expect(applied).toEqual(configuration.binding.source.prefix.map(({ name }) => name));
      const shape = canonicalSchemaShape(
        db
          .query(
            "SELECT type, name, tbl_name, COALESCE(sql, '') AS sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name",
          )
          .all() as Record<string, unknown>[],
      );
      expect(
        applicationSchemaMatches(
          {
            applied,
            shape,
            shapeDigest: `sha256:${createHash("sha256").update(shape).digest("hex")}`,
          },
          configuration.expectedPostShape,
        ),
      ).toBe(true);
      const queryReader = {
        async query(_phase: string, _description: string, sql: string) {
          return db.query(sql).all() as Record<string, unknown>[];
        },
      };
      const after = await readProtected0058Snapshot(queryReader, "verification");
      expect(after.digest).toBe(snapshot.digest);
      expect(after.counts).toEqual(snapshot.counts);
      expect(after.maxBlobBytes).toBe(snapshot.maxBlobBytes);
      expect(after.foreignKeyViolations).toBe(0);
    } finally {
      db.close();
    }
  } finally {
    if (fixture.db) {
      try {
        fixture.db.close();
      } catch {
        /* already closed before the process boundary */
      }
    }
  }
});

test("a killed pre-import process reopens held at 0057 without import", async () => {
  expect(Bun.version).toBe("1.4.0");
  const fixture = prepareFixture();
  try {
    const snapshot = await fixture.snapshotPromise;
    const configuration = expectedConfiguration(fixture, snapshot);
    fixture.db.close();

    const first = spawnChild(fixture.root, "dispatch-before-import", configuration.configPath);
    await waitForPath(join(configuration.markerDirectory, "durable-dispatch-before-import"));
    expect(existsSync(`${configuration.custodyPath}.0058-protected-dispatched.json`)).toBe(true);
    expect(existsSync(join(configuration.markerDirectory, "physical-import-completed"))).toBe(
      false,
    );
    first.kill("SIGKILL");
    const killed = await waitForExit(first);
    expect(killed.signal).toBe("SIGKILL");

    const reopened = spawnChild(fixture.root, "reconcile", configuration.configPath);
    const completed = await waitForExit(reopened);
    expect(completed.code).toBe(0);
    const response = JSON.parse(completed.stdout.trim()) as {
      kind: string;
      phase: string;
      externalDispatches: number;
      message: string;
    };
    expect(response).toMatchObject({ kind: "held", phase: "mutation", externalDispatches: 0 });
    expect(response.message).toContain("not at the exact completed lineage");
    expect(existsSync(join(configuration.markerDirectory, "unexpected-external-dispatch"))).toBe(
      false,
    );
    expect(existsSync(join(configuration.markerDirectory, "physical-import-completed"))).toBe(
      false,
    );

    const db = new Database(fixture.databasePath);
    try {
      db.exec("PRAGMA foreign_keys = ON");
      const applied = db
        .query("SELECT name FROM d1_migrations ORDER BY id")
        .all()
        .map((row) => String((row as { name: unknown }).name));
      expect(applied).toEqual(configuration.binding.before.lineage);
      const queryReader = {
        async query(_phase: string, _description: string, sql: string) {
          return db.query(sql).all() as Record<string, unknown>[];
        },
      };
      const after = await readProtected0058Snapshot(queryReader, "verification");
      expect(after.digest).toBe(snapshot.digest);
      expect(after.foreignKeyViolations).toBe(0);
    } finally {
      db.close();
    }
  } finally {
    if (fixture.db) {
      try {
        fixture.db.close();
      } catch {
        /* already closed before the process boundary */
      }
    }
  }
});
