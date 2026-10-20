import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildD1MigrationImport } from "../scripts/deploy/d1-migration-import.ts";
import {
  buildFreshMoneyPreservedPreEpochImport,
  composeFreshMoneyPreservedImport,
} from "../scripts/deploy/fresh-money-preserved.ts";
import {
  appendFreshStripeRealmClaim,
  buildFreshStripeRealmClaim,
} from "../scripts/deploy/fresh-stripe-realm-claim.ts";
import {
  assertBootstrapLineageSchema,
  assertFreshMoneyPreservedHost,
  FRESH_MONEY_PRESERVED_HOST_REQUIRES_WRITER,
  runIntegrationWorkerBootstrap,
} from "../scripts/deploy/integration-worker-bootstrap.ts";
import {
  canonicalSchemaShape,
  type D1SchemaState,
  readMigrationArtifact,
} from "../scripts/deploy/migrations.ts";
import {
  type FreshMoneyWriterEpochRecord,
  mintFreshMoneyWriterEpoch,
} from "../scripts/deploy/money-fresh-writer-epoch.ts";
import {
  projectFreshIntegrationV2MigrationArtifact0092,
  projectFreshIntegrationV2MigrationArtifact0100,
  readCurrentAuditedMigrationSourceArtifact,
} from "../scripts/deploy/schema.ts";
import { type DeployTarget, parseDeployTarget } from "../scripts/deploy/target.ts";
import { frameHostMigrationSql } from "../src/sqlite-migration-policy.ts";

/**
 * Container's follow-up to #481: the public integration Worker bootstrap
 * serves a fresh `v2-0100-money-preserved` generation only through the Money
 * writer bound to the epoch Financial minted for exactly that D1, and the
 * plain v2-0100, v2-0092 and production refusals stay exactly as before.
 */

const MIGRATIONS = join(import.meta.dir, "..", "migrations");
const ACCOUNT = "a".repeat(32);
const GENERATION = "e".repeat(32);
const NAME = `integration-takoserver-${GENERATION}`;
const DATABASE_ID = "00000000-0000-4000-8000-0000000001c0";
const POLICY = "transaction-fenced-usd-micros-v1";
const CONFIG = JSON.stringify({
  documentation: "https://docs.example.test/v2",
  authenticationDocumentation: "https://docs.example.test/v2/authentication",
});
const root = mkdtempSync(join(tmpdir(), "n1-bootstrap-"));
chmodSync(root, 0o700);
afterAll(() => rmSync(root, { recursive: true, force: true }));

function descriptor(overrides: Record<string, unknown> = {}) {
  return {
    kind: "takoserver.deploy-target@v2",
    environment: "integration",
    accountId: ACCOUNT,
    workerName: "integration-takoserver-n1-host",
    d1: { databaseName: NAME, databaseId: DATABASE_ID },
    r2: { bucketName: NAME },
    publicOrigin: "https://integration-takoserver-n1-host.example.workers.dev",
    signing: { currentKeyId: "integration-n1-2026-10" },
    takoformV2: { config: CONFIG, storageLineage: "v2-0100-money-preserved" },
    ...overrides,
  };
}

const record = mintFreshMoneyWriterEpoch({
  accountId: ACCOUNT,
  databaseId: DATABASE_ID,
  databaseName: NAME,
  generation: GENERATION,
});

function n1Target(overrides: Record<string, unknown> = {}): DeployTarget {
  return parseDeployTarget(
    descriptor({
      moneyCutoverWriterPolicy: POLICY,
      moneyCutoverWriterEpoch: record.epoch,
      ...overrides,
    }),
    "n1 target",
    "integration",
  );
}

let fileCount = 0;
function writeRecord(value: unknown, mode = 0o600, directory = root): string {
  const path = join(directory, `epoch-record-${++fileCount}.json`);
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode, flag: "wx" });
  chmodSync(path, mode);
  return path;
}

function schemaOf(database: Database): D1SchemaState {
  const applied = (
    database.query("SELECT name FROM d1_migrations ORDER BY id").all() as { name: string }[]
  ).map(({ name }) => name);
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
}

function freshD1(sql: string): Database {
  const database = new Database(":memory:");
  for (const statement of frameHostMigrationSql(sql)) database.exec(statement);
  return database;
}

const plain100Files = projectFreshIntegrationV2MigrationArtifact0100(
  readMigrationArtifact(MIGRATIONS),
).files;

function moneyPreservedD1(minted: FreshMoneyWriterEpochRecord = record): Database {
  return freshD1(
    composeFreshMoneyPreservedImport(buildFreshMoneyPreservedPreEpochImport(plain100Files), minted)
      .sql,
  );
}

