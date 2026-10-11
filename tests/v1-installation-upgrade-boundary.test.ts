/**
 * v1.0.0 to v2 is a breaking major without an in-place upgrade of a used v1
 * installation. A control database written by the published v1.0.0 release
 * that records wallet history or v1 Resource state is refused before the
 * first write, by name, and is left byte-for-byte as v1.0.0 wrote it so that
 * release can still run on it. An unused v1.0.0 database keeps migrating.
 *
 * The fixtures were produced by the real v1.0.0 entry (see
 * tests/fixtures/v1.0.0-installation/schema.sql), not reconstructed here.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS } from "../src/db-schema.ts";
import { base64UrlEncode } from "../src/json.ts";
import {
  type MigratableDatabase,
  migrateSqlite,
  type UsedV1Installation,
  UsedV1InstallationError,
} from "../src/migrate-sqlite.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "v1.0.0-installation");
const ENTRY = join(import.meta.dir, "..", "src", "entry-bun.ts");
const V1_RELEASE_MIGRATIONS = MIGRATIONS.slice(0, 15).map((migration) => migration.name);
const ORGANIZATION_PROJECTION = "0016_takos_id_organization_projection.sql";
const DOCUMENTATION =
  "https://github.com/tako0614/takoserver/blob/main/docs/self-host-operations.md#upgrading-from-v100";

type Fixture = "empty" | "signed-in" | "used";

/** Writes a v1.0.0 control database file from the committed fixture. */
function writeV1Database(path: string, fixture: Fixture, adjust?: (db: Database) => void): void {
  const database = new Database(path);
  try {
    database.exec(readFileSync(join(FIXTURES, "schema.sql"), "utf8"));
    database.exec(readFileSync(join(FIXTURES, `${fixture}.sql`), "utf8"));
    // Bun's exec can stop at a failed statement without saying so; prove the
    // fixture loaded completely before relying on it.
    expect(recordedMigrations(database)).toEqual(V1_RELEASE_MIGRATIONS);
    expect(count(database, "sqlite_schema")).toBe(88);
    adjust?.(database);
  } finally {
    database.close();
  }
}

function recordedMigrations(database: Database): string[] {
  return (
    database.query("SELECT name FROM applied_migrations ORDER BY name").all() as {
      name: string;
    }[]
  ).map((row) => row.name);
}

function count(database: Database, table: string): number {
  return (database.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Every entry under a directory with its type, mode and content digest. */
function snapshot(root: string): string[] {
  const entries: string[] = [`./ ${(lstatSync(root).mode & 0o7777).toString(8)}`];
  const walk = (directory: string, prefix: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      const mode = (stat.mode & 0o7777).toString(8);
      if (stat.isDirectory()) {
        entries.push(`${prefix}${name}/ ${mode}`);
        walk(path, `${prefix}${name}/`);
      } else {
        entries.push(`${prefix}${name} ${mode} ${stat.size} ${sha256(path)}`);
      }
    }
  };
  walk(root, "");
  return entries;
}

/** A database handle that fails any statement other than a read. */
function readOnlyView(database: Database): MigratableDatabase & { readonly writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    exec(sql: string) {
      writes.push(sql.trim().split(/\s+/u).slice(0, 3).join(" "));
      throw new Error("the v1 upgrade boundary must not write");
    },
    query(sql: string) {
      return database.query(sql);
    },
  };
}

function refusalOf(action: () => unknown): UsedV1InstallationError {
  try {
    action();
  } catch (error) {
    if (error instanceof UsedV1InstallationError) return error;
    throw error;
  }
  throw new Error("expected the used v1 installation to be refused");
}

async function withRoot<T>(run: (root: string) => Promise<T> | T): Promise<T> {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "v1-upgrade-")));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const USED: UsedV1Installation = {
  lastRecordedMigration: "0015_takoform_resource_relations.sql",
  v1ReleaseHistory: true,
  recordedAfterV1Release: [],
  ledgerEntries: 3,
  v1Resources: 1,
  v1ProviderDeployments: 1,
};

