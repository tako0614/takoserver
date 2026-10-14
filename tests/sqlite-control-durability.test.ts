import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { configureSelfhostControlDurability } from "../src/sql-sqlite.ts";

test("a reopened control writer enables directory durability for DELETE and WAL journals", () => {
  const root = mkdtempSync(join(import.meta.dir, "../.test-host-durability-"));
  try {
    for (const journal of ["DELETE", "WAL"]) {
      const path = join(root, `${journal}.sqlite`);
      const original = new Database(path);
      original.exec(`PRAGMA journal_mode = ${journal}`);
      original.exec("CREATE TABLE proof (value INTEGER)");
      original.close();
      const writer = new Database(path);
      try {
        writer.exec("PRAGMA synchronous = NORMAL");
        configureSelfhostControlDurability(writer);
        expect(writer.query("PRAGMA synchronous").get()).toEqual({ synchronous: 3 });
        expect(writer.query("PRAGMA journal_mode").get()).toEqual({
          journal_mode: journal.toLowerCase(),
        });
        writer.exec("INSERT INTO proof VALUES (1)");
      } finally {
        writer.close();
      }
      const restored = new Database(path, { readonly: true });
      expect(restored.query("SELECT value FROM proof").all()).toEqual([{ value: 1 }]);
      expect(restored.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      restored.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
