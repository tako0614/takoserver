import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applicationSchemaMatches,
  deriveExpectedApplicationShape,
} from "../scripts/deploy/application-schema-shape.ts";
import { buildD1MigrationImport } from "../scripts/deploy/d1-migration-import.ts";
import { canonicalSchemaShape, readMigrationArtifact } from "../scripts/deploy/migrations.ts";
import { runD1Schema } from "../scripts/deploy/schema.ts";
import {
  persistDispatchedProtected0058Attempt,
  persistPreparedProtected0058Attempt,
} from "../scripts/deploy/schema-0058-apply-receipt.ts";
import { readProtected0058Snapshot } from "../scripts/deploy/schema-0058-proof.ts";
import { build0058SyntheticFixtureSql } from "../scripts/deploy/schema-0058-rehearsal.ts";
import { runProtected0058Transition } from "../scripts/deploy/schema-0058-transition.ts";
import { MIGRATIONS } from "../src/db-schema.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "takoserver-0058-transition-"));
  chmodSync(root, 0o700);
  roots.push(root);
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(
    "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)",
  );
  for (const migration of MIGRATIONS.slice(0, 57)) {
    db.exec(migration.sql);
    db.query("INSERT INTO d1_migrations (name) VALUES (?)").run(migration.name);
  }
  db.exec(build0058SyntheticFixtureSql());
  const artifact = readMigrationArtifact(join(import.meta.dir, "../migrations"));
  const source = artifact.files.slice(0, 58);
  const migration = source[57];
  if (!migration) throw new Error("0058 audited fixture migration is missing");
  const imported = buildD1MigrationImport([migration], { freshLedger: false });
  const reader = {
    async query(_phase: string, _description: string, sql: string) {
      return db.query(sql).all() as Record<string, unknown>[];
    },
  };
  const readState = async () => {
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
  const readSnapshot = async () => readProtected0058Snapshot(reader, "verification");
  const importOnce = async (outcome: "acknowledged" | "unknown") => {
    db.transaction(() => db.exec(imported.sql))();
    return outcome;
  };
  return { root, db, source, imported, readState, readSnapshot, importOnce };
}

test("internal 0058 one-import path preserves nonempty receipt and sealed BLOB bytes", async () => {
  const item = fixture();
  try {
    const before = await item.readState();
    const snapshot = await item.readSnapshot();
    expect(snapshot.counts.cloudflare_managed_worker_receipts).toBe(4);
    expect(snapshot.maxBlobBytes).toBeGreaterThan(0);
    const binding = {
      environment: "rehearsal" as const,
      target: {
        accountId: "a".repeat(32),
        databaseId: "00000000-0000-4000-8000-000000000058",
        databaseName: "fixture-0058",
      },
      source: {
        commit: "b".repeat(40),
        prefix: item.source.map(({ name, digest }) => ({ name, digest })),
        importDigest: item.imported.digest,
        importBytes: item.imported.bytes,
      },
      before: { lineage: before.applied, shapeDigest: before.shapeDigest, snapshot },
    };
    let imports = 0;
    const input = {
      custodyPath: join(item.root, "attempt"),
      binding,
      importArtifact: item.imported,
      expectedPostShape: deriveExpectedApplicationShape(item.source),
      readState: item.readState,
      readSnapshot: item.readSnapshot,
      importOnce: async () => {
        imports += 1;
        return item.importOnce("acknowledged");
      },
    };
    const result = await runProtected0058Transition(input);
    expect(result.providerAcknowledgement).toBe("acknowledged");
    expect(applicationSchemaMatches(result.post, input.expectedPostShape)).toBe(true);
    expect(await item.readSnapshot()).toEqual(snapshot);
    expect(imports).toBe(1);
    const reopened = await runProtected0058Transition(input);
    expect(reopened.providerAcknowledgement).toBe("reconciled-complete-without-second-apply");
    expect(imports).toBe(1);
  } finally {
    item.db.close();
  }
});