describe("a used v1.0.0 installation", () => {
  test("is refused before the first write and its database stays byte-identical", async () => {
    await withRoot((root) => {
      const path = join(root, "control.sqlite");
      writeV1Database(path, "used");
      const before = sha256(path);

      const database = new Database(path);
      // Not one statement is executed: the refusal is decided by reads alone.
      const view = readOnlyView(database);
      const refusal = refusalOf(() => migrateSqlite(view));
      expect(view.writes).toEqual([]);
      expect(refusal.installation).toEqual(USED);
      // And through an ordinary writable handle, as the entry opens it.
      expect(
        refusalOf(() =>
          migrateSqlite(database, { installation: { dataRoot: root, databasePath: path } }),
        ).installation,
      ).toEqual(USED);
      database.close();

      expect(sha256(path)).toBe(before);
      expect(existsSync(`${path}-journal`)).toBe(false);
      const reopened = new Database(path, { readonly: true });
      expect(recordedMigrations(reopened)).toEqual(V1_RELEASE_MIGRATIONS);
      expect(count(reopened, "ledger")).toBe(3);
      reopened.close();
    });
  });

  test("names the files, the v1.0.0 release, the unsupported upgrade and the documentation", async () => {
    await withRoot((root) => {
      const path = join(root, "control.sqlite");
      writeV1Database(path, "used");
      const database = new Database(path);
      const refusal = refusalOf(() =>
        migrateSqlite(database, { installation: { dataRoot: root, databasePath: path } }),
      );
      database.close();
      expect(refusal.message).toBe(
        [
          `Takoserver will not start on data root ${root} (control database ${path}): it was created by the Takoserver v1.0.0 release (recorded migrations end at 0015_takoform_resource_relations.sql) and holds v1 state: 3 wallet ledger entries, 1 v1 Takoform Resource, 1 v1 provider Deployment.`,
          "This build serves Takoform Host API v2 and does not upgrade a used v1 installation in place. It stopped before writing anything; the database is unchanged.",
          "Leave this data root as it is and start this build on a new, empty TAKOSERVER_DATA_ROOT (and a new TAKOSERVER_DB, if one is set), then recreate the Resources through the v2 API. The v1.0.0 release can still run on this data root.",
          `See "Upgrading from v1.0.0" in docs/self-host-operations.md: ${DOCUMENTATION}`,
        ].join("\n"),
      );
    });
  });

  test("wallet history alone is refused, exactly as 0017 would refuse it", async () => {
    await withRoot((root) => {
      const path = join(root, "control.sqlite");
      // Every v1 Resource was deleted; the money history remains.
      writeV1Database(path, "used", (database) => {
        database.exec("DELETE FROM tf_resources");
        database.exec("UPDATE tf_resource_deployments SET state = 'deleted'");
      });
      const before = sha256(path);
      const database = new Database(path);
      expect(refusalOf(() => migrateSqlite(database)).installation).toEqual({
        ...USED,
        v1Resources: 0,
        v1ProviderDeployments: 0,
      });
      database.close();
      expect(sha256(path)).toBe(before);
    });
  });

  test("v1 Resource state alone is refused, because v2 cannot serve it", async () => {
    await withRoot((root) => {
      const path = join(root, "control.sqlite");
      writeV1Database(path, "used", (database) => database.exec("DELETE FROM ledger"));
      const before = sha256(path);
      const database = new Database(path);
      expect(refusalOf(() => migrateSqlite(database)).installation).toEqual({
        ...USED,
        ledgerEntries: 0,
      });
      database.close();
      expect(sha256(path)).toBe(before);
    });
  });

  test("a held provider Deployment alone is refused", async () => {
    await withRoot((root) => {
      const path = join(root, "control.sqlite");
      writeV1Database(path, "used", (database) => {
        database.exec("DELETE FROM ledger");
        database.exec("DELETE FROM tf_resources");
      });
      const database = new Database(path);
      expect(refusalOf(() => migrateSqlite(database)).installation).toEqual({
        ...USED,
        ledgerEntries: 0,
        v1Resources: 0,
      });
      database.close();
    });
  });

  test("a file an earlier newer build already touched is refused and says v1.0.0 refuses it too", async () => {
    await withRoot((root) => {
      const path = join(root, "control.sqlite");
      // What a build before this boundary left: 0016 committed, 0017 refused.
      writeV1Database(path, "used", (database) => {
        const projection = MIGRATIONS.find(
          (migration) => migration.name === ORGANIZATION_PROJECTION,
        );
        if (!projection) throw new Error("0016 is missing");
        database.exec(projection.sql);
        database
          .query("INSERT INTO applied_migrations (name, applied_at) VALUES (?, 'then')")
          .run(ORGANIZATION_PROJECTION);
        expect(count(database, "org_memberships")).toBe(1);
      });
      const before = sha256(path);
      const database = new Database(path);
      const refusal = refusalOf(() => migrateSqlite(database));
      database.close();
      expect(refusal.installation).toEqual({
        ...USED,
        lastRecordedMigration: ORGANIZATION_PROJECTION,
        recordedAfterV1Release: [ORGANIZATION_PROJECTION],
      });
      expect(refusal.message).toContain(
        `An earlier start of a newer build already recorded ${ORGANIZATION_PROJECTION} here, so v1.0.0 refuses this file too; run v1.0.0 only on a copy taken before that start.`,
      );
      expect(refusal.message).not.toContain("The v1.0.0 release can still run");
      expect(sha256(path)).toBe(before);
    });
  });
});

