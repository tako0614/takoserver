import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { closeSync, constants, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import {
  applicationSchemaMatches,
  deriveExpectedApplicationShape,
} from "../../scripts/deploy/application-schema-shape.ts";
import { buildD1MigrationImport } from "../../scripts/deploy/d1-migration-import.ts";
import { canonicalSchemaShape, readMigrationArtifact } from "../../scripts/deploy/migrations.ts";
import { runD1Schema } from "../../scripts/deploy/schema.ts";
import { readProtected0058Snapshot } from "../../scripts/deploy/schema-0058-proof.ts";
import { runProtected0058Transition } from "../../scripts/deploy/schema-0058-transition.ts";

interface ChildConfig {
  readonly databasePath: string;
  readonly custodyPath: string;
  readonly leaseRoot: string;
  readonly markerDirectory: string;
  readonly binding: Parameters<typeof runProtected0058Transition>[0]["binding"];
  readonly target: {
    readonly kind: "takoserver.deploy-target@v2";
    readonly environment: "integration";
    readonly accountId: string;
    readonly workerName: string;
    readonly d1: { readonly databaseName: string; readonly databaseId: string };
    readonly r2: { readonly bucketName: string };
    readonly publicOrigin: string;
    readonly signing: { readonly currentKeyId: string };
  };
}

function durableMarker(directory: string, name: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = resolve(directory, name);
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    writeSync(descriptor, "complete\n");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function waitForParentTermination(): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error("parent did not terminate the held child")), 30_000);
  });
}

function databaseReader(db: Database) {
  return {
    async query(_phase: string, _description: string, sql: string) {
      return db.query(sql).all() as Record<string, unknown>[];
    },
  };
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const configPath = process.argv[3];
  if (Bun.version !== "1.4.0") throw new Error("process proof requires pinned Bun 1.4.0");
  if (
    !configPath ||
    (mode !== "dispatch-after-import" && mode !== "dispatch-before-import" && mode !== "reconcile")
  ) {
    throw new Error("invalid protected 0058 process-child invocation");
  }
  const config = (await Bun.file(configPath).json()) as ChildConfig;
  const db = new Database(config.databasePath);
  db.exec("PRAGMA foreign_keys = ON");
  const reader = databaseReader(db);
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

  try {
    if (mode === "reconcile") {
      let externalDispatches = 0;
      try {
        const result = await runD1Schema(
          {
            action: "apply",
            environment: "integration",
            commit: config.binding.source.commit,
            throughMigration: "0058",
          },
          config.target,
          {
            receiptPath: config.custodyPath,
            leaseRoot: config.leaseRoot,
            cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "local-sqlite-simulation-only" },
            reader: { read: readState, protected0058Snapshot: readSnapshot },
            run: async () => {
              externalDispatches += 1;
              durableMarker(config.markerDirectory, "unexpected-external-dispatch");
              throw new Error(
                "simulated Cloudflare boundary must not dispatch during reconciliation",
              );
            },
          },
        );
        console.log(JSON.stringify({ kind: "reconciled", externalDispatches, result }));
      } catch (error) {
        const safe = error as { phase?: unknown; message?: unknown };
        console.log(
          JSON.stringify({
            kind: "held",
            externalDispatches,
            phase: typeof safe.phase === "string" ? safe.phase : "unknown",
            message:
              typeof safe.message === "string"
                ? safe.message
                : "protected 0058 reconciliation held",
          }),
        );
      }
      return;
    }

    const artifact = readMigrationArtifact(resolve(import.meta.dir, "../../migrations"));
    const source = artifact.files.slice(0, 58);
    const migration = source[57];
    if (migration?.name !== "0058_cloudflare_managed_worker_domain_receipts.sql") {
      throw new Error("canonical 0058 migration source is unavailable");
    }
    const imported = buildD1MigrationImport([migration], { freshLedger: false });
    const expectedPostShape = deriveExpectedApplicationShape(source);
    const acknowledgement = await runProtected0058Transition({
      custodyPath: config.custodyPath,
      binding: config.binding,
      importArtifact: imported,
      expectedPostShape,
      readState,
      readSnapshot,
      importOnce: async () => {
        if (mode === "dispatch-before-import") {
          durableMarker(config.markerDirectory, "durable-dispatch-before-import");
          return await waitForParentTermination();
        }
        db.transaction(() => db.exec(imported.sql))();
        durableMarker(config.markerDirectory, "physical-import-completed");
        await waitForParentTermination();
        return "acknowledged";
      },
    });
    if (!applicationSchemaMatches(acknowledgement.post, expectedPostShape)) {
      throw new Error("physical 0058 import did not produce the canonical application schema");
    }
    durableMarker(config.markerDirectory, "acknowledgement-returned");
    console.log(JSON.stringify({ kind: "acknowledged" }));
  } finally {
    db.close();
  }
}

void main().catch((error: unknown) => {
  const safe = error as { message?: unknown };
  console.error(
    JSON.stringify({
      kind: "child-error",
      message: typeof safe.message === "string" ? safe.message : "process proof child failed",
    }),
  );
  process.exitCode = 1;
});
