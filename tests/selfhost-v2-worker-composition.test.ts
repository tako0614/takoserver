import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.ts";
import { createAccounts } from "../src/auth.ts";
import { bytesDigest } from "../src/json.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { createSelfhostV2WorkerComposition } from "../src/selfhost-v2-worker-composition.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { InMemoryTakoformResourceDriver } from "../src/takoform/memory-driver.ts";
import { STATIC_ASSET_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/static-asset-bundle.ts";
import {
  MODULE_WORKER_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import { spawnWorkerdWithParentDeath } from "../src/workerd-linux-process.ts";
import type { WorkerdProcess } from "../src/workerd-supervisor.ts";

const ORIGIN = "https://api.example.test";
const API = "/apis/forms.takoform.com/v2";
const TARGET = "selfhost-v2-worker-primary";
const CHILD_SOURCE = `
import { readFileSync } from "node:fs";
const [verb, watch, configPath] = process.argv.slice(-3);
if (verb !== "serve" || watch !== "--watch" || !configPath) throw new Error("unexpected command");
function identity() {
  const config = readFileSync(configPath, "utf8");
  const port = /address = "\\*:(\\d+)"/u.exec(config)?.[1];
  const generation = /\\(name = "CONFIG_IDENTITY", text = "([0-9a-f]{64})"\\)/u.exec(config)?.[1];
  const token = /\\(name = "CONFIG_PROBE_TOKEN", text = "([0-9a-f]{64})"\\)/u.exec(config)?.[1];
  if (!port || !generation || !token) throw new Error("invalid rendered config");
  return { port: Number(port), generation, token };
}
const server = Bun.serve({ hostname: "127.0.0.1", port: identity().port, fetch(request) {
  const current = identity();
  const url = new URL(request.url);
  if (request.method === "POST" && request.headers.get("host") === "runtime.selfhost-config.invalid" &&
      url.pathname === "/.well-known/takoserver/selfhost-runtime-config/v1" &&
      request.headers.get("x-takoserver-selfhost-runtime-config") === current.token) {
    return new Response(null, { status: 204, headers: { "x-takoserver-selfhost-config-identity": current.generation } });
  }
  return new Response(current.generation);
} });
process.on("SIGTERM", () => server.stop(true));
`;

test("normal Worker composition restores an empty private owner inventory", async () => {
  const root = await mkdtemp(join(tmpdir(), "selfhost-v2-worker-composition-"));
  const database = new Database(join(root, "control.sqlite"));
  try {
    migrateSqlite(database);
    const composition = createSelfhostV2WorkerComposition({
      sql: createSqliteSql(database),
      objects: createMemoryObjectStore(),
      clock: () => new Date(),
      config: {
        cursorSigningKey: new Uint8Array(32).fill(0x52),
        documentation: "https://docs.example.test/v2",
        authenticationDocumentation: "https://docs.example.test/v2/authentication",
      },
      rootDirectory: join(root, "v2-worker-owners"),
      targetKey: "selfhost-v2-worker-primary",
      workerdBinary: null,
    });
    await expect(composition.pollScheduledDue()).rejects.toThrow("unavailable");
    expect(await composition.restoreOwners()).toEqual([]);
    expect(await composition.pollScheduledDue()).toMatchObject({
      recorded: 0,
      claimed: 0,
      resolved: 0,
      rejected: 0,
      unknown: 0,
    });
    await composition.closeScheduledHost();
    await expect(composition.pollScheduledDue()).rejects.toThrow("closed");
    await composition.suspendOwnersRetainingCustody();
    await expect(composition.pollScheduledDue()).rejects.toThrow("unavailable");
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Endpoint publication reader is fail-closed before restore and after owner suspension", async () => {
  const root = await mkdtemp(join(tmpdir(), "selfhost-v2-endpoint-publication-reader-"));
  const database = new Database(join(root, "control.sqlite"));
  try {
    migrateSqlite(database);
    const sql = createSqliteSql(database);
    const objects = createMemoryObjectStore();
    const clock = () => new Date();
    const composition = createSelfhostV2WorkerComposition({
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
    const execution = {
      operationId: "23fd4413-9f1d-4f00-8acb-7a0e52328b41",
      leaseToken: "fixture-lease",
      backendKey: "fixture-backend-key",
      backendId: "fixture-endpoint-backend",
      targetKey: TARGET,
      resourceUid: "e56df985-1f57-4e93-a1bd-bdcb0845ebc0",
      principal: "org:fixture",
      action: "create" as const,
      generation: 1,
      form: WORKER_ENDPOINT_FORM_URL,
      space: "fixture",
      name: "endpoint",
      spec: { worker: { resourceUid: "b340e70c-fac9-48a6-a950-1b3034d7029a" } },
      previousObserved: {},
      previousOutput: {},
    };
    const currentServing = {
      workerUid: "b340e70c-fac9-48a6-a950-1b3034d7029a",
      targetKey: TARGET,
      sourceOperationId: "23fd4413-9f1d-4f00-8acb-7a0e52328b41",
      expectedIdentity: {
        generation: "takoserver-v2-operation:23fd4413-9f1d-4f00-8acb-7a0e52328b41",
        workerResourceUid: "b340e70c-fac9-48a6-a950-1b3034d7029a",
        hostnames: ["v2-b340e70cfac948a6a9501b3034d7029a.workers.example.test"],
        versions: [{ workerVersionUid: "a340e70c-fac9-48a6-a950-1b3034d7029a", weight: 10_000 }],
      },
    };

    await expect(
      composition.endpointPublicationState.resolve({ execution }),
    ).resolves.toMatchObject({
      kind: "unresolved",
    });
    await expect(
      composition.endpointPublicationState.resolveCurrentServing(currentServing),
    ).resolves.toMatchObject({ kind: "unresolved" });

    await composition.restoreOwners();
    await expect(
      composition.endpointPublicationState.resolve({ execution }),
    ).resolves.toMatchObject({
      kind: "unresolved",
    });
    await composition.suspendOwnersRetainingCustody();
    await expect(
      composition.endpointPublicationState.resolve({ execution }),
    ).resolves.toMatchObject({
      kind: "unresolved",
    });
    await expect(
      composition.endpointPublicationState.resolveCurrentServing(currentServing),
    ).resolves.toMatchObject({ kind: "unresolved" });
    await expect(composition.ownerForWorkerUid(currentServing.workerUid)).rejects.toThrow(
      "v2 Worker owner admission is frozen",
    );
    expect(() => composition.internalFormFactory({ sql, objects, clock })).toThrow(
      "v2 Worker owners must restore before Form composition",
    );
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("normal Worker boot refuses an unexplained private owner namespace", async () => {
  const root = await mkdtemp(join(tmpdir(), "selfhost-v2-worker-foreign-"));
  const database = new Database(join(root, "control.sqlite"));
  try {
    migrateSqlite(database);
    const ownerRoot = join(root, "v2-worker-owners");
    await mkdir(join(ownerRoot, "unexplained"), { recursive: true, mode: 0o700 });
    const composition = createSelfhostV2WorkerComposition({
      sql: createSqliteSql(database),
      objects: createMemoryObjectStore(),
      clock: () => new Date(),
      config: {
        cursorSigningKey: new Uint8Array(32).fill(0x52),
        documentation: "https://docs.example.test/v2",
        authenticationDocumentation: "https://docs.example.test/v2/authentication",
      },
      rootDirectory: ownerRoot,
      targetKey: TARGET,
      workerdBinary: null,
    });
    await expect(composition.restoreOwners()).rejects.toThrow(
      "v2 Worker owner namespace is not explained by current SQL",
    );
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("normal Worker factory refuses partial or invalid Endpoint frontend proof", async () => {
  const root = await mkdtemp(join(tmpdir(), "selfhost-v2-worker-partial-endpoint-"));
  const database = new Database(join(root, "control.sqlite"));
  try {
    migrateSqlite(database);
    const sql = createSqliteSql(database);
    const objects = createMemoryObjectStore();
    const clock = () => new Date();
    for (const endpoint of [
      { assignHostname: () => "worker.example.test" },
      {
        assignHostname: () => "worker.example.test",
        observeTls: true,
        observeRouteAbsent: async () => ({ absent: true }),
      },
    ]) {
      const composition = createSelfhostV2WorkerComposition({
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
        endpoint: endpoint as unknown as NonNullable<
          Parameters<typeof createSelfhostV2WorkerComposition>[0]["endpoint"]
        >,
      });
      expect(await composition.restoreOwners()).toEqual([]);
      expect(() => composition.internalFormFactory({ sql, objects, clock })).toThrow(
        "v2 Worker Endpoint frontend proof is not composed",
      );
    }
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function exerciseStaticWorkerGraph(withEndpoint: boolean): Promise<void> {
  // This registers the incomplete Forms only in a local test Host. The child
  // proves process/listener fencing, not native Workerd or public HTTPS TLS.
  const root = await mkdtemp(join(tmpdir(), "selfhost-v2-worker-http-"));
  const binary = join(root, "bun-workerd-stand-in.js");
  const database = new Database(join(root, "control.sqlite"));
  const children: WorkerdProcess[] = [];
  let closeOwner: (() => Promise<void>) | undefined;
  const identity = {
    async verify({ assertion }: { assertion: string }) {
      return {
        providerSubject: assertion,
        email: `${assertion}@example.test`,
        displayName: assertion,
      };
    },
  };
  try {
    await writeFile(binary, `#!${process.execPath}\n${CHILD_SOURCE}`, { mode: 0o700 });
    await chmod(binary, 0o700);
    migrateSqlite(database);
    const sql = createSqliteSql(database);
    const objects = createMemoryObjectStore();
    const clock = () => new Date();
    const accounts = createAccounts({ sql, identity, clock });
    const signedIn = await accounts.signIn({ provider: "google", assertion: "worker-owner" });
    const actor = await accounts.authenticate(`Bearer ${signedIn.sessionToken}`);
    if (!actor) throw new Error("fixture owner did not authenticate");
    const organization = await accounts.createOrganization({ actor, name: "Worker Org" });
    const key = await accounts.createApiKey({
      actor,
      organizationId: organization.id,
      name: "worker writer",
      scopes: ["resources:write"],
      expiresInSeconds: 3_600,
    });
    const fileUrl = "https://artifacts.example.test/v2-worker/index.html";
    const manifestUrl = "https://artifacts.example.test/v2-worker/manifest.json";
    const file = new TextEncoder().encode("<main>held asset</main>");
    const fileSha = (await bytesDigest(file)).slice(7);
    const manifest = new TextEncoder().encode(
      JSON.stringify({
        files: [{ path: "index.html", url: fileUrl, sha256: fileSha, mediaType: "text/html" }],
      }),
    );
    const manifestSha = (await bytesDigest(manifest)).slice(7);
    await objects.create("v2-worker/manifest", manifest);
    await objects.create("v2-worker/index.html", file);
    const grants = [{ principal: `org:${organization.id}`, space: organization.id }];
    const config = {
      cursorSigningKey: new Uint8Array(32).fill(0x52),
      documentation: "https://docs.example.test/v2",
      authenticationDocumentation: "https://docs.example.test/v2/authentication",
      staticAssetBundle: {
        targetKey: TARGET,
        heldArtifacts: [
          { url: manifestUrl, sha256: manifestSha, objectKey: "v2-worker/manifest", grants },
          { url: fileUrl, sha256: fileSha, objectKey: "v2-worker/index.html", grants },
        ],
      },
    };
    let composition: ReturnType<typeof createSelfhostV2WorkerComposition>;
    composition = createSelfhostV2WorkerComposition({
      sql,
      objects,
      clock,
      config,
      rootDirectory: join(root, "v2-worker-owners"),
      targetKey: TARGET,
      workerdBinary: binary,
      spawn(command) {
        const child = spawnWorkerdWithParentDeath(command, {
          stdout: "ignore",
          stderr: "ignore",
        });
        children.push(child);
        return child;
      },
      ...(withEndpoint
        ? {
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
          }
        : {}),
    });
    expect(() => composition.internalFormFactory({ sql, objects, clock })).toThrow(
      "v2 Worker owners must restore before Form composition",
    );
    expect(await composition.restoreOwners()).toEqual([]);
    expect(() =>
      composition.internalFormFactory({ sql, objects: createMemoryObjectStore(), clock }),
    ).toThrow("v2 Worker Forms must use this application's exact SQL, objects and clock");
    const workerForms = composition.internalFormFactory({ sql, objects, clock });
    expect(workerForms[MODULE_WORKER_FORM_URL]).toBeDefined();
    expect(workerForms[WORKER_VERSION_FORM_URL]).toBeDefined();
    expect(workerForms[WORKER_DEPLOYMENT_FORM_URL]).toBeDefined();
    expect(workerForms[WORKER_ENDPOINT_FORM_URL] !== undefined).toBe(withEndpoint);
    const app = buildApp({
      sql,
      objects,
      clock,
      identity,
      settlement: {
        async verify() {
          throw new Error("not configured");
        },
      },
      publicOrigin: ORIGIN,
      forms: [],
      hostForms: [],
      driver: new InMemoryTakoformResourceDriver(),
      offerings: [],
      v2: config,
      v2FormFactory: composition.internalFormFactory,
    });
    const http = (
      path: string,
      method = "GET",
      body?: unknown,
      replayKey?: string,
      generation?: number,
    ) =>
      app.fetch(
        new Request(`${ORIGIN}${API}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${key.secret}`,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
            ...(replayKey ? { "idempotency-key": replayKey } : {}),
            ...(generation === undefined
              ? {}
              : { "takoform-expected-generation": String(generation) }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    const create = async (form: string, name: string, spec: Record<string, unknown>) => {
      const response = await http(
        "/resources",
        "POST",
        { form, space: organization.id, name, spec },
        `create-${name}-normal-worker`,
      );
      expect(response.status).toBe(202);
      const accepted = (await response.json()) as { id: string; resourceUid: string };
      expect(await app.tickTakoformV2()).toMatchObject({ id: accepted.id, status: "succeeded" });
      return accepted.resourceUid;
    };
    const remove = async (uid: string, name: string) => {
      const response = await http(
        `/resources/${uid}`,
        "DELETE",
        undefined,
        `delete-${name}-normal-worker`,
        1,
      );
      expect(response.status).toBe(202);
      const accepted = (await response.json()) as { id: string; resourceUid: string };
      expect(accepted.resourceUid).toBe(uid);
      expect(await app.tickTakoformV2()).toMatchObject({
        id: accepted.id,
        status: "succeeded",
        effect: "complete",
      });
      expect((await http(`/resources/${uid}`)).status).toBe(410);
    };
    const workerUid = await create(MODULE_WORKER_FORM_URL, "worker", {});
    const assetUid = await create(STATIC_ASSET_BUNDLE_FORM_URL, "asset", {
      artifact: { url: manifestUrl, sha256: manifestSha },
    });
    const versionUid = await create(WORKER_VERSION_FORM_URL, "version", {
      worker: { resourceUid: workerUid },
      handlers: [],
      assets: {
        bundle: { resourceUid: assetUid },
        runWorkerFirst: false,
        notFoundHandling: "none",
      },
    });
    const deploymentUid = await create(WORKER_DEPLOYMENT_FORM_URL, "deployment", {
      worker: { resourceUid: workerUid },
      versions: [{ workerVersion: { resourceUid: versionUid }, weight: 10_000 }],
    });
    let endpointUid: string | undefined;
    if (withEndpoint) {
      endpointUid = await create(WORKER_ENDPOINT_FORM_URL, "endpoint", {
        worker: { resourceUid: workerUid },
      });
      const endpoint = await http(`/resources/${endpointUid}`);
      expect(endpoint.status).toBe(200);
      expect(await endpoint.json()).toMatchObject({
        uid: endpointUid,
        observed: { activeDeploymentRouteReady: true, tlsReady: true },
      });
    }
    const owner = await composition.ownerForWorkerUid(workerUid);
    closeOwner = () => owner.close();
    const serving = await owner.observeServing({
      workerResourceUid: workerUid,
      targetKey: TARGET,
    });
    expect(serving).toMatchObject({ kind: "serving", workerResourceUid: workerUid });
    const served = await owner.fetch(new Request("https://worker.example.test/"));
    expect(served.status).toBe(200);
    if (endpointUid) await remove(endpointUid, "endpoint");
    await remove(deploymentUid, "deployment");
    await remove(versionUid, "version");
    await remove(assetUid, "asset");
    await remove(workerUid, "worker");
    await owner.close();
  } finally {
    await closeOwner?.().catch(() => undefined);
    for (const child of children) child.kill();
    await Promise.all(children.map((child) => child.exited));
    database.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("normal organization HTTP accepts static Worker graph with Endpoint frontend proof", () =>
  exerciseStaticWorkerGraph(true));
test("normal organization HTTP accepts static Worker graph without Endpoint frontend proof", () =>
  exerciseStaticWorkerGraph(false));
