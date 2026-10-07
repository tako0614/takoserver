import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { Sql } from "../src/ports.ts";
import {
  createSelfhostV2WorkerEndpointBoot,
  type SelfhostV2WorkerEndpointBootOptions,
} from "../src/selfhost-v2-worker-endpoint-boot.ts";
import { verifySelfhostV2WorkerEndpointHttpsSni } from "../src/selfhost-v2-worker-endpoint-https.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { WORKER_ENDPOINT_FORM_URL } from "../src/takoform-v2/forms/worker-specs.ts";
import type { V2Execution } from "../src/takoform-v2/types.ts";
import { WORKER_ENDPOINT_BACKEND_ID } from "../src/takoform-v2/worker-endpoint-backend.ts";
import { createV2WorkerPublicationState } from "../src/takoform-v2/worker-publication-state.ts";

const ORIGIN = "https://api.example.test";
const SUFFIX = "workers.example.test";
const TARGET = "selfhost-v2-worker-primary";
const ENDPOINT_UID = "6ac9c3c4-a76e-4a59-9b4a-8ac52df10c91";
const WORKER_UID = "15e57614-257a-4e7f-8126-2e438c5872fb";

async function certificateFixture() {
  const directory = await mkdtemp(join(tmpdir(), "selfhost-v2-endpoint-boot-"));
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

function loopbackFactories(options: { failSni?: boolean } = {}) {
  let socketPort: number | undefined;
  let stopCalls = 0;
  const factories = {
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
        async stop(force?: boolean) {
          stopCalls++;
          await server.stop(force);
        },
      };
    },
    async proveSni(input: {
      readonly host: string;
      readonly port: number;
      readonly hostname: string;
      readonly certificateChain: string;
    }) {
      if (options.failSni) throw new Error("fixture SNI failure");
      if (socketPort === undefined) throw new Error("fixture HTTPS listener did not bind");
      await verifySelfhostV2WorkerEndpointHttpsSni({
        ...input,
        host: "127.0.0.1",
        port: socketPort,
      });
    },
  } satisfies NonNullable<SelfhostV2WorkerEndpointBootOptions["factories"]>;
  return {
    factories,
    port: () => socketPort,
    stopCalls: () => stopCalls,
  };
}

function endpointExecution(): V2Execution {
  return {
    operationId: "9d8b5fc4-066f-46a9-9a36-b9c57cabc971",
    leaseToken: "fixture-lease",
    backendKey: "fixture-backend-key",
    backendId: WORKER_ENDPOINT_BACKEND_ID,
    targetKey: TARGET,
    resourceUid: ENDPOINT_UID,
    principal: "org:acme",
    action: "create",
    generation: 1,
    form: WORKER_ENDPOINT_FORM_URL,
    space: "org:acme",
    name: "endpoint",
    spec: { worker: { resourceUid: WORKER_UID } },
    previousObserved: {},
    previousOutput: {},
  };
}

function stateFixture() {
  const database = new Database(":memory:");
  migrateSqlite(database);
  const sql = createSqliteSql(database);
  const publicationState = createV2WorkerPublicationState({
    sql,
    now: () => new Date("2026-10-07T00:00:00.000Z"),
  });
  return { database, sql, publicationState };
}

function bootOptions(input: {
  readonly sql: Sql;
  readonly publicationState: SelfhostV2WorkerEndpointBootOptions["publicationState"];
  readonly certificateChain: string;
  readonly privateKey: string;
  readonly factories: NonNullable<SelfhostV2WorkerEndpointBootOptions["factories"]>;
  readonly publicOrigin?: string;
}): SelfhostV2WorkerEndpointBootOptions {
  return {
    sql: input.sql,
    targetKey: TARGET,
    publicOrigin: input.publicOrigin ?? ORIGIN,
    configuration: { workerEndpointSuffix: SUFFIX, port: 443 },
    certificateChain: input.certificateChain,
    privateKey: input.privateKey,
    publicationState: input.publicationState,
    ownerForWorkerUid: async () => {
      throw new Error("empty SQL route must not open a Worker owner");
    },
    factories: input.factories,
  };
}

function get(port: number, hostname: string, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        hostname: "127.0.0.1",
        port,
        servername: hostname,
        path,
        headers: { host: hostname },
        // This is a temporary local certificate, not a public trust assertion.
        rejectUnauthorized: false,
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.once("error", reject);
    request.end();
  });
}

function requirePort(port: number | undefined): number {
  if (port === undefined) throw new Error("fixture HTTPS listener did not bind");
  return port;
}

function requireRouteAbsent(
  endpoint: Awaited<ReturnType<typeof createSelfhostV2WorkerEndpointBoot>>["endpoint"],
) {
  if (!endpoint.observeRouteAbsent)
    throw new Error("fixture route-absence observer is unavailable");
  return endpoint.observeRouteAbsent;
}

