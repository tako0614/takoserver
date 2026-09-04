import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { RemoteD1 } from "../scripts/deploy/d1.ts";
import { DeployError } from "../scripts/deploy/errors.ts";
import {
  type D1SchemaState,
  readD1SchemaState,
  readMigrationArtifact,
} from "../scripts/deploy/migrations.ts";
import type { CommandResult } from "../scripts/deploy/process.ts";
import {
  runD1Schema,
  runD1SchemaRehearsalBaseline,
  type SchemaProcess,
  type SchemaReader,
} from "../scripts/deploy/schema.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import { MIGRATIONS } from "../src/db-schema.ts";

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

const EMPTY: D1SchemaState = {
  applied: [],
  shape: "[]\n",
  shapeDigest: `sha256:${"0".repeat(64)}`,
};

function stateThrough(count: number, marker: string): D1SchemaState {
  return {
    applied: MIGRATIONS.slice(0, count).map(({ name }) => name),
    shape: `${marker}\n`,
    shapeDigest: `sha256:${marker.repeat(64).slice(0, 64)}`,
  };
}

function readerSequence(states: readonly D1SchemaState[]): SchemaReader {
  let reads = 0;
  return {
    async read() {
      return states[Math.min(reads++, states.length - 1)] as D1SchemaState;
    },
  };
}

function dataReaderSequence(
  states: readonly D1SchemaState[],
  counts: {
    readonly malformedFormRef?: readonly number[];
    readonly duplicateResourceUid?: readonly number[];
    readonly unmatchedSaga?: readonly number[];
    readonly legacyPreparation?: readonly number[];
    readonly duplicateNativeClaim?: readonly number[];
  } = {},
): SchemaReader {
  const stateReader = readerSequence(states);
  const indexes = new Map<string, number>();
  const next = (name: string, values: readonly number[] | undefined): number => {
    const index = indexes.get(name) ?? 0;
    indexes.set(name, index + 1);
    return values?.[Math.min(index, values.length - 1)] ?? 0;
  };
  return {
    read: stateReader.read.bind(stateReader),
    async resourceDeletionAttestationBackfillCounts() {
      return {
        malformedFormRefCount: next("malformed", counts.malformedFormRef),
        duplicateLiveResourceUidCount: next("resourceUid", counts.duplicateResourceUid),
      };
    },
    async unmatchedProviderRepairSagaCount() {
      return next("saga", counts.unmatchedSaga);
    },
    async legacyRuntimeInputPreparationCount() {
      return next("preparation", counts.legacyPreparation);
    },
    async installRuntimeInputPreparationV2Quiescence() {
      return { status: "installed", predecessorRowCount: 0 };
    },
    async duplicateLiveNativeClaimCount() {
      return next("nativeClaim", counts.duplicateNativeClaim);
    },
  };
}

function processFixture(
  environment: "rehearsal" | "production" = "rehearsal",
  migrationApplyResult: CommandResult = ok("applied migrations\n"),
) {
  const calls: string[][] = [];
  let appliedFiles: readonly string[] = [];
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
    if (command.includes("migrations") && command.includes("apply")) {
      const configPath = command.at(command.indexOf("--config") + 1);
      if (!configPath) throw new Error("migration apply did not name its sealed config");
      const config = JSON.parse(readFileSync(configPath, "utf8")) as {
        d1_databases: { migrations_dir: string }[];
      };
      const [database] = config.d1_databases;
      if (!database) throw new Error("sealed config omitted its D1 database");
      const migrationDirectory = resolve(dirname(configPath), database.migrations_dir);
      appliedFiles = readdirSync(migrationDirectory).sort();
      return migrationApplyResult;
    }
    throw new Error(`unexpected command: ${key}`);
  };
  return { run, calls, appliedFiles: () => appliedFiles };
}

function databaseThrough(count: number): Database {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE d1_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  for (const migration of MIGRATIONS.slice(0, count)) {
    database.exec(migration.sql);
    database
      .query("INSERT INTO d1_migrations (name, applied_at) VALUES (?, 'now')")
      .run(migration.name);
  }
  return database;
}

function d1ReadProcess(database: Database): SchemaProcess {
  return async (command): Promise<CommandResult> => {
    const commandIndex = command.indexOf("--command");
    if (commandIndex < 0) throw new Error(`unexpected command: ${command.join(" ")}`);
    const sql = command[commandIndex + 1];
    if (!sql) throw new Error("D1 read omitted SQL");
    const results = database.query(sql).all() as Record<string, unknown>[];
    return ok(`${JSON.stringify([{ success: true, results }])}\n`);
  };
}

async function databaseState(database: Database): Promise<D1SchemaState> {
  return await readD1SchemaState(
    new RemoteD1("/unused/wrangler.jsonc", {
      environment: {},
      run: d1ReadProcess(database),
    }),
  );
}

function insertLegacyPreparation(database: Database, suffix: string): void {
  database
    .query(
      `INSERT INTO worker_runtime_input_preparations (
         organization_id, operation_id, preparation_id, preparation_commitment,
         material_set_id, material_set_nonce, space, worker_name, endpoint_name,
         worker_resource_uid, worker_resource_revision, bundle_name,
         origin_reservation_id, origin_reservation_revision, canonical_public_origin,
         provider_pack_ref, provider_installation_ref, offering_id, offering_digest,
         binding_names_json, sealed_payload, seal_nonce, seal_key_id, state, fence,
         expires_at, created_at, updated_at
       ) VALUES (
         ?, ?, ?, ?, 'material-set', 'material-nonce', 'main', 'worker', 'endpoint',
         'uid_worker', '1', 'bundle', 'reservation', 1, 'https://worker.example.test',
         'provider-pack', 'provider-installation', 'offering', ?,
         '["SECRET"]', 'sealed', 'nonce', 'key', 'prepared', 1, 3601, 1, 1
       )`,
    )
    .run(
      `org_${suffix}`,
      `operation-${suffix}`,
      `preparation-${suffix}`,
      `sha256:${"b".repeat(64)}`,
      `sha256:${"c".repeat(64)}`,
    );
}

