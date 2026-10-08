// Test-only process: the same accepted v2 SQL graph and native roots are reopened after SIGKILL.
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { buildApp } from "../../src/app.ts";
import { migrateSqlite } from "../../src/migrate-sqlite.ts";
import { createFileObjectStore } from "../../src/objects-fs.ts";
import { createSelfhostTakoformV2Ingress } from "../../src/selfhost-takoform-v2-ingress.ts";
import { createSelfhostV2RuntimeBoot } from "../../src/selfhost-v2-runtime-boot.ts";
import { createSelfhostV2WorkerComposition } from "../../src/selfhost-v2-worker-composition.ts";
import { createSqliteSql } from "../../src/sql-sqlite.ts";
import { InMemoryTakoformResourceDriver } from "../../src/takoform/memory-driver.ts";
import { v2ServiceTargetName } from "../../src/takoform-v2/worker-service-resolution.ts";
import { internalHostname } from "../../src/workerd-runtime.ts";
import { WorkerdWorkerRuntimeOwnerError } from "../../src/workerd-worker-runtime-owner.ts";

const [root, binary] = process.argv.slice(2);
if (!root || !binary) throw new Error("fixture arguments are missing");
const targetKey = "selfhost-v2-actor-os-restart";
const database = new Database(join(root, "control.sqlite"));
migrateSqlite(database);
const sql = createSqliteSql(database);
const objects = createFileObjectStore({ root: join(root, "objects") });
const clock = () => new Date();
const heldArtifacts = JSON.parse(await Bun.file(join(root, "held-artifacts.json")).text()) as {
  url: string;
  sha256: string;
  objectKey: string;
  grants: { principal: string; space: string }[];
}[];
const config = {
  cursorSigningKey: new Uint8Array(32).fill(0x41),
  documentation: "https://docs.example.test/v2",
  authenticationDocumentation: "https://docs.example.test/v2/authentication",
  workerBundle: { targetKey, heldArtifacts },
};
async function unusedPort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = Number(server.port);
  await server.stop(true);
  return port;
}
let composition: ReturnType<typeof createSelfhostV2WorkerComposition>;
const runtime = createSelfhostV2RuntimeBoot({
  selection: { actor: true },
  sql,
  clock,
  targetKey,
  dataRoot: root,
  workerdBinary: binary,
  ownerForWorkerUid: async (uid) =>
    composition ? await composition.actorOwnerForRecovery(uid) : null,
});
composition = createSelfhostV2WorkerComposition({
  sql,
  objects,
  clock,
  config,
  rootDirectory: join(root, "owners"),
  targetKey,
  workerdBinary: binary,
  ...(runtime.v2Actor ? { v2Actor: runtime.v2Actor } : {}),
  listenerPortForOperation: unusedPort,
});

try {
  process.stdout.write(`${JSON.stringify({ stage: "restoring" })}\n`);
  const restored = await composition.restoreOwners();
  process.stdout.write(`${JSON.stringify({ stage: "restored" })}\n`);
  const app = buildApp({
    sql,
    objects,
    clock,
    identity: {
      async verify() {
        throw new Error("fixture identity unavailable");
      },
    },
    settlement: {
      async verify() {
        throw new Error("fixture settlement unavailable");
      },
    },
    publicOrigin: "https://api.example.test",
    forms: [],
    hostForms: [],
    driver: new InMemoryTakoformResourceDriver(),
    offerings: [],
    v2: config,
    v2FormFactory: composition.internalFormFactory,
  });
  const ingress = createSelfhostTakoformV2Ingress({
    publicOrigin: "https://api.example.test",
    appFetch: (request) => app.fetch(request),
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const match = /^\/__fixture\/serve\/([0-9a-f-]{36})(\/.*)$/u.exec(url.pathname);
      if (!match) return await ingress(request);
      const uid = match[1] as string;
      const owner = await composition.ownerForWorkerUid(uid);
      const serving = await owner.observeServing({ workerResourceUid: uid, targetKey });
      if (serving.kind !== "serving") return new Response("owner-not-serving", { status: 503 });
      const hostname = internalHostname(await v2ServiceTargetName(uid));
      return await owner.fetch(
        new Request(`http://${hostname}${match[2]}${url.search}`, {
          method: request.method,
        }),
      );
    },
  });
  setInterval(() => {
    void app.tickTakoformV2().catch(() => {
      process.stdout.write(`${JSON.stringify({ stage: "tick_error" })}\n`);
    });
  }, 10);
  process.stdout.write(
    `${JSON.stringify({ stage: "listening", port: server.port, pid: process.pid, restored })}\n`,
  );
} catch (error) {
  const code = error instanceof WorkerdWorkerRuntimeOwnerError ? error.code : "startup_refused";
  process.stdout.write(`${JSON.stringify({ stage: "startup_error", code })}\n`);
  database.close();
  process.exitCode = 1;
}