test("unknown import ACK and a fresh invocation reconcile from durable custody without replay", async () => {
  const item = fixture();
  try {
    const before = await item.readState();
    const binding = {
      environment: "production" as const,
      target: {
        accountId: "a".repeat(32),
        databaseId: "00000000-0000-4000-8000-000000000058",
        databaseName: "fixture-0058",
      },
      source: {
        commit: "b".repeat(40),
        prefix: item.source.map(({ name, digest }) => ({ name, digest })),
        importDigest: item.imported.digest,
        importBytes: item.imported.bytes,
      },
      before: {
        lineage: before.applied,
        shapeDigest: before.shapeDigest,
        snapshot: await item.readSnapshot(),
      },
    };
    let imports = 0;
    const input = {
      custodyPath: join(item.root, "attempt"),
      binding,
      importArtifact: item.imported,
      expectedPostShape: deriveExpectedApplicationShape(item.source),
      readState: item.readState,
      readSnapshot: item.readSnapshot,
      importOnce: async () => {
        imports += 1;
        return item.importOnce("unknown");
      },
    };
    expect((await runProtected0058Transition(input)).providerAcknowledgement).toBe(
      "provider-error-recovered-by-authoritative-readback",
    );
    expect(
      (
        await runProtected0058Transition({
          ...input,
          importOnce: async () => {
            throw new Error("replay");
          },
        })
      ).providerAcknowledgement,
    ).toBe("reconciled-complete-without-second-apply");
    expect(imports).toBe(1);
    await expect(
      runProtected0058Transition({
        ...input,
        binding: { ...binding, source: { ...binding.source, commit: "c".repeat(40) } },
      }),
    ).rejects.toThrow();
    await expect(
      runProtected0058Transition({
        ...input,
        binding: {
          ...binding,
          target: { ...binding.target, databaseId: "00000000-0000-4000-8000-000000000059" },
        },
      }),
    ).rejects.toMatchObject({ phase: "mutation" });
  } finally {
    item.db.close();
  }
});

test("an interrupted authoritative readback leaves dispatched custody and never reimports", async () => {
  const item = fixture();
  try {
    const before = await item.readState();
    const binding = {
      environment: "production" as const,
      target: {
        accountId: "a".repeat(32),
        databaseId: "00000000-0000-4000-8000-000000000058",
        databaseName: "fixture-0058",
      },
      source: {
        commit: "b".repeat(40),
        prefix: item.source.map(({ name, digest }) => ({ name, digest })),
        importDigest: item.imported.digest,
        importBytes: item.imported.bytes,
      },
      before: {
        lineage: before.applied,
        shapeDigest: before.shapeDigest,
        snapshot: await item.readSnapshot(),
      },
    };
    let reads = 0;
    let imports = 0;
    const input = {
      custodyPath: join(item.root, "attempt"),
      binding,
      importArtifact: item.imported,
      expectedPostShape: deriveExpectedApplicationShape(item.source),
      readState: async () => {
        if (++reads === 2) throw new Error("readback interrupted");
        return item.readState();
      },
      readSnapshot: item.readSnapshot,
      importOnce: async () => {
        imports += 1;
        return item.importOnce("unknown");
      },
    };
    await expect(runProtected0058Transition(input)).rejects.toMatchObject({
      phase: "mutation",
      message:
        "0058 dispatched attempt authoritative lineage readback is unavailable; retain custody",
    });
    expect(
      (
        await runProtected0058Transition({
          ...input,
          importOnce: async () => {
            throw new Error("second import");
          },
        })
      ).providerAcknowledgement,
    ).toBe("reconciled-complete-without-second-apply");
    expect(imports).toBe(1);
  } finally {
    item.db.close();
  }
});