function databaseLaneProcess(
  database: Database,
  onImmediatelyBeforeMigrations: () => void,
  onImmediatelyBeforeQuiescence: () => void = () => {},
): { readonly run: SchemaProcess; readonly migrationApplyCalls: () => number } {
  const fixture = processFixture();
  let migrationApplyCalls = 0;
  return {
    async run(command) {
      if (command.includes("execute") && command.includes("--command")) {
        const sql = command[command.indexOf("--command") + 1];
        if (sql === undefined) throw new Error("D1 command omitted SQL");
        if (command.includes("--json")) {
          try {
            const results = database.query(sql).all() as Record<string, unknown>[];
            return ok(`${JSON.stringify([{ success: true, results }])}\n`);
          } catch (error) {
            return { exitCode: 1, stdout: "", stderr: String(error) };
          }
        }
        try {
          if (sql.includes("takoserver_0037_worker_runtime_input_preparations_quiescence")) {
            onImmediatelyBeforeQuiescence();
            const triggerEnd = sql.indexOf("\nEND;");
            if (triggerEnd < 0) throw new Error("quiescence trigger is not a compound statement");
            const trigger = sql.slice(0, triggerEnd + "\nEND".length);
            const remainder = sql.slice(triggerEnd + "\nEND;".length);
            const statements = remainder
              .split(";")
              .map((statement) => statement.trim())
              .filter(Boolean);
            database.transaction(() => {
              database.exec(trigger);
              for (const statement of statements) database.exec(statement);
            })();
          } else {
            database.transaction(() => database.exec(sql))();
          }
          return ok("guard applied\n");
        } catch (error) {
          return { exitCode: 1, stdout: "", stderr: String(error) };
        }
      }
      if (command.includes("migrations") && command.includes("apply")) {
        migrationApplyCalls += 1;
        onImmediatelyBeforeMigrations();
        const applied = Number(
          (database.query("SELECT COUNT(*) AS count FROM d1_migrations").get() as { count: number })
            .count,
        );
        for (const migration of MIGRATIONS.slice(applied, 42)) {
          database.transaction(() => {
            database.exec(migration.sql);
            database
              .query("INSERT INTO d1_migrations (name, applied_at) VALUES (?, 'now')")
              .run(migration.name);
          })();
        }
        return ok("applied migrations\n");
      }
      return await fixture.run(command);
    },
    migrationApplyCalls: () => migrationApplyCalls,
  };
}

