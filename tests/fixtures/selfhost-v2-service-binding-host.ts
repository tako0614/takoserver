// Test-only normal Host process for an accepted, native Worker service-binding graph.
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { buildApp } from "../../src/app.ts";
import { migrateSqlite } from "../../src/migrate-sqlite.ts";
import { createFileObjectStore } from "../../src/objects-fs.ts";
import { createSelfhostTakoformV2Ingress } from "../../src/selfhost-takoform-v2-ingress.ts";
import { createSelfhostV2WorkerComposition } from "../../src/selfhost-v2-worker-composition.ts";
import { createSqliteSql } from "../../src/sql-sqlite.ts";
import { InMemoryTakoformResourceDriver } from "../../src/takoform/memory-driver.ts";
import { WorkerdWorkerRuntimeOwnerError } from "../../src/workerd-worker-runtime-owner.ts";

const [root, binary, organizationId] = process.argv.slice(2);
if (!root || !binary || !organizationId) throw new Error("fixture arguments are missing");
const targetKey = "selfhost-v2-service-binding-os-restart";
const origin = "https://api.example.test";
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
  cursorSigningKey: new Uint8Array(32).fill(0x53),
  documentation: "https://docs.example.test/v2",
  authenticationDocumentation: "https://docs.example.test/v2/authentication",
  workerBundle: { targetKey, heldArtifacts },
};
let composition: ReturnType<typeof createSelfhostV2WorkerComposition>;
composition = createSelfhostV2WorkerComposition({
  sql,
  objects,
  clock,
  config,
  rootDirectory: join(root, "owners"),
  targetKey,
  workerdBinary: binary,
  endpoint: {
    assignHostname({ resourceUid }) {
      return `worker-${resourceUid.slice(0, 8)}.example.test`;
    },
    async observeTls(input) {
      const owner = await composition.ownerForWorkerUid(input.workerUid);
      const serving = await owner.observeServing({ workerResourceUid: input.workerUid, targetKey });
      return {
        ...input,
        ready: serving.kind === "serving" && serving.hostnames.includes(input.hostname),
      };
    },
    async observeRouteAbsent(input) {
      const owner = await composition.ownerForWorkerUid(input.workerUid);
      const serving = await owner.observeServing({ workerResourceUid: input.workerUid, targetKey });
      return {
        ...input,
        absent: serving.kind === "serving" && !serving.hostnames.includes(input.hostname),
      };
    },
  },
});

try {
  const restored = await composition.restoreOwners();
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
    publicOrigin: origin,
    forms: [],
    hostForms: [],
    driver: new InMemoryTakoformResourceDriver(),
    offerings: [],
    v2: config,
    v2FormFactory: composition.internalFormFactory,
  });
  const ingress = createSelfhostTakoformV2Ingress({
    publicOrigin: origin,
    appFetch: (request) => app.fetch(request),
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const match = /^\/__fixture\/serve\/([0-9a-f-]{36})$/u.exec(path);
      if (!match) return await ingress(request);
      const workerUid = match[1] as string;
      const owner = await composition.ownerForWorkerUid(workerUid);
      const serving = await owner.observeServing({ workerResourceUid: workerUid, targetKey });
      const hostname = request.headers.get("host");
      if (serving.kind !== "serving" || !hostname || !serving.hostnames.includes(hostname)) {
        return new Response(null, { status: 503 });
      }
      return await owner.fetch(new Request(`https://${hostname}/identity`));
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
  const ownerLines =
    error instanceof Error
      ? [...(error.stack ?? "").matchAll(/workerd-worker-runtime-owner\.ts:(\d+):/gu)].map(
          (match) => match[1],
        )
      : [];
  process.stdout.write(`${JSON.stringify({ stage: "startup_error", code, ownerLines })}\n`);
  database.close();
  process.exitCode = 1;
}
