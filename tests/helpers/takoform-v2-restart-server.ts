// Subprocess-only fixture. It is not an Edge Form or a shipped Host entry.
import { Database } from "bun:sqlite";
import { migrateSqlite } from "../../src/migrate-sqlite.ts";
import { createSqliteSql } from "../../src/sql-sqlite.ts";
import { createTakoformV2Host } from "../../src/takoform-v2/host.ts";
import type { V2BackendResult, V2Execution } from "../../src/takoform-v2/types.ts";

const [statePath, effectPath, stopAt, clockOffset, fixtureMode] = process.argv.slice(2);
if (!statePath || !effectPath || !stopAt) throw new Error("fixture arguments required");
const privateMode = fixtureMode === "private-inputs";
if (fixtureMode !== undefined && !privateMode) throw new Error("unknown fixture mode");
const privateInputCustody = privateMode
  ? await (async () => {
      // Fixture-only material is re-imported as non-extractable keys in each PID.
      // No production key or operator state is read by this subprocess.
      const transferBytes = new Uint8Array(32).fill(0x23);
      const comparisonBytes = new Uint8Array(32).fill(0x64);
      try {
        const [transfer, comparison] = await Promise.all([
          crypto.subtle.importKey("raw", transferBytes, "AES-GCM", false, ["encrypt", "decrypt"]),
          crypto.subtle.importKey(
            "raw",
            comparisonBytes,
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["sign", "verify"],
          ),
        ]);
        return {
          transfer: { current: { id: "fixture-transfer-1", key: transfer } },
          comparison: { current: { id: "fixture-comparison-1", key: comparison } },
          transferTtlSeconds: 30,
        };
      } finally {
        transferBytes.fill(0);
        comparisonBytes.fill(0);
      }
    })()
  : undefined;
const state = new Database(statePath);
migrateSqlite(state);
// A separate durable system: a Host SQL transaction cannot commit these effects.
const effects = new Database(effectPath);
effects.exec(`CREATE TABLE IF NOT EXISTS fixture_resources (
  uid TEXT PRIMARY KEY, generation INTEGER NOT NULL, value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fixture_receipts (
  operation_id TEXT PRIMARY KEY, action TEXT NOT NULL, result TEXT NOT NULL
);`);

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function pause(stage: string, operationId?: string): Promise<void> {
  emit({ stage, ...(operationId ? { operationId } : {}) });
  await new Promise<void>(() => {}); // Parent deliberately SIGKILLs this process.
}

function resolveSameOperation(input: V2Execution, mode: "send" | "reconcile"): V2BackendResult {
  return effects.transaction((): V2BackendResult => {
    const prior = effects
      .query("SELECT result FROM fixture_receipts WHERE operation_id = ?")
      .get(input.operationId) as { result: string } | null;
    if (prior) return JSON.parse(prior.result) as V2BackendResult;
    if (privateMode && mode === "reconcile") {
      // No receipt after an uncertain dispatch is not proof of no send.
      return { kind: "unknown", code: "outcome_unconfirmed", message: "Outcome unconfirmed" };
    }
    if (
      privateMode &&
      input.action === "create" &&
      input.privateInputs?.password !== "fixture-only-secret-値"
    ) {
      throw new Error("private input was not delivered on initial send");
    }
    if (input.action === "create") {
      effects
        .query("INSERT INTO fixture_resources(uid, generation, value) VALUES (?, ?, ?)")
        .run(input.resourceUid, input.generation, String(input.spec.value));
    } else if (input.action === "update") {
      const changed = effects
        .query(
          "UPDATE fixture_resources SET generation = ?, value = ? WHERE uid = ? AND generation = ?",
        )
        .run(input.generation, String(input.spec.value), input.resourceUid, input.generation - 1);
      if (changed.changes !== 1) throw new Error("fixture generation conflict");
    } else {
      const changed = effects
        .query("DELETE FROM fixture_resources WHERE uid = ? AND generation = ?")
        .run(input.resourceUid, input.generation - 1);
      if (changed.changes !== 1) throw new Error("fixture delete ownership conflict");
    }
    const result: V2BackendResult = {
      kind: "complete",
      observed:
        input.action === "delete"
          ? {}
          : {
              value: input.spec.value ?? null,
              ...(privateMode ? { privateApplied: true } : {}),
            },
      output: {},
    };
    effects
      .query("INSERT INTO fixture_receipts(operation_id, action, result) VALUES (?, ?, ?)")
      .run(input.operationId, input.action, JSON.stringify(result));
    return result;
  })();
}