test("an unchanged or partially applied dispatched target stays held without second import", async () => {
  for (const partial of [false, true]) {
    const item = fixture();
    try {
      const before = await item.readState();
      const binding = {
        environment: "production" as const,
        target: {
          accountId: "a".repeat(32),
          databaseId: "00000000-0000-4000-8000-000000000058",
          databaseName: "fixture-0058",
        },
        source: {
          commit: "b".repeat(40),
          prefix: item.source.map(({ name, digest }) => ({ name, digest })),
          importDigest: item.imported.digest,
          importBytes: item.imported.bytes,
        },
        before: {
          lineage: before.applied,
          shapeDigest: before.shapeDigest,
          snapshot: await item.readSnapshot(),
        },
      };
      let imports = 0;
      const input = {
        custodyPath: join(item.root, "attempt"),
        binding,
        importArtifact: item.imported,
        expectedPostShape: deriveExpectedApplicationShape(item.source),
        readState: item.readState,
        readSnapshot: item.readSnapshot,
        importOnce: async () => {
          imports += 1;
          if (partial) {
            const migration = item.source[57];
            if (!migration) throw new Error("0058 fixture migration is missing");
            item.db.query("INSERT INTO d1_migrations (name) VALUES (?)").run(migration.name);
          }
          return "unknown" as const;
        },
      };
      await expect(runProtected0058Transition(input)).rejects.toThrow();
      await expect(runProtected0058Transition(input)).rejects.toThrow();
      expect(imports).toBe(1);
    } finally {
      item.db.close();
    }
  }
});

test("post-import sealed BLOB drift is not explained away by a successful lineage", async () => {
  const item = fixture();
  try {
    const before = await item.readState();
    const binding = {
      environment: "production" as const,
      target: {
        accountId: "a".repeat(32),
        databaseId: "00000000-0000-4000-8000-000000000058",
        databaseName: "fixture-0058",
      },
      source: {
        commit: "b".repeat(40),
        prefix: item.source.map(({ name, digest }) => ({ name, digest })),
        importDigest: item.imported.digest,
        importBytes: item.imported.bytes,
      },
      before: {
        lineage: before.applied,
        shapeDigest: before.shapeDigest,
        snapshot: await item.readSnapshot(),
      },
    };
    let imports = 0;
    const input = {
      custodyPath: join(item.root, "attempt"),
      binding,
      importArtifact: item.imported,
      expectedPostShape: deriveExpectedApplicationShape(item.source),
      readState: item.readState,
      readSnapshot: item.readSnapshot,
      importOnce: async () => {
        imports += 1;
        await item.importOnce("unknown");
        const row = item.db
          .query(
            "SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = 'cloudflare_managed_worker_version_execution_secret_immutable_update'",
          )
          .get() as { sql: string } | null;
        if (!row) throw new Error("0057 immutable secret trigger missing");
        item.db.exec(
          "DROP TRIGGER cloudflare_managed_worker_version_execution_secret_immutable_update",
        );
        item.db.exec(
          "UPDATE cloudflare_managed_worker_version_execution_secrets SET ciphertext = zeroblob(length(ciphertext))",
        );
        item.db.exec(row.sql);
        return "unknown" as const;
      },
    };
    await expect(runProtected0058Transition(input)).rejects.toMatchObject({
      phase: "mutation",
      message: expect.stringContaining("sealed BLOB bytes changed"),
    });
    await expect(runProtected0058Transition(input)).rejects.toMatchObject({
      phase: "mutation",
      message: expect.stringContaining("sealed BLOB bytes changed"),
    });
    expect(imports).toBe(1);
  } finally {
    item.db.close();
  }
});