describe("an unused v1.0.0 installation keeps migrating", () => {
  test("a database v1.0.0 only booted is brought to head", async () => {
    await withRoot((root) => {
      const path = join(root, "control.sqlite");
      writeV1Database(path, "empty");
      const database = new Database(path);
      expect(migrateSqlite(database)).toEqual({
        applied: MIGRATIONS.slice(15).map((migration) => migration.name),
        alreadyApplied: 15,
      });
      expect(migrateSqlite(database)).toEqual({ applied: [], alreadyApplied: MIGRATIONS.length });
      database.close();
    });
  });

  test("a signed-in Organization with API keys and no money or Resource is carried forward", async () => {
    await withRoot((root) => {
      const path = join(root, "control.sqlite");
      writeV1Database(path, "signed-in");
      const database = new Database(path);
      expect(migrateSqlite(database).applied).toEqual(
        MIGRATIONS.slice(15).map((migration) => migration.name),
      );
      expect(count(database, "orgs")).toBe(1);
      expect(
        database.query("SELECT role FROM org_memberships").all() as { role: string }[],
      ).toEqual([{ role: "owner" }]);
      expect(count(database, "auth_tokens")).toBe(2);
      database.close();
    });
  });

  test("a v1 Deployment that was deleted is not held state", async () => {
    await withRoot((root) => {
      const path = join(root, "control.sqlite");
      writeV1Database(path, "used", (database) => {
        database.exec("DELETE FROM ledger");
        database.exec("DELETE FROM tf_resources");
        database.exec("UPDATE tf_resource_deployments SET state = 'deleted'");
      });
      const database = new Database(path);
      expect(migrateSqlite(database).alreadyApplied).toBe(15);
      expect(recordedMigrations(database)).toEqual(MIGRATIONS.map((migration) => migration.name));
      database.close();
    });
  });
});

