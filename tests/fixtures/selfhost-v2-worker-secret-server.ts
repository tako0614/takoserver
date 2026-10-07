// Test-only normal buildApp Host. Keys below are synthetic, deterministic and
// nonextractable; no operator secret or public Worker Form registration exists.
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { buildApp } from "../../src/app.ts";
import { migrateSqlite } from "../../src/migrate-sqlite.ts";
import { createFileObjectStore } from "../../src/objects-fs.ts";
import { createSelfhostTakoformV2Ingress } from "../../src/selfhost-takoform-v2-ingress.ts";
import { createSelfhostV2WorkerComposition } from "../../src/selfhost-v2-worker-composition.ts";
import { createSqliteSql } from "../../src/sql-sqlite.ts";
import { InMemoryTakoformResourceDriver } from "../../src/takoform/memory-driver.ts";
import { createV2WorkerVersionConfiguredInputSealer } from "../../src/takoform-v2/worker-version-configured-inputs.ts";
import { WorkerdWorkerRuntimeOwnerError } from "../../src/workerd-worker-runtime-owner.ts";

const [root, binary, organizationId, manifestSha256, codeSha256] = process.argv.slice(2);
if (!root || !binary || !organizationId || !manifestSha256 || !codeSha256) {
  throw new Error("v2 Worker secret fixture arguments are missing");
}
const ORIGIN = "https://api.example.test";
const TARGET = "selfhost-v2-worker-primary";
const database = new Database(join(root, "control.sqlite"));
migrateSqlite(database);
const sql = createSqliteSql(database);
const objects = createFileObjectStore({ root: join(root, "objects") });
const clock = () => new Date();
const config = {
  cursorSigningKey: new Uint8Array(32).fill(0x51),
  documentation: "https://docs.example.test/v2",
  authenticationDocumentation: "https://docs.example.test/v2/authentication",
  workerBundle: {
    targetKey: TARGET,
    heldArtifacts: [
      {
        url: "https://artifacts.example.test/v2-secret/bundle.json",
        sha256: manifestSha256,
        objectKey: "v2-secret/manifest",
        grants: [{ principal: `org:${organizationId}`, space: organizationId }],
      },
      {
        url: "https://artifacts.example.test/v2-secret/index.mjs",
        sha256: codeSha256,
        objectKey: "v2-secret/module",
        grants: [{ principal: `org:${organizationId}`, space: organizationId }],
      },
    ],
  },
};

async function fixtureKeys() {
  const aes = (byte: number) =>
    crypto.subtle.importKey("raw", new Uint8Array(32).fill(byte), "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
  const [configured, transfer, comparison] = await Promise.all([
    aes(0x61),
    aes(0x62),
    crypto.subtle.importKey(
      "raw",
      new Uint8Array(32).fill(0x63),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    ),
  ]);
  return { configured, transfer, comparison };
}

try {
  const keys = await fixtureKeys();
  const sealer = createV2WorkerVersionConfiguredInputSealer({
    current: { keyId: "fixture-configured", key: keys.configured },
    keyForDecryption: (id) => (id === "fixture-configured" ? keys.configured : undefined),
  });
  let composition: ReturnType<typeof createSelfhostV2WorkerComposition>;
  composition = createSelfhostV2WorkerComposition({
    sql,
    objects,
    clock,
    config,
    rootDirectory: join(root, "v2-worker-owners"),
    targetKey: TARGET,
    workerdBinary: binary,
    configuredInputSealer: sealer,
    endpoint: {
      assignHostname({ resourceUid }) {
        return `worker-${resourceUid.slice(0, 8)}.example.test`;
      },
      async observeTls(input) {
        const owner = await composition.ownerForWorkerUid(input.workerUid);
        const serving = await owner.observeServing({
          workerResourceUid: input.workerUid,
          targetKey: TARGET,
        });
        return {
          ...input,
          ready: serving.kind === "serving" && serving.hostnames.includes(input.hostname),
        };
      },
      async observeRouteAbsent(input) {
        const owner = await composition.ownerForWorkerUid(input.workerUid);
        const serving = await owner.observeServing({
          workerResourceUid: input.workerUid,
          targetKey: TARGET,
        });
        return {
          ...input,
          absent: serving.kind === "serving" && !serving.hostnames.includes(input.hostname),
        };
      },
    },
  });
  const restored = await composition.restoreOwners();
  const app = buildApp({
    sql,
    objects,
    clock,
    identity: {
      async verify() {
        throw new Error("fixture external identity unavailable");
      },
    },
    settlement: {
      async verify() {
        throw new Error("fixture settlement unavailable");
      },
    },
    publicOrigin: ORIGIN,
    forms: [],
    hostForms: [],
    driver: new InMemoryTakoformResourceDriver(),
    offerings: [],
    v2: config,
    v2FormFactory: composition.internalFormFactory,
    v2PrivateInputCustody: {
      transfer: { current: { id: "fixture-transfer", key: keys.transfer } },
      comparison: { current: { id: "fixture-comparison", key: keys.comparison } },
      transferTtlSeconds: 300,
    },
  });
  const ingress = createSelfhostTakoformV2Ingress({
    publicOrigin: ORIGIN,
    appFetch: (request) => app.fetch(request),
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const match = /^\/__fixture\/serve\/([0-9a-f-]{36})$/u.exec(new URL(request.url).pathname);
      if (match) {
        const workerUid = match[1] as string;
        const owner = await composition.ownerForWorkerUid(workerUid);
        const serving = await owner.observeServing({
          workerResourceUid: workerUid,
          targetKey: TARGET,
        });
        if (serving.kind !== "serving" || serving.hostnames.length !== 1) {
          return new Response(null, { status: 503 });
        }
        return await owner.fetch(new Request(`https://${serving.hostnames[0]}/`));
      }
      return await ingress(request);
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