async function rehearsalReceiptChainThrough0036(
  root: string,
): Promise<{ readonly receiptPath: string; readonly state: D1SchemaState }> {
  const boundaries = [
    ["0028", 22, 28],
    ["0033", 28, 33],
    ["0036", 33, 36],
  ] as const;
  const databases = [
    databaseThrough(22),
    databaseThrough(28),
    databaseThrough(33),
    databaseThrough(36),
  ];
  try {
    const states = await Promise.all(databases.map(databaseState));
    let predecessorReceiptPath: string | undefined;
    for (const [index, [throughMigration]] of boundaries.entries()) {
      const receiptPath = join(root, `${throughMigration}.chain.receipt.json`);
      await runD1Schema(
        { action: "apply", environment: "rehearsal", commit: COMMIT, throughMigration },
        target,
        {
          run: processFixture().run,
          reader: dataReaderSequence([
            states[index] as D1SchemaState,
            states[index] as D1SchemaState,
            states[index] as D1SchemaState,
            states[index + 1] as D1SchemaState,
          ]),
          outputDirectory: join(root, `${throughMigration}-chain-work`),
          receiptPath,
          ...(predecessorReceiptPath === undefined ? {} : { predecessorReceiptPath }),
          review: "reviewer@example.test",
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      );
      predecessorReceiptPath = receiptPath;
    }
    return {
      receiptPath: predecessorReceiptPath as string,
      state: states[3] as D1SchemaState,
    };
  } finally {
    for (const database of databases) database.close();
  }
}

describe("production-shaped D1 migration lane", () => {
  test("integration rejects every protected wave selector at the runtime boundary", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-schema-integration-selector-"));
    try {
      const fixture = processFixture();
      for (const throughMigration of ["0028", "0033", "0036", "0042"] as const) {
        const failure = await runD1Schema(
          {
            action: "status",
            environment: "integration",
            commit: COMMIT,
            throughMigration,
          },
          { ...target, environment: "integration" },
          {
            run: fixture.run,
            reader: readerSequence([stateThrough(22, "i")]),
            outputDirectory: join(root, `work-${throughMigration}`),
            cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          },
        ).catch((error) => error);
        expect(failure).toBeInstanceOf(DeployError);
        expect(failure.message).toContain("integration D1 schema accepts no wave selector");
      }
      expect(fixture.calls).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the rehearsal-only baseline owns exactly empty to 0022 and seals only that prefix", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-schema-baseline-"));
    try {
      chmodSync(root, 0o700);
      const fixture = processFixture();
      const post = stateThrough(22, "b");
      const result = await runD1SchemaRehearsalBaseline(
        { action: "apply", environment: "rehearsal", commit: COMMIT },
        target,
        {
          run: fixture.run,
          reader: readerSequence([EMPTY, EMPTY, EMPTY, post]),
          outputDirectory: join(root, "work"),
          review: "reviewer@example.test",
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      );

      expect(result).toMatchObject({
        kind: "takoserver.d1-schema-rehearsal-baseline-apply@v1",
        environment: "rehearsal",
        baselineThroughMigration: "0022_takoform_admission.sql",
        preAppliedMigrations: [],
        appliedMigrations: MIGRATIONS.slice(0, 22).map(({ name }) => name),
        rehearsalReceipt: "not-emitted-by-baseline",
      });
      expect(fixture.appliedFiles()).toEqual(MIGRATIONS.slice(0, 22).map(({ name }) => name));
      expect(
        fixture.calls.filter((call) => call.includes("migrations") && call.includes("apply")),
      ).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the baseline refuses production, selectors, and any nonempty lineage or schema shape", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-schema-baseline-refusal-"));
    try {
      const fixture = processFixture();
      for (const [invocation, selectedTarget, state, expected] of [
        [
          { action: "status", environment: "production", commit: COMMIT },
          { ...target, environment: "production" },
          EMPTY,
          "rehearsal-only",
        ],
        [
          {
            action: "status",
            environment: "rehearsal",
            commit: COMMIT,
            throughMigration: "0028",
          },
          target,
          EMPTY,
          "accepts no wave selector",
        ],
        [
          { action: "apply", environment: "rehearsal", commit: COMMIT },
          target,
          stateThrough(1, "n"),
          "exact empty selected database",
        ],
        [
          { action: "apply", environment: "rehearsal", commit: COMMIT },
          target,
          { ...EMPTY, shape: "drift\n", shapeDigest: `sha256:${"d".repeat(64)}` },
          "exact empty selected database",
        ],
      ] as const) {
        const failure = await runD1SchemaRehearsalBaseline(invocation, selectedTarget, {
          run: fixture.run,
          reader: readerSequence([state]),
          outputDirectory: join(root, `work-${expected.replaceAll(" ", "-")}`),
          review: "reviewer@example.test",
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        }).catch((error) => error);
        expect(failure.message).toContain(expected);
      }
      expect(fixture.calls).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a selected wave seals only its through-prefix and receipts the exact wave bytes", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-schema-wave-"));
    try {
      chmodSync(root, 0o700);
      const fixture = processFixture();
      const pre = stateThrough(22, "a");
      const post = stateThrough(28, "b");
      const receiptPath = join(root, "0023-0028.receipt.json");
      const result = await runD1Schema(
        {
          action: "apply",
          environment: "rehearsal",
          commit: COMMIT,
          throughMigration: "0028",
        },
        target,
        {
          run: fixture.run,
          reader: readerSequence([pre, pre, pre, post]),
          outputDirectory: join(root, "work"),
          receiptPath,
          review: "reviewer@example.test",
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      );

      const expectedWave = MIGRATIONS.slice(22, 28).map(({ name }) => name);
      expect(result).toMatchObject({
        kind: "takoserver.d1-schema-apply@v3",
        fromMigration: "0022_takoform_admission.sql",
        throughMigration: "0028_reseller_settlement_cancellation.sql",
        pendingMigrations: expectedWave,
        lastAppliedMigration: "0028_reseller_settlement_cancellation.sql",
        nextPendingMigration: null,
      });
      expect(fixture.appliedFiles()).toEqual(MIGRATIONS.slice(0, 28).map(({ name }) => name));
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
      expect(receipt).toMatchObject({
        kind: "takoserver.d1-schema-rehearsal-receipt@v3",
        fromMigration: "0022_takoform_admission.sql",
        throughMigration: "0028_reseller_settlement_cancellation.sql",
        preAppliedMigrations: MIGRATIONS.slice(0, 22).map(({ name }) => name),
        postAppliedMigrations: MIGRATIONS.slice(0, 28).map(({ name }) => name),
      });
      expect(receipt.migrationFiles.map(({ name }: { name: string }) => name)).toEqual(
        expectedWave,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a fixed wave refuses source-lineage drift even when numbering remains gap-free", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-schema-lineage-drift-"));
    try {
      const migrationDirectory = join(root, "migrations");
      cpSync(resolve(import.meta.dir, "../migrations"), migrationDirectory, { recursive: true });
      renameSync(
        join(migrationDirectory, "0027_reseller_settlement_intents.sql"),
        join(migrationDirectory, "0027_drifted_settlement_intents.sql"),
      );
      const failure = await runD1Schema(
        {
          action: "status",
          environment: "rehearsal",
          commit: COMMIT,
          throughMigration: "0028",
        },
        target,
        {
          reader: readerSequence([stateThrough(22, "l")]),
          migrationDirectory,
          outputDirectory: join(root, "work"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      ).catch((error) => error);
      expect(failure.message).toContain("exact audited source inventory");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a later wave refuses an edited already-applied migration even when names remain exact", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-schema-byte-drift-"));
    try {
      const migrationDirectory = join(root, "migrations");
      cpSync(resolve(import.meta.dir, "../migrations"), migrationDirectory, { recursive: true });
      const earlier = join(migrationDirectory, "0005_resource_deployments.sql");
      writeFileSync(earlier, `${readFileSync(earlier, "utf8")}\n-- edited after wave 0028\n`);
      const failure = await runD1Schema(
        {
          action: "status",
          environment: "rehearsal",
          commit: COMMIT,
          throughMigration: "0033",
        },
        target,
        {
          reader: readerSequence([stateThrough(28, "h")]),
          migrationDirectory,
          outputDirectory: join(root, "work"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      ).catch((error) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect(failure.message).toContain("exact audited migration SHA-256");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a fixed wave refuses migrations outside the exact audited 0001-0042 inventory", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-schema-lineage-extension-"));
    try {
      const migrationDirectory = join(root, "migrations");
      cpSync(resolve(import.meta.dir, "../migrations"), migrationDirectory, { recursive: true });
      copyFileSync(
        join(migrationDirectory, "0042_worker_endpoint_origin_reservation_space_id.sql"),
        join(migrationDirectory, "0043_unreviewed_extension.sql"),
      );
      const failure = await runD1Schema(
        {
          action: "status",
          environment: "rehearsal",
          commit: COMMIT,
          throughMigration: "0028",
        },
        target,
        {
          reader: readerSequence([stateThrough(22, "l")]),
          migrationDirectory,
          outputDirectory: join(root, "work"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      ).catch((error) => error);
      expect(failure.message).toContain("exact audited source inventory");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the four no-overwrite wave receipts cover the exact 20-file production suffix once", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-schema-all-waves-"));
    try {
      chmodSync(root, 0o700);
      const waves = [
        ["0028", 22, 28],
        ["0033", 28, 33],
        ["0036", 33, 36],
        ["0042", 36, 42],
      ] as const;
      const receipted: {
        readonly name: string;
        readonly digest: string;
        readonly bytes: number;
      }[] = [];
      let predecessorReceiptPath: string | undefined;
      let previousPost = stateThrough(22, "p0022");
      for (const [throughMigration, from, through] of waves) {
        const fixture = processFixture();
        const pre = previousPost;
        expect(pre.applied).toEqual(MIGRATIONS.slice(0, from).map(({ name }) => name));
        const post = stateThrough(through, `q${throughMigration}`);
        const receiptPath = join(root, `${throughMigration}.receipt.json`);
        await runD1Schema(
          { action: "apply", environment: "rehearsal", commit: COMMIT, throughMigration },
          target,
          {
            run: fixture.run,
            reader: dataReaderSequence([pre, pre, pre, post]),
            outputDirectory: join(root, `work-${throughMigration}`),
            receiptPath,
            ...(predecessorReceiptPath === undefined ? {} : { predecessorReceiptPath }),
            review: "reviewer@example.test",
            cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          },
        );
        const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
          migrationFiles: { name: string; digest: string; bytes: number }[];
        };
        receipted.push(...receipt.migrationFiles);
        expect(fixture.appliedFiles()).toEqual(
          MIGRATIONS.slice(0, through).map(({ name }) => name),
        );
        predecessorReceiptPath = receiptPath;
        previousPost = post;
      }

      expect(receipted).toEqual(
        readMigrationArtifact()
          .files.slice(22)
          .map(({ name, digest, bytes }) => ({
            name,
            digest,
            bytes,
          })),
      );
      expect(new Set(receipted.map(({ name }) => name)).size).toBe(20);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("later rehearsal receipts require and cryptographically bind the exact predecessor", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-schema-receipt-chain-"));
    try {
      chmodSync(root, 0o700);
      const firstPath = join(root, "0028.receipt.json");
      const firstPre = stateThrough(22, "a");
      const firstPost = stateThrough(28, "b");
      await runD1Schema(
        { action: "apply", environment: "rehearsal", commit: COMMIT, throughMigration: "0028" },
        target,
        {
          run: processFixture().run,
          reader: readerSequence([firstPre, firstPre, firstPre, firstPost]),
          outputDirectory: join(root, "first-work"),
          receiptPath: firstPath,
          review: "reviewer@example.test",
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      );

      const missing = await runD1Schema(
        { action: "apply", environment: "rehearsal", commit: COMMIT, throughMigration: "0033" },
        target,
        {
          run: processFixture().run,
          reader: dataReaderSequence([firstPost, firstPost, firstPost]),
          outputDirectory: join(root, "missing-work"),
          receiptPath: join(root, "0033-missing.receipt.json"),
          review: "reviewer@example.test",
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      ).catch((error) => error);
      expect(missing.message).toContain("predecessor rehearsal receipt");

      const secondPath = join(root, "0033.receipt.json");
      const secondPost = stateThrough(33, "c");
      await runD1Schema(
        { action: "apply", environment: "rehearsal", commit: COMMIT, throughMigration: "0033" },
        target,
        {
          run: processFixture().run,
          reader: dataReaderSequence([firstPost, firstPost, firstPost, secondPost]),
          outputDirectory: join(root, "second-work"),
          receiptPath: secondPath,
          predecessorReceiptPath: firstPath,
          review: "reviewer@example.test",
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      );
      const second = JSON.parse(readFileSync(secondPath, "utf8"));
      expect(second).toMatchObject({
        kind: "takoserver.d1-schema-rehearsal-receipt@v3",
        predecessorReceipt: {
          receipt: {
            throughMigration: "0028_reseller_settlement_cancellation.sql",
            predecessorReceipt: null,
          },
        },
      });
      expect(second.predecessorReceipt.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);

      second.predecessorReceipt.receipt.postShapeDigest = `sha256:${"f".repeat(64)}`;
      writeFileSync(secondPath, `${JSON.stringify(second, null, 2)}\n`, { mode: 0o600 });
      const forged = await runD1Schema(
        { action: "apply", environment: "production", commit: COMMIT, throughMigration: "0033" },
        { ...target, environment: "production" },
        {
          run: processFixture("production").run,
          reader: dataReaderSequence([firstPost, firstPost, firstPost]),
          outputDirectory: join(root, "forged-work"),
          receiptPath: secondPath,
          review: "second-reviewer@example.test",
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      ).catch((error) => error);
      expect(forged.message).toContain("predecessor receipt digest");

      second.predecessorReceipt.digest = `sha256:${createHash("sha256")
        .update(`${JSON.stringify(second.predecessorReceipt.receipt, null, 2)}\n`)
        .digest("hex")}`;
      writeFileSync(secondPath, `${JSON.stringify(second, null, 2)}\n`, { mode: 0o600 });
      const mismatched = await runD1Schema(
        { action: "apply", environment: "production", commit: COMMIT, throughMigration: "0033" },
        { ...target, environment: "production" },
        {
          run: processFixture("production").run,
          reader: dataReaderSequence([firstPost, firstPost, firstPost]),
          outputDirectory: join(root, "mismatched-work"),
          receiptPath: secondPath,
          review: "second-reviewer@example.test",
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      ).catch((error) => error);
      expect(mismatched.message).toContain("mismatched predecessor transition");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the 0037 quiescence rejects a late predecessor insert before table replacement", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-schema-0037-quiescence-"));
    const database = databaseThrough(36);
    try {
      chmodSync(root, 0o700);
      const predecessor = await rehearsalReceiptChainThrough0036(root);
      expect(await databaseState(database)).toEqual(predecessor.state);
      let lateInsertRejected = false;
      const process = databaseLaneProcess(database, () => {
        try {
          insertLegacyPreparation(database, "late");
        } catch (error) {
          lateInsertRejected = String(error).includes("runtime_input_preparation_v2_quiesced");
        }
      });
      const receiptPath = join(root, "0042.receipt.json");
      await runD1Schema(
        { action: "apply", environment: "rehearsal", commit: COMMIT, throughMigration: "0042" },
        target,
        {
          run: process.run,
          migrationDirectory: resolve(import.meta.dir, "../migrations"),
          outputDirectory: join(root, "0042-work"),
          receiptPath,
          predecessorReceiptPath: predecessor.receiptPath,
          review: "reviewer@example.test",
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      );
      expect(lateInsertRejected).toBe(true);
      expect(process.migrationApplyCalls()).toBe(1);
      expect(
        database.query("SELECT COUNT(*) AS count FROM worker_runtime_input_preparations").get(),
      ).toEqual({ count: 0 });
      const columns = database
        .query(
          "SELECT name FROM pragma_table_info('worker_runtime_input_preparations') ORDER BY cid",
        )
        .all() as { name: string }[];
      expect(columns.map(({ name }) => name)).toContain("operation_key");
      expect(columns.map(({ name }) => name)).not.toContain("operation_id");
    } finally {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a row arriving after the last read-only 0037 count aborts the atomic guard and is preserved", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-schema-0037-zero-race-"));
    const database = databaseThrough(36);
    try {
      chmodSync(root, 0o700);
      const predecessor = await rehearsalReceiptChainThrough0036(root);
      const process = databaseLaneProcess(
        database,
        () => {},
        () => insertLegacyPreparation(database, "between-fence-and-guard"),
      );
      const failure = await runD1Schema(
        { action: "apply", environment: "rehearsal", commit: COMMIT, throughMigration: "0042" },
        target,
        {
          run: process.run,
          outputDirectory: join(root, "0042-work"),
          receiptPath: join(root, "0042.receipt.json"),
          predecessorReceiptPath: predecessor.receiptPath,
          review: "reviewer@example.test",
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      ).catch((error) => error);
      expect(failure).toMatchObject({ phase: "mutation" });
      expect(process.migrationApplyCalls()).toBe(0);
      expect(
        database.query("SELECT COUNT(*) AS count FROM worker_runtime_input_preparations").get(),
      ).toEqual({ count: 1 });
      expect(
        database
          .query(
            "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'trigger' AND name = 'takoserver_0037_worker_runtime_input_preparations_quiescence'",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an exact 0037 guard surviving a crash is validated and resumed without shape drift", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-schema-0037-guard-resume-"));
    const database = databaseThrough(36);
    try {
      chmodSync(root, 0o700);
      const predecessor = await rehearsalReceiptChainThrough0036(root);
      const interruptedProcess = databaseLaneProcess(database, () => {});
      const interruptedRun: SchemaProcess = async (command, options) => {
        if (command.includes("migrations") && command.includes("apply")) {
          throw new Error("simulated process death after the quiescence guard");
        }
        return await interruptedProcess.run(command, options);
      };
      const receiptPath = join(root, "0042.receipt.json");
      const interrupted = await runD1Schema(
        { action: "apply", environment: "rehearsal", commit: COMMIT, throughMigration: "0042" },
        target,
        {
          run: interruptedRun,
          outputDirectory: join(root, "interrupted-work"),
          receiptPath,
          predecessorReceiptPath: predecessor.receiptPath,
          review: "reviewer@example.test",
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      ).catch((error) => error);
      expect(interrupted).toBeInstanceOf(Error);
      expect(existsSync(`${receiptPath}.attempt`)).toBe(true);
      expect(
        database
          .query(
            "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'trigger' AND name = 'takoserver_0037_worker_runtime_input_preparations_quiescence'",
          )
          .get(),
      ).toEqual({ count: 1 });

      const resumedProcess = databaseLaneProcess(database, () => {});
      const resumed = await runD1Schema(
        { action: "apply", environment: "rehearsal", commit: COMMIT, throughMigration: "0042" },
        target,
        {
          run: resumedProcess.run,
          outputDirectory: join(root, "resumed-work"),
          receiptPath,
          predecessorReceiptPath: predecessor.receiptPath,
          review: "reviewer@example.test",
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      );
      expect(resumed).toMatchObject({
        runtimeInputQuiescence: "installed-and-zero",
        providerAcknowledgement: "acknowledged",
        lastAppliedMigration: "0042_worker_endpoint_origin_reservation_space_id.sql",
      });
      expect(resumedProcess.migrationApplyCalls()).toBe(1);
      expect(existsSync(`${receiptPath}.attempt`)).toBe(false);
      expect(existsSync(receiptPath)).toBe(true);
    } finally {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("every named data count is rechecked at the final mutation fence", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-schema-0029-fence-"));
    try {
      chmodSync(root, 0o700);
      const cases = [
        ["0033", 28, { malformedFormRef: [0, 0, 1] }],
        ["0033", 28, { duplicateResourceUid: [0, 0, 1] }],
        ["0036", 33, { unmatchedSaga: [0, 0, 1] }],
        ["0042", 36, { legacyPreparation: [0, 0, 1] }],
        ["0042", 36, { duplicateNativeClaim: [0, 0, 1] }],
      ] as const;
      for (const [index, [throughMigration, from, counts]] of cases.entries()) {
        const fixture = processFixture();
        const pre = stateThrough(from, `f${index}`);
        const failure = await runD1Schema(
          {
            action: "apply",
            environment: "rehearsal",
            commit: COMMIT,
            throughMigration,
          },
          target,
          {
            run: fixture.run,
            reader: dataReaderSequence([pre, pre, pre], counts),
            outputDirectory: join(root, `work-${index}`),
            receiptPath: join(root, `receipt-${index}.json`),
            review: "reviewer@example.test",
            cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          },
        ).catch((error) => error);

        expect(failure.message).toContain("data preflights changed at the final mutation fence");
        expect(fixture.calls.some((call) => call.includes("apply"))).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("status names the 0029, 0036, 0037, and 0039 repair counts", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-schema-named-preflights-"));
    try {
      const cases = [
        {
          throughMigration: "0033" as const,
          from: 28,
          counts: { malformedFormRef: [2], duplicateResourceUid: [1] },
          expected: {
            resourceDeletionAttestation: {
              status: "legacy_data_repair_required",
              malformedFormRefCount: 2,
              duplicateLiveResourceUidCount: 1,
            },
          },
        },
        {
          throughMigration: "0036" as const,
          from: 33,
          counts: { unmatchedSaga: [3] },
          expected: {
            providerRepair: {
              status: "operator_reconciliation_required",
              unmatchedDispatchedSagaCount: 3,
            },
          },
        },
        {
          throughMigration: "0042" as const,
          from: 36,
          counts: { legacyPreparation: [4], duplicateNativeClaim: [5] },
          expected: {
            runtimeInputPreparationV2: {
              status: "legacy_data_repair_required",
              predecessorRowCount: 4,
            },
            liveNativeClaim: {
              status: "legacy_data_repair_required",
              duplicateLiveNativeClaimCount: 5,
            },
          },
        },
      ];
      for (const [index, item] of cases.entries()) {
        const result = await runD1Schema(
          {
            action: "status",
            environment: "rehearsal",
            commit: COMMIT,
            throughMigration: item.throughMigration,
          },
          target,
          {
            reader: dataReaderSequence([stateThrough(item.from, `s${index}`)], item.counts),
            outputDirectory: join(root, `work-${index}`),
            cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          },
        );
        expect(result).toMatchObject({
          readyForApply: false,
          dataPreflights: { status: "data_repair_required", ...item.expected },
        });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the named preflights count representative legacy rows through the real SQL reader", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-schema-real-preflights-"));
    const databases: Database[] = [];
    try {
      const resourceDatabase = databaseThrough(28);
      databases.push(resourceDatabase);
      const validResource = JSON.stringify({
        form: {
          formRef: {
            apiVersion: "edge.forms.takoform.com",
            kind: "Thing",
            definitionVersion: "1.0.0",
            schemaDigest: `sha256:${"a".repeat(64)}`,
          },
        },
      });
      const insertResource = resourceDatabase.query(
        `INSERT INTO tf_resources
           (tenant_id, space, api_version, kind, name, uid, generation, revision,
            resource_json, relations_json, updated_at)
         VALUES (?, 'main', 'edge.forms.takoform.com', 'Thing', ?, ?, '1', '1', ?, '[]', 1)`,
      );
      insertResource.run("tenant-duplicate", "first", "uid_duplicate", validResource);
      insertResource.run("tenant-duplicate", "second", "uid_duplicate", validResource);
      insertResource.run("tenant-malformed", "broken", "uid_broken", "{}");
      insertResource.run("tenant-invalid-json", "invalid-json", "uid_invalid_json", "{{");
      const resourceStatus = await runD1Schema(
        {
          action: "status",
          environment: "rehearsal",
          commit: COMMIT,
          throughMigration: "0033",
        },
        target,
        {
          run: d1ReadProcess(resourceDatabase),
          outputDirectory: join(root, "resource-work"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      );
      expect(resourceStatus).toMatchObject({
        dataPreflights: {
          resourceDeletionAttestation: {
            status: "legacy_data_repair_required",
            malformedFormRefCount: 2,
            duplicateLiveResourceUidCount: 1,
          },
        },
      });

      const sagaDatabase = databaseThrough(35);
      databases.push(sagaDatabase);
      sagaDatabase.exec(`
        INSERT INTO tf_provider_mutation_sagas
          (operation_id, replay_key, tenant_id, fingerprint, resource_uid,
           target_space, target_api_version, target_kind, target_name,
           accepted_uid, accepted_generation, accepted_revision, phase,
           receipt_json, authority_head_digest, created_at, updated_at, expires_at,
           execution_lease_token, execution_lease_until, execution_started_at,
           provider_handle, provider_outcome)
        VALUES
          ('op_unmatched', 'replay-unmatched', 'tenant-a', 'fingerprint',
           'uid_unmatched', 'main', 'example.forms.invalid', 'Thing', 'unmatched',
           NULL, NULL, NULL, 'planned', NULL, NULL, 100, 100, 123,
           NULL, NULL, 100, NULL, 'indeterminate');
      `);
      const sagaStatus = await runD1Schema(
        {
          action: "status",
          environment: "rehearsal",
          commit: COMMIT,
          throughMigration: "0036",
        },
        target,
        {
          run: d1ReadProcess(sagaDatabase),
          outputDirectory: join(root, "saga-work"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      );
      expect(sagaStatus).toMatchObject({
        dataPreflights: {
          providerRepair: {
            status: "operator_reconciliation_required",
            unmatchedDispatchedSagaCount: 1,
          },
        },
      });

      const preparationDatabase = databaseThrough(36);
      databases.push(preparationDatabase);
      preparationDatabase
        .query(
          `INSERT INTO worker_runtime_input_preparations (
             organization_id, operation_id, preparation_id, preparation_commitment,
             material_set_id, material_set_nonce, space, worker_name, endpoint_name,
             worker_resource_uid, worker_resource_revision, bundle_name,
             origin_reservation_id, origin_reservation_revision, canonical_public_origin,
             provider_pack_ref, provider_installation_ref, offering_id, offering_digest,
             binding_names_json, sealed_payload, seal_nonce, seal_key_id, state, fence,
             expires_at, created_at, updated_at
           ) VALUES (
             'org_legacy', 'operation-legacy', 'preparation-legacy', ?,
             'material-set', 'material-nonce', 'main', 'worker', 'endpoint',
             'uid_worker', '1', 'bundle', 'reservation', 1, 'https://worker.example.test',
             'provider-pack', 'provider-installation', 'offering', ?,
             '["SECRET"]', 'sealed', 'nonce', 'key', 'prepared', 1, 3601, 1, 1
           )`,
        )
        .run(`sha256:${"b".repeat(64)}`, `sha256:${"c".repeat(64)}`);
      const preparationStatus = await runD1Schema(
        {
          action: "status",
          environment: "rehearsal",
          commit: COMMIT,
          throughMigration: "0042",
        },
        target,
        {
          run: d1ReadProcess(preparationDatabase),
          outputDirectory: join(root, "preparation-work"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      );
      expect(preparationStatus).toMatchObject({
        dataPreflights: {
          runtimeInputPreparationV2: {
            status: "legacy_data_repair_required",
            predecessorRowCount: 1,
          },
        },
      });

      const nativeClaimDatabase = databaseThrough(38);
      databases.push(nativeClaimDatabase);
      for (const [tenant, id] of [
        ["tenant-a", "dep-a"],
        ["tenant-b", "dep-b"],
      ] as const) {
        nativeClaimDatabase
          .query(
            `INSERT INTO tf_resource_deployments
               (tenant_id, id, resource_uid, offering_id, provider_pack_ref,
                provider_installation_ref, native_id, native_claimed, state,
                observed_json, outputs_json, created_at, updated_at)
             VALUES (?, ?, ?, 'offering.test', 'cloudflare', 'installation.test',
                     'r2:shared', 0, 'active', '{}', '{}', 1, 1)`,
          )
          .run(tenant, id, `uid_${id}`);
      }
      const nativeClaimStatus = await runD1Schema(
        {
          action: "status",
          environment: "rehearsal",
          commit: COMMIT,
          throughMigration: "0042",
        },
        target,
        {
          run: d1ReadProcess(nativeClaimDatabase),
          outputDirectory: join(root, "native-claim-work"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      );
      expect(nativeClaimStatus).toMatchObject({
        dataPreflights: {
          liveNativeClaim: {
            status: "legacy_data_repair_required",
            duplicateLiveNativeClaimCount: 1,
          },
        },
      });
    } finally {
      for (const database of databases) database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a provider partial failure reports authoritative progress and only the same receipt-bound wave resumes", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-schema-partial-"));
    try {
      chmodSync(root, 0o700);
      const pre = stateThrough(22, "a");
      const partial = stateThrough(25, "x");
      const post = stateThrough(28, "b");
      const receiptPath = join(root, "0028.receipt.json");
      await runD1Schema(
        {
          action: "apply",
          environment: "rehearsal",
          commit: COMMIT,
          throughMigration: "0028",
        },
        target,
        {
          run: processFixture().run,
          reader: readerSequence([pre, pre, pre, post]),
          outputDirectory: join(root, "rehearsal-work"),
          receiptPath,
          review: "reviewer@example.test",
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      );

      const productionTarget = { ...target, environment: "production" as const };
      const unprovenProcess = processFixture("production");
      const unproven = await runD1Schema(
        {
          action: "apply",
          environment: "production",
          commit: COMMIT,
          throughMigration: "0028",
        },
        productionTarget,
        {
          run: unprovenProcess.run,
          reader: readerSequence([partial, partial, partial]),
          outputDirectory: join(root, "unproven-production-work"),
          receiptPath,
          review: "second-reviewer@example.test",
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      ).catch((error) => error);
      expect(unproven.message).toContain("original no-overwrite attempt evidence");
      expect(unprovenProcess.calls.some((call) => call.includes("apply"))).toBe(false);

      const failedProcess = processFixture("production", {
        exitCode: 1,
        stdout: "applied through 0025\n",
        stderr: "provider connection lost\n",
      });
      const failure = await runD1Schema(
        {
          action: "apply",
          environment: "production",
          commit: COMMIT,
          throughMigration: "0028",
        },
        productionTarget,
        {
          run: failedProcess.run,
          reader: readerSequence([pre, pre, pre, partial]),
          outputDirectory: join(root, "failed-production-work"),
          receiptPath,
          review: "second-reviewer@example.test",
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      ).catch((error) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect(failure).toMatchObject({ phase: "mutation" });
      expect(JSON.parse(failure.detail)).toMatchObject({
        lastAppliedMigration: "0025_resource_migration_execution.sql",
        nextPendingMigration: "0026_takoform_provider_mutation_outcomes.sql",
        schemaShapeDigest: partial.shapeDigest,
        throughMigration: "0028_reseller_settlement_cancellation.sql",
      });
      expect(existsSync(`${receiptPath}.production-attempt`)).toBe(true);

      const status = await runD1Schema(
        {
          action: "status",
          environment: "production",
          commit: COMMIT,
          throughMigration: "0028",
        },
        productionTarget,
        {
          reader: readerSequence([partial]),
          outputDirectory: join(root, "status-work"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      );
      expect(status).toMatchObject({
        lastAppliedMigration: "0025_resource_migration_execution.sql",
        nextPendingMigration: "0026_takoform_provider_mutation_outcomes.sql",
      });

      const skipped = await runD1Schema(
        {
          action: "status",
          environment: "production",
          commit: COMMIT,
          throughMigration: "0033",
        },
        productionTarget,
        {
          reader: readerSequence([partial]),
          outputDirectory: join(root, "skipped-work"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      ).catch((error) => error);
      expect(skipped.message).toContain("cannot skip or replay a boundary");

      const resumedProcess = processFixture("production");
      const resumed = await runD1Schema(
        {
          action: "apply",
          environment: "production",
          commit: COMMIT,
          throughMigration: "0028",
        },
        productionTarget,
        {
          run: resumedProcess.run,
          reader: readerSequence([partial, partial, partial, post]),
          outputDirectory: join(root, "resumed-production-work"),
          receiptPath,
          review: "second-reviewer@example.test",
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      );
      expect(resumed).toMatchObject({
        environment: "production",
        throughMigration: "0028_reseller_settlement_cancellation.sql",
        lastAppliedMigration: "0028_reseller_settlement_cancellation.sql",
        nextPendingMigration: null,
        rehearsalReceipt: "exact-match-consumed-read-only",
      });
      expect(
        resumedProcess.calls.filter(
          (call) => call.includes("migrations") && call.includes("apply"),
        ),
      ).toHaveLength(1);
      expect(existsSync(`${receiptPath}.production-attempt`)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an active schema attempt owns an exclusive lease and a concurrent resume cannot apply", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-schema-exclusive-lease-"));
    try {
      chmodSync(root, 0o700);
      const pre = stateThrough(22, "l");
      const post = stateThrough(28, "m");
      const receiptPath = join(root, "0028.receipt.json");
      const leaseRoot = join(root, "leases");
      let enteredApply: (() => void) | undefined;
      let releaseApply: (() => void) | undefined;
      const entered = new Promise<void>((resolve) => {
        enteredApply = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseApply = resolve;
      });
      const firstFixture = processFixture();
      const firstRun: SchemaProcess = async (command, options) => {
        if (command.includes("migrations") && command.includes("apply")) {
          enteredApply?.();
          await release;
        }
        return await firstFixture.run(command, options);
      };
      const firstPromise = runD1Schema(
        { action: "apply", environment: "rehearsal", commit: COMMIT, throughMigration: "0028" },
        target,
        {
          run: firstRun,
          reader: readerSequence([pre, pre, pre, post]),
          outputDirectory: join(root, "first-work"),
          receiptPath,
          leaseRoot,
          review: "reviewer@example.test",
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      ).catch((error) => error);
      await entered;

      const secondFixture = processFixture();
      const second = await runD1Schema(
        { action: "apply", environment: "rehearsal", commit: COMMIT, throughMigration: "0028" },
        target,
        {
          run: secondFixture.run,
          reader: readerSequence([pre, pre, pre, post]),
          outputDirectory: join(root, "second-work"),
          receiptPath,
          leaseRoot,
          review: "reviewer@example.test",
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      ).catch((error) => error);
      releaseApply?.();
      const first = await firstPromise;

      expect(second).toBeInstanceOf(DeployError);
      expect(second.message).toContain("active kernel lease");
      expect(secondFixture.calls.some((call) => call.includes("apply"))).toBe(false);
      expect(first).not.toBeInstanceOf(Error);
      expect(firstFixture.calls.filter((call) => call.includes("apply"))).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a lost acknowledgement after D1 reaches the boundary finalizes without a second apply", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-schema-lost-ack-finalize-"));
    try {
      chmodSync(root, 0o700);
      const pre = stateThrough(22, "n");
      const post = stateThrough(28, "o");
      let state = pre;
      let loseFirstVerification = true;
      const reader: SchemaReader = {
        async read(phase) {
          if (phase === "verification" && loseFirstVerification) {
            loseFirstVerification = false;
            throw new Error("simulated process death before receipt finalization");
          }
          return state;
        },
      };
      const firstFixture = processFixture();
      const firstRun: SchemaProcess = async (command, options) => {
        const result = await firstFixture.run(command, options);
        if (command.includes("migrations") && command.includes("apply")) state = post;
        return result;
      };
      const receiptPath = join(root, "0028.receipt.json");
      const leaseRoot = join(root, "leases");
      const interrupted = await runD1Schema(
        { action: "apply", environment: "rehearsal", commit: COMMIT, throughMigration: "0028" },
        target,
        {
          run: firstRun,
          reader,
          outputDirectory: join(root, "interrupted-work"),
          receiptPath,
          leaseRoot,
          review: "reviewer@example.test",
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      ).catch((error) => error);
      expect(interrupted).toBeInstanceOf(Error);
      expect(existsSync(receiptPath)).toBe(false);
      expect(existsSync(`${receiptPath}.attempt`)).toBe(true);

      const recoveryFixture = processFixture();
      const recovered = await runD1Schema(
        { action: "apply", environment: "rehearsal", commit: COMMIT, throughMigration: "0028" },
        target,
        {
          run: recoveryFixture.run,
          reader,
          outputDirectory: join(root, "recovery-work"),
          receiptPath,
          leaseRoot,
          review: "reviewer@example.test",
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      );
      expect(recovered).toMatchObject({
        providerAcknowledgement: "reconciled-complete-without-second-apply",
        lastAppliedMigration: "0028_reseller_settlement_cancellation.sql",
      });
      expect(recoveryFixture.calls.some((call) => call.includes("apply"))).toBe(false);
      expect(existsSync(receiptPath)).toBe(true);
      expect(existsSync(`${receiptPath}.attempt`)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a partial rehearsal resumes only from its original no-overwrite attempt evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-schema-rehearsal-partial-"));
    try {
      chmodSync(root, 0o700);
      const pre = stateThrough(22, "c");
      const partial = stateThrough(26, "d");
      const post = stateThrough(28, "e");
      const receiptPath = join(root, "0028.receipt.json");
      const failed = processFixture("rehearsal", {
        exitCode: 1,
        stdout: "",
        stderr: "provider connection lost\n",
      });
      const failure = await runD1Schema(
        {
          action: "apply",
          environment: "rehearsal",
          commit: COMMIT,
          throughMigration: "0028",
        },
        target,
        {
          run: failed.run,
          reader: readerSequence([pre, pre, pre, partial]),
          outputDirectory: join(root, "failed-work"),
          receiptPath,
          review: "reviewer@example.test",
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      ).catch((error) => error);
      expect(failure).toMatchObject({ phase: "mutation" });
      expect(existsSync(receiptPath)).toBe(false);
      expect(existsSync(`${receiptPath}.attempt`)).toBe(true);

      const resumed = processFixture();
      await runD1Schema(
        {
          action: "apply",
          environment: "rehearsal",
          commit: COMMIT,
          throughMigration: "0028",
        },
        target,
        {
          run: resumed.run,
          reader: readerSequence([partial, partial, partial, post]),
          outputDirectory: join(root, "resumed-work"),
          receiptPath,
          review: "reviewer@example.test",
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      );
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
      expect(receipt.preAppliedMigrations).toEqual(MIGRATIONS.slice(0, 22).map(({ name }) => name));
      expect(receipt.preShapeDigest).toBe(pre.shapeDigest);
      expect(existsSync(`${receiptPath}.attempt`)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("failed-apply readback outside the selected wave remains a mutation-phase refusal", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-schema-outside-wave-"));
    try {
      chmodSync(root, 0o700);
      const pre = stateThrough(22, "g");
      const post = stateThrough(28, "h");
      const receiptPath = join(root, "0028.receipt.json");
      await runD1Schema(
        {
          action: "apply",
          environment: "rehearsal",
          commit: COMMIT,
          throughMigration: "0028",
        },
        target,
        {
          run: processFixture().run,
          reader: readerSequence([pre, pre, pre, post]),
          outputDirectory: join(root, "rehearsal-work"),
          receiptPath,
          review: "reviewer@example.test",
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      );
      const failed = processFixture("production", {
        exitCode: 1,
        stdout: "",
        stderr: "provider error\n",
      });
      const failure = await runD1Schema(
        {
          action: "apply",
          environment: "production",
          commit: COMMIT,
          throughMigration: "0028",
        },
        { ...target, environment: "production" },
        {
          run: failed.run,
          reader: readerSequence([pre, pre, pre, stateThrough(29, "z")]),
          outputDirectory: join(root, "production-work"),
          receiptPath,
          review: "second-reviewer@example.test",
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      ).catch((error) => error);
      expect(failure).toMatchObject({
        phase: "mutation",
        message: "D1 migration apply failed and authoritative lineage is outside the selected wave",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}