function plainD1(): Database {
  return freshD1(
    appendFreshStripeRealmClaim(
      buildD1MigrationImport(plain100Files, { freshLedger: true }),
      buildFreshStripeRealmClaim(plain100Files),
    ).sql,
  );
}

describe("fresh v2-0100-money-preserved Worker serving", () => {
  test("target admits the Money writer only for the fresh generation's own integration pair", () => {
    expect(n1Target().moneyCutoverWriterPolicy).toBe(POLICY);
    expect(n1Target().moneyCutoverWriterEpoch).toBe(record.epoch);
    // #481 behaviour is kept: the lineage may still be named without a writer.
    expect(
      parseDeployTarget(descriptor(), "n1 without writer", "integration").moneyCutoverWriterPolicy,
    ).toBeUndefined();
    const refused = (overrides: Record<string, unknown>, environment = "integration") =>
      expect(() =>
        parseDeployTarget(
          descriptor({
            moneyCutoverWriterPolicy: POLICY,
            moneyCutoverWriterEpoch: record.epoch,
            ...overrides,
          }),
          "refused",
          environment as "integration",
        ),
      ).toThrow();
    // Not the generated integration-takoserver pair, or a mismatched bucket.
    refused({
      d1: { databaseName: `takoserver-i-${GENERATION}`, databaseId: DATABASE_ID },
      r2: { bucketName: `takoserver-i-${GENERATION}` },
    });
    refused({ r2: { bucketName: "integration-takoserver-other" } });
    // No maintenance profile, and never outside integration.
    refused({ schemaMaintenanceMode: "pre-wallet-usd-micros-quiesced" });
    refused({ environment: "production" }, "production");
    refused({ environment: "rehearsal" }, "rehearsal");
  });

  test("plain v2-0100 and v2-0092 writer policy admission is unchanged", () => {
    // Plain v2-0100 still refuses any Money writer.
    expect(() =>
      parseDeployTarget(
        descriptor({
          takoformV2: { config: CONFIG, storageLineage: "v2-0100" },
          moneyCutoverWriterPolicy: POLICY,
          moneyCutoverWriterEpoch: record.epoch,
        }),
        "plain",
        "integration",
      ),
    ).toThrow("money cutover writer policy requires selected integration 0092 storage");
    // v2-0092 still admits it on its generated takoserver-i pair and only there.
    const v0092 = {
      d1: { databaseName: `takoserver-i-${GENERATION}`, databaseId: DATABASE_ID },
      r2: { bucketName: `takoserver-i-${GENERATION}` },
      takoformV2: { config: CONFIG, storageLineage: "v2-0092" },
      moneyCutoverWriterPolicy: POLICY,
      moneyCutoverWriterEpoch: record.epoch,
    };
    expect(
      parseDeployTarget(descriptor(v0092), "v2-0092", "integration").moneyCutoverWriterPolicy,
    ).toBe(POLICY);
    expect(() =>
      parseDeployTarget(
        descriptor({
          ...v0092,
          d1: { databaseName: NAME, databaseId: DATABASE_ID },
          r2: { bucketName: NAME },
        }),
        "v2-0092 foreign pair",
        "integration",
      ),
    ).toThrow("money cutover writer policy requires selected integration 0092 storage");
  });

  test("first Host requires the writer, the exact epoch and the retained mint record", () => {
    const path = writeRecord(record);
    expect(
      assertFreshMoneyPreservedHost(n1Target(), { freshMoneyWriterEpochRecordPath: path }),
    ).toEqual({
      record,
      binding: {
        accountId: ACCOUNT,
        databaseId: DATABASE_ID,
        databaseName: NAME,
        generation: GENERATION,
      },
    });
    // Not this lineage: nothing is read or required.
    const plain = parseDeployTarget(
      descriptor({ takoformV2: { config: CONFIG, storageLineage: "v2-0100" } }),
      "plain",
      "integration",
    );
    expect(assertFreshMoneyPreservedHost(plain, {})).toBeUndefined();
    const refused = (target: DeployTarget, options: Record<string, unknown>) =>
      expect(() => assertFreshMoneyPreservedHost(target, options)).toThrow(
        FRESH_MONEY_PRESERVED_HOST_REQUIRES_WRITER,
      );
    // No writer policy on the target.
    refused(parseDeployTarget(descriptor(), "no writer", "integration"), {
      freshMoneyWriterEpochRecordPath: path,
    });
    // No retained record.
    refused(n1Target(), {});
    // Target epoch is not the minted epoch.
    refused(n1Target({ moneyCutoverWriterEpoch: `sha256:${"f".repeat(64)}` }), {
      freshMoneyWriterEpochRecordPath: path,
    });
    // A valid mint for another D1, or another account.
    for (const binding of [
      {
        accountId: ACCOUNT,
        databaseId: "00000000-0000-4000-8000-0000000001c1",
        databaseName: NAME,
        generation: GENERATION,
      },
      {
        accountId: "b".repeat(32),
        databaseId: DATABASE_ID,
        databaseName: NAME,
        generation: GENERATION,
      },
    ]) {
      const other = mintFreshMoneyWriterEpoch(binding);
      refused(n1Target({ moneyCutoverWriterEpoch: other.epoch }), {
        freshMoneyWriterEpochRecordPath: writeRecord(other),
      });
    }
    // A re-mint for the same D1 does not reproduce the target's epoch.
    refused(n1Target(), {
      freshMoneyWriterEpochRecordPath: writeRecord(mintFreshMoneyWriterEpoch(record.binding)),
    });
    // File safety: group-readable, relative, symlinked component, tampered.
    refused(n1Target(), { freshMoneyWriterEpochRecordPath: writeRecord(record, 0o640) });
    refused(n1Target(), { freshMoneyWriterEpochRecordPath: "relative/epoch.json" });
    const real = join(root, "real-dir");
    mkdirSync(real, { mode: 0o700 });
    writeRecord(record, 0o600, real);
    symlinkSync(real, join(root, "linked-dir"));
    refused(n1Target(), {
      freshMoneyWriterEpochRecordPath: join(root, "linked-dir", `epoch-record-${fileCount}.json`),
    });
    refused(n1Target(), {
      freshMoneyWriterEpochRecordPath: writeRecord({ ...record, nonce: "0".repeat(64) }),
    });
    // The original-maintenance profile never selects this lineage.
    refused(n1Target(), {
      freshMoneyWriterEpochRecordPath: path,
      originalMoneyMaintenance: { originalCreateInputPath: "/x", selectionPath: "/y" },
    });
  });

  test("apply refuses before any credential, provider or process effect", async () => {
    const forbidden = () => {
      throw new Error("forbidden effect");
    };
    for (const target of [
      parseDeployTarget(descriptor(), "no writer", "integration"),
      n1Target(),
    ]) {
      await expect(
        runIntegrationWorkerBootstrap(
          { action: "apply", environment: "integration", commit: "1".repeat(40) },
          target,
          {
            run: forbidden as never,
            state: new Proxy({}, { get: forbidden }) as never,
            get cloudflareEnvironment(): never {
              return forbidden();
            },
          },
        ),
      ).rejects.toThrow(FRESH_MONEY_PRESERVED_HOST_REQUIRES_WRITER);
    }
  });

  test("bootstrap compares a Money-preserved D1 with the exact preserved shape, plain with plain", () => {
    const preserved = moneyPreservedD1();
    const plain = plainD1();
    try {
      const preservedState = schemaOf(preserved);
      const plainState = schemaOf(plain);
      expect(preservedState.applied).toHaveLength(100);
      expect(() => assertBootstrapLineageSchema(n1Target(), preservedState)).not.toThrow();
      expect(() => assertBootstrapLineageSchema(n1Target(), plainState)).toThrow(
        "D1 schema shape does not match the exact audited application schema",
      );
      const plainTarget = parseDeployTarget(
        descriptor({ takoformV2: { config: CONFIG, storageLineage: "v2-0100" } }),
        "plain",
        "integration",
      );
      expect(() => assertBootstrapLineageSchema(plainTarget, plainState)).not.toThrow();
      expect(() => assertBootstrapLineageSchema(plainTarget, preservedState)).toThrow(
        "D1 schema shape does not match the exact audited application schema",
      );
      // The D1 holds exactly the minted epoch the target and record name.
      expect(
        preserved.query("SELECT singleton, writer_epoch FROM money_cutover_authorized_epoch").all(),
      ).toEqual([{ singleton: 1, writer_epoch: record.epoch }]);
    } finally {
      preserved.close();
      plain.close();
    }
  });

  test("v2-0092 bootstrap still projects only the fixed 0001-0092 lineage", () => {
    const v0092 = parseDeployTarget(
      descriptor({
        d1: { databaseName: `takoserver-i-${GENERATION}`, databaseId: DATABASE_ID },
        r2: { bucketName: `takoserver-i-${GENERATION}` },
        takoformV2: { config: CONFIG, storageLineage: "v2-0092" },
      }),
      "v2-0092",
      "integration",
    );
    const files = projectFreshIntegrationV2MigrationArtifact0092(
      readCurrentAuditedMigrationSourceArtifact(MIGRATIONS),
    ).files;
    const database = freshD1(buildD1MigrationImport(files, { freshLedger: true }).sql);
    try {
      expect(() => assertBootstrapLineageSchema(v0092, schemaOf(database))).not.toThrow();
      expect(assertFreshMoneyPreservedHost(v0092, {})).toBeUndefined();
    } finally {
      database.close();
    }
  });
});