test("self-host Endpoint boot joins the SQL route, owner witness and shared local HTTPS listener", async () => {
  const tls = await certificateFixture();
  const state = stateFixture();
  const fixture = loopbackFactories();
  let boot: Awaited<ReturnType<typeof createSelfhostV2WorkerEndpointBoot>> | undefined;
  try {
    const activeBoot = await createSelfhostV2WorkerEndpointBoot(
      bootOptions({
        sql: state.sql,
        publicationState: state.publicationState,
        ...tls,
        factories: fixture.factories,
      }),
    );
    boot = activeBoot;
    expect(fixture.port()).toBeGreaterThan(0);
    const address = activeBoot.endpoint.assignHostname({
      resourceUid: ENDPOINT_UID,
      space: "org:acme",
      name: "endpoint",
    });
    expect(address).toBe(`v2-${ENDPOINT_UID.replaceAll("-", "")}.${SUFFIX}`);
    expect(
      activeBoot.endpoint.assignHostname({
        resourceUid: ENDPOINT_UID,
        space: "org:other",
        name: "other-name",
      }),
    ).toBe(address);
    expect(
      activeBoot.endpoint.assignHostname({
        resourceUid: "ca53d879-ff44-47a5-8846-117bf82f7717",
        space: "org:acme",
        name: "another-endpoint",
      }),
    ).not.toBe(address);

    // A reserved-host miss stays on the Endpoint listener; it cannot fall
    // through to the Host API router, even when the path looks like an API.
    expect(
      await get(requirePort(fixture.port()), address, "/apis/forms.takoform.com/v2/resources"),
    ).toBe(404);
    await expect(
      activeBoot.endpoint.observeTls(
        {
          endpointUid: ENDPOINT_UID,
          workerUid: WORKER_UID,
          hostname: address,
          url: `https://${address}/`,
        },
        endpointExecution(),
      ),
    ).resolves.toMatchObject({ ready: false });
    await expect(
      requireRouteAbsent(activeBoot.endpoint)(
        {
          endpointUid: ENDPOINT_UID,
          workerUid: WORKER_UID,
          hostname: address,
          url: `https://${address}/`,
        },
        endpointExecution(),
      ),
    ).resolves.toMatchObject({ absent: false });

    await activeBoot.close();
    await expect(
      activeBoot.endpoint.observeTls(
        {
          endpointUid: ENDPOINT_UID,
          workerUid: WORKER_UID,
          hostname: address,
          url: `https://${address}/`,
        },
        endpointExecution(),
      ),
    ).resolves.toMatchObject({ ready: false });
    const unavailable = await get(requirePort(fixture.port()), address, "/after-close").then(
      () => false,
      () => true,
    );
    expect(unavailable).toBe(true);
  } finally {
    await boot?.close().catch(() => undefined);
    state.database.close();
    await rm(tls.directory, { recursive: true, force: true });
  }
});

test("self-host Endpoint boot keeps the listener suffix when caller configuration changes during startup", async () => {
  const tls = await certificateFixture();
  const state = stateFixture();
  const fixture = loopbackFactories();
  let notifyProbeStarted!: () => void;
  let releaseProbe!: () => void;
  const probeStarted = new Promise<void>((resolve) => {
    notifyProbeStarted = resolve;
  });
  const probeGate = new Promise<void>((resolve) => {
    releaseProbe = resolve;
  });
  const originalProbe = fixture.factories.proveSni;
  const factories: NonNullable<SelfhostV2WorkerEndpointBootOptions["factories"]> = {
    ...fixture.factories,
    async proveSni(input) {
      notifyProbeStarted();
      await probeGate;
      await originalProbe(input);
    },
  };
  const config: { workerEndpointSuffix: string; port: 443 } = {
    workerEndpointSuffix: SUFFIX,
    port: 443,
  };
  let boot: Awaited<ReturnType<typeof createSelfhostV2WorkerEndpointBoot>> | undefined;
  try {
    const input = bootOptions({
      sql: state.sql,
      publicationState: state.publicationState,
      ...tls,
      factories,
    });
    const starting = createSelfhostV2WorkerEndpointBoot({ ...input, configuration: config });
    await probeStarted;
    config.workerEndpointSuffix = "changed.example.test";
    releaseProbe();
    boot = await starting;

    expect(
      boot.endpoint.assignHostname({
        resourceUid: ENDPOINT_UID,
        space: "org:acme",
        name: "endpoint",
      }),
    ).toBe(`v2-${ENDPOINT_UID.replaceAll("-", "")}.${SUFFIX}`);
  } finally {
    releaseProbe();
    await boot?.close().catch(() => undefined);
    state.database.close();
    await rm(tls.directory, { recursive: true, force: true });
  }
});

test("self-host Endpoint boot closes a bound listener when frontend composition is rejected", async () => {
  const tls = await certificateFixture();
  const state = stateFixture();
  const fixture = loopbackFactories();
  try {
    await expect(
      createSelfhostV2WorkerEndpointBoot(
        bootOptions({
          sql: state.sql,
          publicationState: state.publicationState,
          ...tls,
          factories: fixture.factories,
          publicOrigin: "http://api.example.test",
        }),
      ),
    ).rejects.toThrow("canonical HTTPS origin");
    expect(fixture.stopCalls()).toBe(1);
  } finally {
    state.database.close();
    await rm(tls.directory, { recursive: true, force: true });
  }
});

test("self-host Endpoint boot propagates SNI startup failure after stopping the bound listener", async () => {
  const tls = await certificateFixture();
  const state = stateFixture();
  const fixture = loopbackFactories({ failSni: true });
  try {
    await expect(
      createSelfhostV2WorkerEndpointBoot(
        bootOptions({
          sql: state.sql,
          publicationState: state.publicationState,
          ...tls,
          factories: fixture.factories,
        }),
      ),
    ).rejects.toThrow("fixture SNI failure");
    expect(fixture.stopCalls()).toBe(1);
  } finally {
    state.database.close();
    await rm(tls.directory, { recursive: true, force: true });
  }
});
