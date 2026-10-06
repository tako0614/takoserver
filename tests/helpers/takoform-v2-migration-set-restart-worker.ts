// Subprocess fixture: real v2 HTTP + Host-held file objects + SQL custody.
// Loopback transport is rewritten to the configured HTTPS origin for the router;
// this is process recovery evidence, not TLS or public-network qualification.
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { migrateSqlite } from "../../src/migrate-sqlite.ts";
import { createFileObjectStore } from "../../src/objects-fs.ts";
import { createSqliteSql } from "../../src/sql-sqlite.ts";
import { createV2HeldArtifactSource } from "../../src/takoform-v2/forms/artifact-source.ts";
import { SQLITE_MIGRATION_SET_FORM_URL } from "../../src/takoform-v2/forms/sqlite-migration-set.ts";
import { createSQLiteMigrationSetForm } from "../../src/takoform-v2/forms/sqlite-migration-set-backend.ts";
import { createTakoformV2Host } from "../../src/takoform-v2/host.ts";

const [root, stage, manifestSha256, fileSha256] = process.argv.slice(2);
if (!root || !stage || !manifestSha256 || !fileSha256) {
  throw new Error("restart fixture arguments missing");
}
const db = new Database(join(root, "control.sqlite"));
migrateSqlite(db);
const sql = createSqliteSql(db);
const objects = createFileObjectStore({ root: join(root, "objects") });
const grants = [{ principal: "alice", space: "default" }];
const source = createV2HeldArtifactSource({
  objects,
  entries: [
    {
      url: "https://artifacts.example.test/manifest.json",
      sha256: manifestSha256,
      objectKey: "fixture/manifest",
      grants,
    },
    {
      url: "https://artifacts.example.test/0001.sql",
      sha256: fileSha256,
      objectKey: "fixture/0001",
      grants,
    },
  ],
});
const form = createSQLiteMigrationSetForm({ sql, source, targetKey: "restart-control-sqlite-1" });
function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
const backend =
  stage === "dispatch"
    ? {
        ...form.backend,
        async execute(input: Parameters<typeof form.backend.execute>[0]) {
          const result = await form.backend.execute(input);
          emit({ stage: "verified", operationId: input.operationId });
          await new Promise<never>(() => {}); // Parent kills after durable effect, before settlement.
          return result;
        },
      }
    : form.backend;
const host = createTakoformV2Host({
  sql,
  now: () => new Date(stage === "dispatch" ? "2026-10-06T00:00:00Z" : "2026-10-06T00:00:02Z"),
  replayWindowSeconds: 3_600,
  leaseMilliseconds: 1_000,
  authorize: async (principal, space) => principal === "alice" && space === "default",
  forms: { [SQLITE_MIGRATION_SET_FORM_URL]: { ...form, backend } },
  baseUrl: "https://fixture.example/apis/forms.takoform.com/v2",
  documentation: "https://fixture.example/docs",
  authenticationDocumentation: "https://fixture.example/auth",
  authenticationSchemes: ["Bearer"],
  cursorSigningKey: new Uint8Array(32).fill(23),
  maxRequestBytes: 8_192,
  maxPageSize: 20,
  authenticate: async (request) =>
    request.headers.get("authorization") === "Bearer test-only"
      ? { principal: "alice", access: "write" }
      : null,
});

let running = false;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const routed = new Request(`https://fixture.example${url.pathname}${url.search}`, request);
    return (await host.fetch(routed)) ?? new Response(null, { status: 404 });
  },
});
setInterval(async () => {
  if (running) return;
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