describe("the Bun entry on a v1.0.0 data root", () => {
  function environment(home: string, port: number, dataRoot: string): Record<string, string> {
    return {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      TMPDIR: home,
      CI: "1",
      NO_COLOR: "1",
      PORT: String(port),
      TAKOSERVER_PUBLIC_ORIGIN: "https://v1-upgrade.takoserver.test",
      TAKOSERVER_TAKOFORM_V2_CONFIG: JSON.stringify({
        documentation: "https://docs.example.test/v2",
        authenticationDocumentation: "https://docs.example.test/v2/authentication",
      }),
      TAKOSERVER_TAKOFORM_V2_CURSOR_KEY: base64UrlEncode(new Uint8Array(32).fill(0x76)),
      TAKOSERVER_DATA_ROOT: dataRoot,
    };
  }

  async function unusedPort(): Promise<number> {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(null, { status: 503 }),
    });
    const port = Number(server.port);
    await server.stop(true);
    return port;
  }

  async function exited(child: ReturnType<typeof Bun.spawn>): Promise<number> {
    const code = await Promise.race([child.exited, Bun.sleep(20_000).then(() => null)]);
    if (code === null) {
      child.kill("SIGKILL");
      await child.exited;
      throw new Error("the Bun entry did not exit");
    }
    return code;
  }

  test("refuses a used v1.0.0 data root by name and leaves every file in it unchanged", async () => {
    await withRoot(async (home) => {
      // v1.0.0 created its root with mkdir's default mode.
      const dataRoot = join(home, "takoserver");
      await mkdir(dataRoot, { mode: 0o755 });
      const databasePath = join(dataRoot, "control.sqlite");
      writeV1Database(databasePath, "used");
      const before = snapshot(dataRoot);

      const child = Bun.spawn([process.execPath, "--no-env-file", ENTRY], {
        cwd: home,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: environment(home, await unusedPort(), dataRoot),
      });
      expect(await exited(child)).toBe(1);
      const stderr = await new Response(child.stderr as ReadableStream).text();
      // The message and nothing else: no stack trace burying it.
      expect(stderr).toBe(
        `${new UsedV1InstallationError(USED, { installation: { dataRoot, databasePath } }).message}\n`,
      );
      expect(stderr).toContain(`Takoserver will not start on data root ${dataRoot} `);
      expect(await new Response(child.stdout as ReadableStream).text()).toBe("");
      // No key, socket directory, runtime probe or journal was created either.
      expect(snapshot(dataRoot)).toEqual(before);
    });
  }, 30_000);

  test("starts on an unused v1.0.0 data root and brings it to head", async () => {
    await withRoot(async (home) => {
      const dataRoot = join(home, "takoserver");
      await mkdir(dataRoot, { mode: 0o755 });
      const databasePath = join(dataRoot, "control.sqlite");
      writeV1Database(databasePath, "signed-in");
      const port = await unusedPort();
      const child = Bun.spawn([process.execPath, "--no-env-file", ENTRY], {
        cwd: home,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: environment(home, port, dataRoot),
      });
      try {
        let ready = false;
        const deadline = Date.now() + 20_000;
        while (!ready && Date.now() < deadline && child.exitCode === null) {
          try {
            const response = await fetch(`http://127.0.0.1:${port}/_takoserver/health/ready`, {
              signal: AbortSignal.timeout(500),
            });
            await response.arrayBuffer();
            ready = response.status === 200;
          } catch {
            // The listener may not have bound yet.
          }
          if (!ready) await Bun.sleep(50);
        }
        if (!ready) {
          throw new Error(
            `entry was not ready: ${await new Response(child.stderr as ReadableStream).text()}`,
          );
        }
        child.kill("SIGTERM");
        expect(await exited(child)).toBe(0);
        expect(await new Response(child.stdout as ReadableStream).text()).toContain(
          `applied ${MIGRATIONS.length - 15} migration(s): ${MIGRATIONS.slice(15)
            .map((migration) => migration.name)
            .join(", ")}\n`,
        );
      } finally {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
          await child.exited;
        }
      }
      const database = new Database(databasePath, { readonly: true });
      expect(recordedMigrations(database)).toEqual(MIGRATIONS.map((migration) => migration.name));
      expect(count(database, "orgs")).toBe(1);
      database.close();
    });
  }, 30_000);
});
