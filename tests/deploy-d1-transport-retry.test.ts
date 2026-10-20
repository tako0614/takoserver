import { expect, test } from "bun:test";
import { RemoteD1 } from "../scripts/deploy/d1.ts";
import { DeployError } from "../scripts/deploy/errors.ts";

// Exactly what Wrangler printed for the one failed read of the S3 v2 run.
const FETCH_FAILED = {
  exitCode: 1,
  stdout: '\n{\n  "error": {\n    "text": "fetch failed"\n  }\n}\n',
  stderr: "",
};
const ROWS = {
  exitCode: 0,
  stdout: JSON.stringify([{ success: true, results: [{ n: 0 }] }]),
  stderr: "",
};

function scripted(outcomes: { exitCode: number; stdout: string; stderr: string }[]) {
  const commands: string[] = [];
  const database = new RemoteD1("/private/wrangler.jsonc", {
    environment: {},
    wranglerCommand: (args) => ["wrangler", ...args],
    transportRetryDelaysMs: [0, 0],
    run: async (command) => {
      commands.push(command[command.indexOf("--command") + 1] as string);
      const next = outcomes.shift();
      if (next === undefined) throw new Error("unexpected extra Wrangler invocation");
      return next;
    },
  });
  return { database, commands };
}

async function failure(promise: Promise<unknown>): Promise<DeployError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DeployError) return error;
    throw error;
  }
  throw new Error("expected a DeployError");
}

test("a read that fails before any D1 response is read again, boundedly", async () => {
  // The Money S3 v2 run ended on exactly one such failure of this read.
  const once = scripted([FETCH_FAILED, ROWS]);
  expect(
    await once.database.query(
      "preflight",
      "native foreign-key integrity",
      "SELECT * FROM pragma_foreign_key_check LIMIT 1",
    ),
  ).toEqual([{ n: 0 }]);
  expect(once.commands).toHaveLength(2);

  const persistent = scripted([FETCH_FAILED, FETCH_FAILED, FETCH_FAILED]);
  const error = await failure(
    persistent.database.query(
      "preflight",
      "native foreign-key integrity",
      "SELECT * FROM pragma_foreign_key_check LIMIT 1",
    ),
  );
  // The message stays exactly what it was; the closed reason makes it diagnosable.
  expect(error.message).toBe("native foreign-key integrity failed (exit 1)");
  expect(error.phase).toBe("preflight");
  expect(error.reason).toEqual({ code: "d1-transport", operation: "d1-read", attempts: 3 });
  expect(persistent.commands).toHaveLength(3);
});

test("writes, D1 errors and anything but one read statement fail on the first attempt", async () => {
  const write = scripted([FETCH_FAILED]);
  const written = await failure(
    write.database.statement("mutation", "fence write", "UPDATE t SET v = 1"),
  );
  // A write is never re-sent and its human output is not classified.
  expect(written.reason).toEqual({ code: "d1-command", operation: "d1-statement", attempts: 1 });
  expect(write.commands).toHaveLength(1);

  const sqlError = scripted([
    { exitCode: 1, stdout: "", stderr: "D1_ERROR: no such table: missing: SQLITE_ERROR" },
  ]);
  const refused = await failure(
    sqlError.database.query("preflight", "missing table read", "SELECT * FROM missing"),
  );
  expect(refused.reason).toEqual({ code: "d1-command", operation: "d1-read", attempts: 1 });

  // D1, SQL or provider refusals that merely mention a network word are not
  // Wrangler's transport report and are never re-sent.
  for (const outcome of [
    { exitCode: 1, stdout: "", stderr: "D1_ERROR: no such table: fetch failed: SQLITE_ERROR" },
    { exitCode: 1, stdout: '{"error":{"text":"D1_ERROR: fetch failed"}}', stderr: "" },
    { exitCode: 1, stdout: '{"error":{"text":"fetch failed","notes":[]}}', stderr: "" },
    { exitCode: 1, stdout: '{"error":{"text":"fetch failed"},"extra":1}', stderr: "" },
    { exitCode: 1, stdout: "", stderr: "provider responded 504: ETIMEDOUT upstream" },
    { exitCode: 1, stdout: "fetch failed", stderr: "ECONNRESET" },
  ]) {
    const lookalike = scripted([outcome]);
    expect(
      (await failure(lookalike.database.query("preflight", "lookalike", "SELECT 1"))).reason,
    ).toEqual({ code: "d1-command", operation: "d1-read", attempts: 1 });
    expect(lookalike.commands).toHaveLength(1);
  }

  // A PRAGMA is never re-sent: its call form can write (user_version(5),
  // journal_mode(WAL), wal_checkpoint(TRUNCATE)), so even a plain read form is
  // left out of the closed retry set.
  for (const sql of [
    "SELECT 1; DELETE FROM t",
    "PRAGMA foreign_keys = OFF",
    "PRAGMA user_version(5)",
    "PRAGMA journal_mode(WAL)",
    "PRAGMA wal_checkpoint(TRUNCATE)",
    "PRAGMA table_info('ledger')",
    "INSERT INTO t VALUES (1) RETURNING *",
    "WITH x AS (SELECT 1) DELETE FROM t",
  ]) {
    const single = scripted([FETCH_FAILED]);
    expect((await failure(single.database.query("preflight", "not a read", sql))).reason).toEqual({
      code: "d1-transport",
      operation: "d1-read",
      attempts: 1,
    });
    expect(single.commands).toEqual([sql]);
  }
});
