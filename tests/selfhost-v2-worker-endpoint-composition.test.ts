import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import type { Sql } from "../src/ports.ts";
import { createSelfhostV2WorkerComposition } from "../src/selfhost-v2-worker-composition.ts";
import {
  createSelfhostV2WorkerEndpointBoot,
  type SelfhostV2WorkerEndpointBootOptions,
} from "../src/selfhost-v2-worker-endpoint-boot.ts";
import { verifySelfhostV2WorkerEndpointHttpsSni } from "../src/selfhost-v2-worker-endpoint-https.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { WORKER_ENDPOINT_FORM_URL } from "../src/takoform-v2/forms/worker-specs.ts";
import type { V2Execution } from "../src/takoform-v2/types.ts";
import { WORKER_ENDPOINT_BACKEND_ID } from "../src/takoform-v2/worker-endpoint-backend.ts";

const TARGET = "selfhost-v2-worker-primary";
const SUFFIX = "workers.example.test";

async function certificateFixture() {
  const directory = await mkdtemp(join(tmpdir(), "selfhost-v2-worker-composition-endpoint-"));
  await chmod(directory, 0o700);
  const certificatePath = join(directory, "certificate.pem");
  const privateKeyPath = join(directory, "private-key.pem");
  const child = Bun.spawn(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      privateKeyPath,
      "-out",
      certificatePath,
      "-days",
      "2",
      "-subj",
      `/CN=*.${SUFFIX}`,
      "-addext",
      `subjectAltName=DNS:*.${SUFFIX}`,
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  if ((await child.exited) !== 0) {
    await rm(directory, { recursive: true, force: true });
    throw new Error("temporary endpoint certificate generation failed");
  }
  await chmod(privateKeyPath, 0o600);
  return {
    directory,
    certificateChain: await readFile(certificatePath, "utf8"),
    privateKey: await readFile(privateKeyPath, "utf8"),
  };
}

function localListenerFactories() {
  let socketPort: number | undefined;
  return {
    factories: {
      serve(
        serveOptions: Parameters<
          NonNullable<SelfhostV2WorkerEndpointBootOptions["factories"]>["serve"]
        >[0],
      ) {
        const server = Bun.serve({
          ...serveOptions,
          hostname: "127.0.0.1",
          port: 0,
        });
        socketPort = server.port;
        return {
          port: 443,
          stop: (force?: boolean) => server.stop(force),
        };
      },
      async proveSni(input: {
        readonly host: string;
        readonly port: number;
        readonly hostname: string;
        readonly certificateChain: string;
      }) {
        if (socketPort === undefined) throw new Error("fixture HTTPS listener did not bind");
        await verifySelfhostV2WorkerEndpointHttpsSni({
          ...input,
          host: "127.0.0.1",
          port: socketPort,
        });
      },
    } satisfies NonNullable<SelfhostV2WorkerEndpointBootOptions["factories"]>,
  };
}

function endpointExecution(): V2Execution {
  return {
    operationId: "9d8b5fc4-066f-46a9-9a36-b9c57cabc971",
    leaseToken: "fixture-lease",
    backendKey: "fixture-backend-key",
    backendId: WORKER_ENDPOINT_BACKEND_ID,
    targetKey: TARGET,
    resourceUid: "6ac9c3c4-a76e-4a59-9b4a-8ac52df10c91",
    principal: "org:fixture",
    action: "create",
    generation: 1,
    form: WORKER_ENDPOINT_FORM_URL,
    space: "fixture",
    name: "endpoint",
    spec: { worker: { resourceUid: "15e57614-257a-4e7f-8126-2e438c5872fb" } },
    previousObserved: {},
    previousOutput: {},
  };
}

test("composition adds Endpoint Form only from its restored, real Endpoint boot ports", async () => {
  const root = await mkdtemp(join(tmpdir(), "selfhost-v2-worker-endpoint-compose-"));
  const certificate = await certificateFixture();
  const database = new Database(join(root, "control.sqlite"));
  let endpointBoot: Awaited<ReturnType<typeof createSelfhostV2WorkerEndpointBoot>> | undefined;
  let composition: ReturnType<typeof createSelfhostV2WorkerComposition> | undefined;
  let restored = false;
  try {
    migrateSqlite(database);
    const sql: Sql = createSqliteSql(database);
    const objects = createMemoryObjectStore();
    const clock = () => new Date();
    const activeComposition = createSelfhostV2WorkerComposition({
      sql,
      objects,
      clock,
      config: {
        cursorSigningKey: new Uint8Array(32).fill(0x52),
        documentation: "https://docs.example.test/v2",
        authenticationDocumentation: "https://docs.example.test/v2/authentication",
      },
      rootDirectory: join(root, "v2-worker-owners"),
      targetKey: TARGET,
      workerdBinary: null,
    });
    composition = activeComposition;
    const listener = localListenerFactories();
    const activeEndpointBoot = await createSelfhostV2WorkerEndpointBoot({
      sql,
      targetKey: TARGET,
      publicOrigin: "https://api.example.test",
      configuration: { workerEndpointSuffix: SUFFIX, port: 443 },
      certificateChain: certificate.certificateChain,
      privateKey: certificate.privateKey,
      publicationState: composition.endpointPublicationState,
      ownerForWorkerUid: async (uid) => await activeComposition.ownerForWorkerUid(uid),
      factories: listener.factories,
    });
    endpointBoot = activeEndpointBoot;

    expect(() =>
      activeComposition.internalFormFactoryForEndpoint(activeEndpointBoot.endpoint),
    ).toThrow("v2 Worker owners must restore before Form composition");
    expect(await activeComposition.restoreOwners()).toEqual([]);
    restored = true;

    expect(() =>
      activeComposition.internalFormFactoryForEndpoint({
        assignHostname: activeEndpointBoot.endpoint.assignHostname,
      } as unknown as Parameters<typeof activeComposition.internalFormFactoryForEndpoint>[0]),
    ).toThrow("v2 Worker Endpoint frontend proof is not composed");

    const factory = activeComposition.internalFormFactoryForEndpoint(activeEndpointBoot.endpoint);
    const forms = factory({ sql, objects, clock });
    expect(forms[WORKER_ENDPOINT_FORM_URL]).toBeDefined();
    expect(
      activeEndpointBoot.endpoint.assignHostname({
        resourceUid: "6ac9c3c4-a76e-4a59-9b4a-8ac52df10c91",
        space: "fixture",
        name: "endpoint",
      }),
    ).toBe(`v2-6ac9c3c4a76e4a599b4a8ac52df10c91.${SUFFIX}`);

    const address = {
      endpointUid: "6ac9c3c4-a76e-4a59-9b4a-8ac52df10c91",
      workerUid: "15e57614-257a-4e7f-8126-2e438c5872fb",
      hostname: `v2-15e57614257a4e7f81262e438c5872fb.${SUFFIX}`,
      url: `https://v2-15e57614257a4e7f81262e438c5872fb.${SUFFIX}/`,
    };
    const unresolvedWitness = await activeEndpointBoot.endpoint.observeTls(
      address,
      endpointExecution(),
    );
    expect(unresolvedWitness.ready).toBe(false);

    await activeEndpointBoot.close(true);
    const closedWitness = await activeEndpointBoot.endpoint.observeTls(
      address,
      endpointExecution(),
    );
    expect(closedWitness.ready).toBe(false);

    await activeComposition.suspendOwnersRetainingCustody();
    expect(() =>
      activeComposition.internalFormFactoryForEndpoint(activeEndpointBoot.endpoint),
    ).toThrow("v2 Worker owners must restore before Form composition");
  } finally {
    if (endpointBoot) await endpointBoot.close(true);
    if (restored && composition) await composition.suspendOwnersRetainingCustody();
    database.close();
    await rm(certificate.directory, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