test("the sole schema writer reopens a completed dispatched 0058 attempt read-only", async () => {
  const item = fixture();
  try {
    const before = await item.readState();
    const target = {
      kind: "takoserver.deploy-target@v2" as const,
      environment: "integration" as const,
      accountId: "a".repeat(32),
      workerName: "takoserver-api-integration",
      d1: { databaseName: "fixture-0058", databaseId: "00000000-0000-4000-8000-000000000058" },
      r2: { bucketName: "fixture-objects" },
      publicOrigin: "https://integration.example.test",
      signing: { currentKeyId: "key-current" },
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
        prefix: item.source.map(({ name, digest }) => ({ name, digest })),
        importDigest: item.imported.digest,
        importBytes: item.imported.bytes,
      },
      before: {
        lineage: before.applied,
        shapeDigest: before.shapeDigest,
        snapshot: await item.readSnapshot(),
      },
    };
    const custodyPath = join(item.root, "attempt");
    await runProtected0058Transition({
      custodyPath,
      binding,
      importArtifact: item.imported,
      expectedPostShape: deriveExpectedApplicationShape(item.source),
      readState: item.readState,
      readSnapshot: item.readSnapshot,
      importOnce: () => item.importOnce("unknown"),
    });
    let dispatched = 0;
    const result = await runD1Schema(
      {
        action: "apply",
        environment: "integration",
        commit: binding.source.commit,
        throughMigration: "0058",
      },
      target,
      {
        receiptPath: custodyPath,
        leaseRoot: join(item.root, "leases"),
        cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "test-token" },
        reader: { read: item.readState, protected0058Snapshot: item.readSnapshot },
        run: async () => {
          dispatched += 1;
          throw new Error("unexpected second import");
        },
      },
    );
    expect(result).toMatchObject({
      kind: "takoserver.d1-schema-0058-readonly-reconciliation@v1",
      providerAcknowledgement: "reconciled-complete-without-second-apply",
      readyForApply: false,
    });
    expect(dispatched).toBe(0);
    await expect(
      runD1Schema(
        {
          action: "apply",
          environment: "integration",
          commit: binding.source.commit,
          throughMigration: "0058",
        },
        target,
        {
          receiptPath: custodyPath,
          leaseRoot: join(item.root, "leases"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "test-token" },
          reader: {
            read: async () => {
              throw new Error("raw provider row must not escape");
            },
            protected0058Snapshot: item.readSnapshot,
          },
          run: async () => {
            dispatched += 1;
            throw new Error("unexpected second import");
          },
        },
      ),
    ).rejects.toMatchObject({
      phase: "mutation",
      message: "0058 dispatched attempt initial D1 readback is unavailable; retain custody",
    });
    await expect(
      runD1Schema(
        {
          action: "apply",
          environment: "integration",
          commit: binding.source.commit,
          throughMigration: "0058",
        },
        target,
        {
          receiptPath: custodyPath,
          leaseRoot: join(item.root, "leases"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "test-token" },
          reader: {
            read: async () => ({
              ...(await item.readState()),
              applied: ["invented-migration.sql"],
            }),
            protected0058Snapshot: item.readSnapshot,
          },
          run: async () => {
            dispatched += 1;
            throw new Error("unexpected second import");
          },
        },
      ),
    ).rejects.toMatchObject({
      phase: "mutation",
      message: "0058 dispatched attempt lineage is malformed or divergent; retain custody",
    });
    await expect(
      runD1Schema(
        {
          action: "apply",
          environment: "integration",
          commit: "c".repeat(40),
          throughMigration: "0058",
        },
        target,
        {
          receiptPath: custodyPath,
          leaseRoot: join(item.root, "leases"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "test-token" },
          reader: { read: item.readState, protected0058Snapshot: item.readSnapshot },
          run: async () => {
            dispatched += 1;
            throw new Error("unexpected second import");
          },
        },
      ),
    ).rejects.toMatchObject({ phase: "mutation" });
    writeFileSync(`${custodyPath}.0058-protected-dispatched.json`, "{}\n", { mode: 0o600 });
    await expect(
      runD1Schema(
        {
          action: "apply",
          environment: "integration",
          commit: binding.source.commit,
          throughMigration: "0058",
        },
        target,
        {
          receiptPath: custodyPath,
          leaseRoot: join(item.root, "leases"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "test-token" },
          reader: { read: item.readState, protected0058Snapshot: item.readSnapshot },
          run: async () => {
            dispatched += 1;
            throw new Error("unexpected second import");
          },
        },
      ),
    ).rejects.toMatchObject({ phase: "mutation" });
    expect(dispatched).toBe(0);
    const marker = `${custodyPath}.0058-protected-dispatched.json`;
    rmSync(marker);
    symlinkSync(join(item.root, "missing-dispatched-record"), marker);
    await expect(
      runD1Schema(
        {
          action: "apply",
          environment: "integration",
          commit: binding.source.commit,
          throughMigration: "0058",
        },
        target,
        {
          receiptPath: custodyPath,
          leaseRoot: join(item.root, "leases"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "test-token" },
          reader: { read: item.readState, protected0058Snapshot: item.readSnapshot },
          run: async () => {
            dispatched += 1;
            throw new Error("unexpected second import");
          },
        },
      ),
    ).rejects.toMatchObject({ phase: "mutation" });
    expect(dispatched).toBe(0);
  } finally {
    item.db.close();
  }
});

