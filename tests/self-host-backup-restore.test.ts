import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccounts, type ExternalIdentityVerifier } from "../src/auth.ts";
import { createLedger } from "../src/ledger.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createFileObjectStore } from "../src/objects-fs.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createWorkerdRuntime } from "../src/workerd-runtime.ts";

let sandbox: string | undefined;

afterEach(async () => {
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
  sandbox = undefined;
});

test("a quiescent data-root copy reopens local control, object, and Worker state", async () => {
  sandbox = await mkdtemp(join(tmpdir(), "takoserver-selfhost-backup-"));
  const sourceRoot = join(sandbox, "source");
  const restoredRoot = join(sandbox, "restored");
  const clock = () => new Date("2026-09-30T12:00:00.000Z");

  await mkdir(sourceRoot, { recursive: true });
  const sourceDatabase = new Database(join(sourceRoot, "control.sqlite"));
  migrateSqlite(sourceDatabase);
  const sourceSql = createSqliteSql(sourceDatabase);
  const identity: ExternalIdentityVerifier = {
    async verify({ provider, assertion }) {
      return {
        providerSubject: `${provider}:${assertion}`,
        email: "fixture@example.invalid",
        displayName: "Disposable fixture",
      };
    },
  };
  const accounts = createAccounts({ sql: sourceSql, identity, clock });
  const signedIn = await accounts.signIn({ provider: "google", assertion: "backup-fixture" });
  const actor = await accounts.authenticate(`Bearer ${signedIn.sessionToken}`);
  if (!actor) throw new Error("disposable fixture did not authenticate");
  const organization = await accounts.createOrganization({ actor, name: "Backup fixture" });
  const ledger = createLedger(sourceSql, clock);
  await ledger.fund({
    organizationId: organization.id,
    fundingRef: "fixture-funding",
    amountMinor: 1_000,
  });
  expect(
    await ledger.hold({
      organizationId: organization.id,
      reference: "fixture-hold",
      amountMinor: 200,
    }),
  ).toBe(true);

  const bytes = new TextEncoder().encode("non-secret fixture artifact");
  const sourceObjects = createFileObjectStore({ root: sourceRoot });
  await sourceObjects.put("art/fixture-bundle", bytes, {
    contentType: "application/octet-stream",
  });

  const sourceRuntime = createWorkerdRuntime({ root: sourceRoot });
  await sourceRuntime.write(
    "backup-fixture",
    {
      directory: "backup-fixture",
      mainModule: "index.js",
      hostnames: ["backup-fixture.example.invalid"],
    },
    new Map([["index.js", new TextEncoder().encode("export default { fetch() {} }")]]),
  );
  await sourceRuntime.reload();

  // Closing SQLite and performing no more source writes models the documented
  // stopped-and-quiescent precondition. This is a disposable local copy only.
  sourceDatabase.close();
  await cp(sourceRoot, restoredRoot, { recursive: true, preserveTimestamps: true });

  const restoredDatabase = new Database(join(restoredRoot, "control.sqlite"));
  try {
    const migrationReport = migrateSqlite(restoredDatabase);
    expect(migrationReport.applied).toEqual([]);
    const restoredSql = createSqliteSql(restoredDatabase);
    const restoredOrganization = await restoredSql.query("SELECT id FROM orgs WHERE name = ?", [
      "Backup fixture",
    ]);
    expect(restoredOrganization).toHaveLength(1);
    const wallet = await createLedger(restoredSql, clock).wallet(organization.id);
    expect(wallet).toMatchObject({ settledMinor: 1_000, heldMinor: 200, availableMinor: 800 });
  } finally {
    restoredDatabase.close();
  }

  const restoredObjects = createFileObjectStore({ root: restoredRoot });
  const storedArtifact = await restoredObjects.get("art/fixture-bundle");
  expect(storedArtifact).not.toBeNull();
  expect(new Uint8Array(await new Response(storedArtifact?.body).arrayBuffer())).toEqual(bytes);

  // restore() rebuilds generated config in this temp tree. No onReload hook is
  // supplied, so it starts no workerd child and binds no listener.
  const restoredRuntime = createWorkerdRuntime({ root: restoredRoot });
  expect(await restoredRuntime.restore()).toEqual(["backup-fixture"]);
  expect(await restoredRuntime.has("backup-fixture")).toBe(false);
  expect(
    JSON.parse(
      await readFile(
        join(restoredRoot, "workers", "backup-fixture", "takoserver-site.json"),
        "utf8",
      ),
    ),
  ).toMatchObject({ mainModule: "index.js", hostnames: ["backup-fixture.example.invalid"] });
  expect(
    await readFile(join(restoredRoot, "workers", "backup-fixture", "application", "module-00000")),
  ).toEqual(Buffer.from("export default { fetch() {} }"));
});
