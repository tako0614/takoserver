import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMigrationArtifact } from "../scripts/deploy/migrations.ts";
import {
  buildMoneyRehearsalSyntheticPlan,
  type MoneyRehearsalDeclaration,
} from "../scripts/deploy/schema-money-unit-rehearsal.ts";
import worker from "../src/entry-money-shadow-native-probe.ts";
import type { SqlParam } from "../src/ports.ts";
import type { D1DatabaseLike, D1ResultLike, D1StatementLike } from "../src/sql-d1.ts";

const files = readMigrationArtifact().files;
const auth = "a".repeat(64);
const sourceCommit = "b".repeat(40);
const bindingDigest = `sha256:${"c".repeat(64)}`;

function declaration(root: string): MoneyRehearsalDeclaration {
  return {
    kind: "takoserver.money-unit-rehearsal@v1",
    environment: "rehearsal",
    accountId: "1".repeat(32),
    databaseName: `takoserver-r-${"2".repeat(32)}`,
    databaseId: "11111111-1111-4111-8111-111111111111",
    createDeclarationPath: `${root}/create.json`,
    createDeclarationDigest: `sha256:${"d".repeat(64)}`,
    createReceiptPath: `${root}/receipt.json`,
    createReceiptDigest: `sha256:${"e".repeat(64)}`,
    reviewPath: `${root}/review.json`,
    custodyDirectory: `${root}/custody`,
    phase: "seed",
  };
}

function localD1(database: Database): D1DatabaseLike {
  class Statement implements D1StatementLike {
    constructor(
      readonly source: string,
      readonly params: readonly SqlParam[] = [],
    ) {}
    bind(...values: readonly SqlParam[]): D1StatementLike {
      return new Statement(this.source, values);
    }
    async all(): Promise<D1ResultLike> {
      const query = database.query(this.source);
      if (/^\s*SELECT\b/iu.test(this.source))
        return {
          results: query.all(...(this.params as never[])) as Record<string, unknown>[],
          meta: { changes: 0 },
        };
      const written = query.run(...(this.params as never[]));
      return { results: [], meta: { changes: written.changes } };
    }
  }
  return {
    prepare(source) {
      return new Statement(source);
    },
    async batch(statements) {
      database.exec("BEGIN TRANSACTION");
      try {
        const results: D1ResultLike[] = [];
        for (const statement of statements) results.push(await statement.all());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

describe("money shadow one-use native Worker source", () => {
  test("fixed authenticated POST proves guarded batch and GET cannot replay it", async () => {
    const root = mkdtempSync(join(tmpdir(), "money-shadow-worker-"));
    const database = new Database(":memory:");
    try {
      const plan = await buildMoneyRehearsalSyntheticPlan(files, declaration(root));
      database.exec(plan.sql.seed);
      for (const phase of [
        "freeze",
        "prepare",
        "classify",
        "convert",
        "resume",
        "permit-success",
      ] as const)
        database.exec(`BEGIN TRANSACTION;\n${plan.sql[phase]}\nCOMMIT;`);
      const env = {
        STATE_DB: localD1(database),
        MONEY_SHADOW_PROBE_AUTH: auth,
        MONEY_SHADOW_WRITER_EPOCH: plan.writerEpoch,
        MONEY_SHADOW_REVOKED_EPOCH: `sha256:${"f".repeat(64)}`,
        MONEY_SHADOW_BINDING_DIGEST: bindingDigest,
        MONEY_SHADOW_SOURCE_COMMIT: sourceCommit,
      };
      const get = () =>
        worker.fetch(
          new Request("https://shadow.example.invalid/status", {
            headers: { authorization: `Bearer ${auth}` },
          }),
          env,
        );
      const post = () =>
        worker.fetch(
          new Request("https://shadow.example.invalid/run", {
            method: "POST",
            headers: { authorization: `Bearer ${auth}` },
          }),
          env,
        );
      expect((await get()).status).toBe(200);
      expect(
        (
          await worker.fetch(
            new Request("https://shadow.example.invalid/run", { method: "POST" }),
            env,
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await worker.fetch(
            new Request("https://shadow.example.invalid/run", {
              method: "POST",
              headers: { authorization: `Bearer ${auth}` },
              body: "{}",
            }),
            env,
          )
        ).status,
      ).toBe(405);
      const response = await post();
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ state: "complete", bindingDigest });
      expect(
        database.query("SELECT outcome FROM stripe_events WHERE event_id = 'evt_rehearsal'").get(),
      ).toEqual({ outcome: "ignored" });
      expect(database.query("SELECT COUNT(*) AS n FROM money_cutover_writer_permit").get()).toEqual(
        { n: 0 },
      );
      expect(await (await get()).json()).toMatchObject({
        state: "complete",
        completeReadbackMatches: true,
        permitEmpty: true,
        writerEpochMatches: true,
      });
      expect((await post()).status).toBe(409);
      expect(
        database.query("SELECT COUNT(*) AS n FROM money_shadow_native_batch_probe_journal").get(),
      ).toEqual({ n: 1 });
    } finally {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
