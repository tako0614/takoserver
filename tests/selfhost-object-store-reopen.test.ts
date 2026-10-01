import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { Sql } from "../src/ports.ts";
import { createSelfhostObjectStore } from "../src/selfhost-object-store.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";

const BUCKET = `tsb-${"c".repeat(40)}`;

function body(value: string): ReadableStream<Uint8Array> {
  return new Blob([new TextEncoder().encode(value)]).stream() as ReadableStream<Uint8Array>;
}

async function bodyText(store: ReturnType<typeof createSelfhostObjectStore>, key: string) {
  const object = await store.get(BUCKET, key);
  if (!object) throw new Error(`object ${key} was not completed`);
  return await new Response(object.body).text();
}

function loseCommittedReceiptAcknowledgement(sql: Sql): Sql {
  let loseReceiptAcknowledgement = true;
  let loseImmediateReadback = false;
  return {
    async query(statement, params) {
      if (
        loseImmediateReadback &&
        statement.includes("SELECT size, etag FROM selfhost_object_upload_parts")
      ) {
        loseImmediateReadback = false;
        throw new Error("injected readback outage after committed receipt");
      }
      return await sql.query(statement, params);
    },
    async run(statement, params) {
      const result = await sql.run(statement, params);
      if (
        loseReceiptAcknowledgement &&
        statement.includes("INSERT INTO selfhost_object_upload_parts")
      ) {
        loseReceiptAcknowledgement = false;
        loseImmediateReadback = true;
        throw new Error("injected lost acknowledgement after receipt commit");
      }
      return result;
    },
    batch(statements) {
      return sql.batch(statements);
    },
  };
}

test("multipart replacement receipt and part bytes survive a file-backed SQLite reopen", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "takoserver-object-store-reopen-"));
  const root = join(sandbox, "objects");
  const databasePath = join(sandbox, "control.sqlite");
  let database: Database | undefined;
  try {
    database = new Database(databasePath);
    migrateSqlite(database);
    const sql = createSqliteSql(database);
    const store = createSelfhostObjectStore({ sql, root });

    const replacementUpload = await store.createMultipartUpload(BUCKET, "replacement", {});
    const originalPart = await store.uploadPart(
      BUCKET,
      "replacement",
      replacementUpload.uploadId,
      1,
      body("old"),
      { contentLength: 3 },
    );
    const replacementStore = createSelfhostObjectStore({
      sql: loseCommittedReceiptAcknowledgement(sql),
      root,
    });
    await expect(
      replacementStore.uploadPart(
        BUCKET,
        "replacement",
        replacementUpload.uploadId,
        1,
        body("new"),
        { contentLength: 3 },
      ),
    ).rejects.toMatchObject({ code: "backend_unavailable" });

    const replacementDirectory = join(root, BUCKET, "u", replacementUpload.uploadId);
    expect(await readdir(replacementDirectory)).toContain(`1-${originalPart.etag}`);

    const legacyUpload = await store.createMultipartUpload(BUCKET, "legacy", {});
    const legacyPart = await store.uploadPart(
      BUCKET,
      "legacy",
      legacyUpload.uploadId,
      1,
      body("legacy"),
      { contentLength: 6 },
    );
    const legacyDirectory = join(root, BUCKET, "u", legacyUpload.uploadId);
    await rename(join(legacyDirectory, `1-${legacyPart.etag}`), join(legacyDirectory, "1"));

    // Closing and reopening this real SQLite file exercises durable local state,
    // not an OS process kill or power-loss guarantee.
    database.close();
    database = undefined;

    database = new Database(databasePath);
    expect(migrateSqlite(database).applied).toEqual([]);
    const reopenedSql = createSqliteSql(database);
    const reopenedStore = createSelfhostObjectStore({ sql: reopenedSql, root });
    const persisted = await reopenedSql.query(
      "SELECT part_number, size, etag FROM selfhost_object_upload_parts " +
        "WHERE bucket_id = ? AND upload_id = ?",
      [BUCKET, replacementUpload.uploadId],
    );
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ part_number: 1, size: 3 });
    const persistedEtag = String(persisted[0]?.etag);
    expect(persistedEtag).not.toBe(originalPart.etag);
    expect(await readFile(join(replacementDirectory, `1-${persistedEtag}`), "utf8")).toBe("new");

    const retriedPart = await reopenedStore.uploadPart(
      BUCKET,
      "replacement",
      replacementUpload.uploadId,
      1,
      body("new"),
      { contentLength: 3 },
    );
    expect(retriedPart).toEqual({ etag: persistedEtag, partNumber: 1 });
    const retryFiles = await readdir(replacementDirectory);
    expect(retryFiles).toContain(`1-${originalPart.etag}`);
    expect(retryFiles.filter((name) => name === `1-${persistedEtag}`)).toHaveLength(1);
    const activeParts = await reopenedSql.query(
      "SELECT part_number, size, etag FROM selfhost_object_upload_parts " +
        "WHERE bucket_id = ? AND upload_id = ?",
      [BUCKET, replacementUpload.uploadId],
    );
    expect(activeParts).toHaveLength(1);
    expect(activeParts[0]).toMatchObject({ part_number: 1, size: 3, etag: persistedEtag });

    const replacementObject = await reopenedStore.completeMultipartUpload(
      BUCKET,
      "replacement",
      replacementUpload.uploadId,
      [retriedPart],
    );
    expect(replacementObject.size).toBe(3);
    expect(await bodyText(reopenedStore, "replacement")).toBe("new");
    expect(await stat(replacementDirectory).catch(() => null)).toBeNull();

    const legacyObject = await reopenedStore.completeMultipartUpload(
      BUCKET,
      "legacy",
      legacyUpload.uploadId,
      [legacyPart],
    );
    expect(legacyObject.size).toBe(6);
    expect(await bodyText(reopenedStore, "legacy")).toBe("legacy");
    expect(await stat(legacyDirectory).catch(() => null)).toBeNull();
  } finally {
    database?.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});