const host = createTakoformV2Host({
  sql: createSqliteSql(state),
  now: () => new Date(Date.now() + Number(clockOffset ?? 0)),
  leaseMilliseconds: 60_000,
  replayWindowSeconds: 3_600,
  authorize: async (principal, space) => principal === "owner" && space === "fixture",
  forms: {
    "https://forms.example/restart-fixture/1": {
      validateCreate() {},
      validateUpdate() {},
      ...(privateMode
        ? {
            privateInputs: {
              validateCreate(_spec: unknown, inputs: Readonly<Record<string, string>> | undefined) {
                if (!inputs || Object.keys(inputs).join(",") !== "password")
                  throw new Error("fixture private input required");
              },
              validateUpdate() {},
            },
          }
        : {}),
      backend: {
        id: "persistent-fixture-v1",
        targetKey: "isolated-test-database",
        async execute(input) {
          if (stopAt === "after_dispatch") await pause(stopAt, input.operationId);
          const result = resolveSameOperation(input, "send");
          if (stopAt === "after_effect") await pause(stopAt, input.operationId);
          return result;
        },
        async reconcile(input) {
          if (privateMode && input.privateInputs !== undefined)
            throw new Error("reconcile received private input");
          // This fixture supports atomic, exact-operation-keyed effects. Do not
          // copy this retry into a backend whose idempotency is unproven.
          return resolveSameOperation(input, "reconcile");
        },
      },
    },
  },
  ...(privateInputCustody ? { privateInputCustody } : {}),
  baseUrl: "https://fixture.example/apis/forms.takoform.com/v2",
  documentation: "https://fixture.example/docs",
  authenticationDocumentation: "https://fixture.example/auth",
  authenticationSchemes: ["Bearer"],
  cursorSigningKey: new Uint8Array(32).fill(17), // Test-only, stable across these subprocesses.
  maxRequestBytes: 4_096,
  maxPageSize: 20,
  authenticate: async (request) =>
    ["Bearer test-only", "Bearer test-only-rotated"].includes(
      request.headers.get("authorization") ?? "",
    )
      ? { principal: "owner", access: "write" }
      : null,
});

let running = false;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__fixture") {
      return Response.json({
        resources: effects.query("SELECT uid, generation, value FROM fixture_resources").all(),
        receipts: effects.query("SELECT operation_id, action FROM fixture_receipts").all(),
      });
    }
    // Loopback transport only; the router still sees its configured public
    // origin. This is process/wire recovery evidence, not HTTPS qualification.
    const routed = new Request(`https://fixture.example${url.pathname}${url.search}`, request);
    const response = await host.fetch(routed);
    if (
      stopAt === "after_accept" &&
      request.method === "POST" &&
      url.pathname.endsWith("/resources") &&
      response?.status === 202
    ) {
      const accepted = (await response.clone().json()) as { id: string };
      await pause(stopAt, accepted.id);
    }
    return response ?? new Response(null, { status: 404 });
  },
});
setInterval(async () => {
  if (running || stopAt === "after_accept") return;
  running = true;
  try {
    await host.runNext();
  } catch {
    emit({ stage: "executor_error" });
  } finally {
    running = false;
  }
}, 10);
emit({ stage: "listening", port: server.port });