test("the sole schema writer holds unchanged, partial, and wrong-target dispatched attempts", async () => {
  for (const caseName of ["unchanged", "partial", "wrong-target"] as const) {
    const item = fixture();
    try {
      const before = await item.readState();
      const target = {
        kind: "takoserver.deploy-target@v2" as const,
        environment: "integration" as const,
        accountId: "a".repeat(32),
        workerName: "takoserver-api-integration",
        d1: {
          databaseName: "fixture-0058",
          databaseId:
            caseName === "wrong-target"
              ? "00000000-0000-4000-8000-000000000059"
              : "00000000-0000-4000-8000-000000000058",
        },
        r2: { bucketName: "fixture-objects" },
        publicOrigin: "https://integration.example.test",
        signing: { currentKeyId: "key-current" },
      };
      const binding = {
        environment: "integration" as const,
        target: {
          accountId: target.accountId,
          databaseId: "00000000-0000-4000-8000-000000000058",
          databaseName: target.d1.databaseName,
        },
        source: {
          commit: "b".repeat(40),
          prefix: item.source.map(({ name, digest }) => ({ name, digest })),
          importDigest: item.imported.digest,
          importBytes: item.imported.bytes,
        },
        before: {
          lineage: before.applied,
          shapeDigest: before.shapeDigest,
          snapshot: await item.readSnapshot(),
        },
      };
      const custodyPath = join(item.root, "attempt");
      const prepared = persistPreparedProtected0058Attempt(custodyPath, binding);
      persistDispatchedProtected0058Attempt(custodyPath, binding, prepared);
      if (caseName === "partial") {
        const sql = MIGRATIONS[57]?.sql;
        const firstStatementStart = sql?.indexOf("CREATE TABLE") ?? -1;
        const firstStatementEnd =
          firstStatementStart < 0 ? -1 : (sql?.indexOf(";", firstStatementStart) ?? -1);
        if (!sql || firstStatementStart < 0 || firstStatementEnd < 0)
          throw new Error("0058 immutable fixture SQL is missing");
        item.db.exec(sql.slice(firstStatementStart, firstStatementEnd + 1));
      }
      let runs = 0;
      await expect(
        runD1Schema(
          {
            action: "apply",
            environment: "integration",
            commit: binding.source.commit,
            throughMigration: "0058",
          },
          target,
          {
            receiptPath: custodyPath,
            leaseRoot: join(item.root, "leases"),
            cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "test-token" },
            reader: { read: item.readState, protected0058Snapshot: item.readSnapshot },
            run: async () => {
              runs += 1;
              throw new Error("unexpected import");
            },
          },
        ),
      ).rejects.toMatchObject({ phase: "mutation" });
      expect(runs).toBe(0);
    } finally {
      item.db.close();
    }
  }
});
