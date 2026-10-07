import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { JsonObject } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { STATIC_ASSET_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/static-asset-bundle.ts";
import { createStaticAssetBundleHost } from "../src/takoform-v2/forms/static-asset-bundle-backend.ts";
import {
  MODULE_WORKER_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import { createTakoformV2Routes } from "../src/takoform-v2/routes.ts";
import type { V2Operation } from "../src/takoform-v2/types.ts";
import { createWorkerDeploymentForm } from "../src/takoform-v2/worker-deployment-backend.ts";
import {
  createInternalV2ModuleWorkerForm,
  createInternalV2StaticWorkerVersionForm,
} from "../src/takoform-v2/worker-lifecycle-backend.ts";
import { createV2WorkerPublicationState } from "../src/takoform-v2/worker-publication-state.ts";
import { createV2WorkerdWorkerRuntimeReaders } from "../src/takoform-v2/worker-runtime-readers.ts";
import { spawnWorkerdWithParentDeath } from "../src/workerd-linux-process.ts";
import type { WorkerdProcess } from "../src/workerd-supervisor.ts";
import type { WorkerdWorkerRuntimeOwner } from "../src/workerd-worker-runtime-owner.ts";
import { openWorkerdWorkerRuntimeOwner } from "../src/workerd-worker-runtime-owner.ts";

const TARGET_KEY = "integrated-v2-worker-readers";
const HOST_BASE = "https://host.example.test/takoform-v2";
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
  if (url.pathname === "/hold") {
    let timer;
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(current.generation)); timer = setInterval(() => controller.enqueue(new Uint8Array([46])), 20); },
      cancel() { clearInterval(timer); },
    }));
  }
  return new Response(current.generation);
} });
process.on("SIGTERM", () => server.stop(true));
`;

async function unusedPort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = Number(server.port);
  await server.stop(true);
  return port;
}

async function until(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(20);
  }
  throw new Error("runtime owner did not confirm physical retirement");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("runtime readers refuse a selected owner for another Worker UID", async () => {
  let observed = false;
  const wrongOwner: Pick<
    WorkerdWorkerRuntimeOwner,
    "workerResourceUid" | "observeServing" | "observeRetirement"
  > = {
    workerResourceUid: "other-worker",
    async observeServing() {
      observed = true;
      return { kind: "unknown" as const };
    },
    async observeRetirement() {
      observed = true;
      return { kind: "unknown" as const };
    },
  };
  const readers = createV2WorkerdWorkerRuntimeReaders({
    ownerForWorkerUid: async () => wrongOwner,
  });
  expect(
    await readers.serving.observeServing({
      workerResourceUid: "worker-one",
      targetKey: "target-one",
    }),
  ).toEqual({ kind: "unknown" });
  expect(
    await readers.retirement.observeRetired({
      kind: "worker",
      workerUid: "worker-one",
      versionUid: null,
      operationId: "operation-one",
      resourceUid: "worker-one",
      principal: "organization-one",
      space: "prod",
      targetKey: "target-one",
      backendId: "worker-backend",
      backendKey: "worker-operation-key",
      generation: 2,
    }),
  ).toEqual({ kind: "unknown" });
  expect(observed).toBe(false);
});

test("runtime readers reject a foreign target or Version absence and uncertain owner reads", async () => {
  const owner: Pick<
    WorkerdWorkerRuntimeOwner,
    "workerResourceUid" | "observeServing" | "observeRetirement"
  > = {
    workerResourceUid: "worker-one",
    async observeServing() {
      return {
        kind: "serving",
        workerResourceUid: "worker-one",
        targetKey: "foreign-target",
        sourceOperationId: "53fb130a-ff93-49d7-b181-3757f9ae1263",
        generation: "takoserver-v2-operation:53fb130a-ff93-49d7-b181-3757f9ae1263",
        hostnames: [],
        versions: [{ workerVersionUid: "version-one", weight: 10_000 }],
      } as const;
    },
    async observeRetirement() {
      return {
        kind: "confirmed_absent",
        workerResourceUid: "worker-one",
        targetKey: "target-one",
        workerVersionUid: "foreign-version",
        incarnationOperationIds: [],
      } as const;
    },
  };
  const readers = createV2WorkerdWorkerRuntimeReaders({ ownerForWorkerUid: () => owner });
  expect(
    await readers.serving.observeServing({
      workerResourceUid: "worker-one",
      targetKey: "target-one",
    }),
  ).toEqual({ kind: "unknown" });
  expect(
    await readers.retirement.observeRetired({
      kind: "version",
      workerUid: "worker-one",
      versionUid: "version-one",
      operationId: "delete-version-one",
      resourceUid: "version-one",
      principal: "organization-one",
      space: "prod",
      targetKey: "target-one",
      backendId: "version-backend",
      backendKey: "version-delete-key",
      generation: 2,
    }),
  ).toEqual({ kind: "unknown" });
  const failing = createV2WorkerdWorkerRuntimeReaders({
    ownerForWorkerUid: async () => {
      throw new Error("owner lock unavailable");
    },
  });
  expect(
    await failing.serving.observeServing({
      workerResourceUid: "worker-one",
      targetKey: "target-one",
    }),
  ).toEqual({ kind: "unknown" });
});

test("Host HTTP lifecycle and UID-owned runtime require physical Version retirement before deletes", async () => {
  // The child is an injected config-readback substitute, not a native workerd
  // qualification. SQL, held bytes, owner state and execution copies are real.
  const root = await mkdtemp(join(tmpdir(), "v2-worker-runtime-readers-"));
  const binary = join(root, "bun-workerd-stand-in.js");
  await writeFile(binary, `#!${process.execPath}\n${CHILD_SOURCE}`, { mode: 0o700 });
  await chmod(binary, 0o700);
  const db = new Database(join(root, "state.sqlite"));
  migrateSqlite(db);
  const sql = createSqliteSql(db);
  const fileBytes = new TextEncoder().encode("<main>verified held asset</main>");
  const fileUrl = "https://artifacts.example.test/reader/index.html";
  const manifestUrl = "https://artifacts.example.test/reader/manifest.json";
  const manifestBytes = new TextEncoder().encode(
    JSON.stringify({
      files: [
        { path: "index.html", url: fileUrl, sha256: sha256(fileBytes), mediaType: "text/html" },
      ],
    }),
  );
  let sourceAvailable = true;
  let nowMs = Date.now();
  const assetHost = createStaticAssetBundleHost({
    sql,
    targetKey: TARGET_KEY,
    source: {
      async read({ url }) {
        if (!sourceAvailable) throw new Error("artifact source unavailable");
        if (url === manifestUrl) return manifestBytes;
        if (url === fileUrl) return fileBytes;
        throw new Error("unexpected artifact source");
      },
    },
  });
  const publicationState = createV2WorkerPublicationState({
    sql,
    now: () => new Date(nowMs),
    assetCustody: assetHost.custody,
  });
  let owner: WorkerdWorkerRuntimeOwner | undefined;
  let heldReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const children: ReturnType<typeof spawnWorkerdWithParentDeath>[] = [];
  const readers = createV2WorkerdWorkerRuntimeReaders({
    ownerForWorkerUid: async (uid) => (owner?.workerResourceUid === uid ? owner : null),
  });
  const engine = createTakoformV2Engine({
    sql,
    now: () => new Date(nowMs),
    replayWindowSeconds: 3_600,
    leaseMilliseconds: 1_000,
    authorize: async () => true,
    forms: {
      [MODULE_WORKER_FORM_URL]: createInternalV2ModuleWorkerForm({
        sql,
        targetKey: TARGET_KEY,
        ...readers,
      }),
      [STATIC_ASSET_BUNDLE_FORM_URL]: assetHost.form,
      [WORKER_VERSION_FORM_URL]: createInternalV2StaticWorkerVersionForm({
        sql,
        targetKey: TARGET_KEY,
        publicationState,
        retirement: readers.retirement,
      }),
      [WORKER_DEPLOYMENT_FORM_URL]: createWorkerDeploymentForm({
        targetKey: TARGET_KEY,
        publicationState,
        ownerForWorker: async (uid) => {
          if (!owner || owner.workerResourceUid !== uid) throw new Error("wrong owner");
          return owner;
        },
      }),
    },
  });
  const router = createTakoformV2Routes(engine, {
    baseUrl: HOST_BASE,
    documentation: "https://docs.example.test/takoform-v2",
    authenticationDocumentation: "https://docs.example.test/takoform-v2/authentication",
    authenticationSchemes: ["Bearer"],
    maxRequestBytes: 65_536,
    maxPageSize: 10,
    replayWindowSeconds: 3_600,
    cursorSigningKey: new Uint8Array(32).fill(0x6a), // test-only stable key
    authenticate: async (request) =>
      request.headers.get("authorization") === "Bearer worker-fixture-token"
        ? { principal: "org-reader", access: "write" }
        : null,
  });
  const http = async (
    path: string,
    init: {
      method: "GET" | "POST" | "PUT" | "DELETE";
      key?: string;
      generation?: number;
      body?: JsonObject;
    },
  ): Promise<Response> => {
    const headers = new Headers({ authorization: "Bearer worker-fixture-token" });
    if (init.key) headers.set("idempotency-key", init.key);
    if (init.generation !== undefined)
      headers.set("takoform-expected-generation", String(init.generation));
    if (init.body) headers.set("content-type", "application/json");
    const response = await router.fetch(
      new Request(`${HOST_BASE}${path}`, {
        method: init.method,
        headers,
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      }),
    );
    if (!response) throw new Error("v2 Host route did not handle the request");
    return response;
  };
  const accepted = async (response: Response): Promise<V2Operation> => {
    expect(response.status).toBe(202);
    return (await response.json()) as V2Operation;
  };
  const create = async (form: string, name: string, spec: JsonObject) => {
    const operation = await accepted(
      await http("/resources", {
        method: "POST",
        key: `create-${name}-reader-key`,
        body: { form, space: "prod", name, spec },
      }),
    );
    expect(await engine.runNext()).toMatchObject({ id: operation.id, status: "succeeded" });
    return operation;
  };
  try {
    const unauthorized = await router.fetch(new Request(`${HOST_BASE}/resources`));
    expect(unauthorized?.status).toBe(401);
    const worker = await create(MODULE_WORKER_FORM_URL, "worker", {});
    const asset = await create(STATIC_ASSET_BUNDLE_FORM_URL, "asset", {
      artifact: { url: manifestUrl, sha256: sha256(manifestBytes) },
    });
    const versionSpec: JsonObject = {
      worker: { resourceUid: worker.resourceUid },
      handlers: [],
      assets: {
        bundle: { resourceUid: asset.resourceUid },
        runWorkerFirst: false,
        notFoundHandling: "none",
      },
    };
    const firstVersion = await create(WORKER_VERSION_FORM_URL, "version-one", versionSpec);
    const secondVersion = await create(WORKER_VERSION_FORM_URL, "version-two", versionSpec);
    owner = await openWorkerdWorkerRuntimeOwner({
      rootDirectory: join(root, "owners"),
      workerResourceUid: worker.resourceUid,
      targetKey: TARGET_KEY,
      publicationState,
      workerdBinary: binary,
      listenerPortForOperation: unusedPort,
      spawn(command: readonly string[]): WorkerdProcess {
        const child = spawnWorkerdWithParentDeath(command, { stdout: "ignore", stderr: "ignore" });
        children.push(child);
        return child;
      },
    });
    sourceAvailable = false;
    const firstSpec: JsonObject = {
      worker: { resourceUid: worker.resourceUid },
      versions: [{ workerVersion: { resourceUid: firstVersion.resourceUid }, weight: 10_000 }],
    };
    const deployment = await create(WORKER_DEPLOYMENT_FORM_URL, "deployment", firstSpec);
    const workerUpdate = await accepted(
      await http(`/resources/${worker.resourceUid}`, {
        method: "PUT",
        key: "worker-observe-first-deployment",
        generation: 1,
        body: { spec: {} },
      }),
    );
    expect(await engine.runNext()).toMatchObject({ id: workerUpdate.id, status: "succeeded" });
    expect(
      await (await http(`/resources/${worker.resourceUid}`, { method: "GET" })).json(),
    ).toMatchObject({
      observed: { activeDeploymentUid: deployment.resourceUid, ready: true },
    });
    const blockedVersionDelete = await http(`/resources/${firstVersion.resourceUid}`, {
      method: "DELETE",
      key: "first-version-delete-while-selected",
      generation: 1,
    });
    expect(blockedVersionDelete.status).toBe(409);
    expect(await blockedVersionDelete.json()).toMatchObject({ code: "dependency_conflict" });

    heldReader = (
      await owner.fetch(new Request("https://worker.example.test/hold"))
    ).body?.getReader();
    if (!heldReader) throw new Error("expected tracked invocation body");
    await heldReader.read();
    const secondSpec: JsonObject = {
      worker: { resourceUid: worker.resourceUid },
      versions: [{ workerVersion: { resourceUid: secondVersion.resourceUid }, weight: 10_000 }],
    };
    const deploymentUpdate = await accepted(
      await http(`/resources/${deployment.resourceUid}`, {
        method: "PUT",
        key: "deployment-switch-version",
        generation: 1,
        body: { spec: secondSpec },
      }),
    );
    expect(await engine.runNext()).toMatchObject({
      id: deploymentUpdate.id,
      status: "succeeded",
    });
    const firstDeleteInput = {
      method: "DELETE" as const,
      key: "first-version-delete-after-switch",
      generation: 1,
    };
    const firstDelete = await accepted(
      await http(`/resources/${firstVersion.resourceUid}`, firstDeleteInput),
    );
    expect(await engine.runNext()).toMatchObject({
      id: firstDelete.id,
      status: "reconciling",
      effect: "unknown",
    });
    expect(
      await (await http(`/operations/${firstDelete.id}`, { method: "GET" })).json(),
    ).toMatchObject({ status: "reconciling", effect: "unknown" });
    expect(await owner.observeRetirement({ workerVersionUid: firstVersion.resourceUid })).toEqual({
      kind: "unknown",
    });
    await heldReader.cancel();
    heldReader = undefined;
    await until(
      async () =>
        (await owner?.observeRetirement({ workerVersionUid: firstVersion.resourceUid }))?.kind ===
        "confirmed_absent",
    );
    nowMs += 2_000;
    expect(await engine.runNext()).toMatchObject({ id: firstDelete.id, status: "succeeded" });
    expect(
      await (await http(`/operations/${firstDelete.id}`, { method: "GET" })).json(),
    ).toMatchObject({ status: "succeeded", effect: "complete" });
    const firstReplay = await http(`/resources/${firstVersion.resourceUid}`, firstDeleteInput);
    expect(firstReplay.status).toBe(200);
    expect(await firstReplay.json()).toMatchObject({ id: firstDelete.id });

    const deploymentDelete = await accepted(
      await http(`/resources/${deployment.resourceUid}`, {
        method: "DELETE",
        key: "deployment-delete-after-switch",
        generation: 2,
      }),
    );
    expect(await engine.runNext()).toMatchObject({ id: deploymentDelete.id, status: "succeeded" });
    await expect(
      owner.fetch(new Request("https://worker.example.test/late")),
    ).rejects.toMatchObject({
      code: "admission_closed",
    });
    const secondDelete = await accepted(
      await http(`/resources/${secondVersion.resourceUid}`, {
        method: "DELETE",
        key: "second-version-delete-after-deployment",
        generation: 1,
      }),
    );
    expect(await engine.runNext()).toMatchObject({ id: secondDelete.id, status: "succeeded" });
    const workerDeleteInput = {
      method: "DELETE" as const,
      key: "worker-delete-after-versions",
      generation: 2,
    };
    const workerDelete = await accepted(
      await http(`/resources/${worker.resourceUid}`, workerDeleteInput),
    );
    expect(await engine.runNext()).toMatchObject({ id: workerDelete.id, status: "succeeded" });
    expect(
      await (await http(`/operations/${workerDelete.id}`, { method: "GET" })).json(),
    ).toMatchObject({ status: "succeeded", effect: "complete" });
    const workerReplay = await http(`/resources/${worker.resourceUid}`, workerDeleteInput);
    expect(workerReplay.status).toBe(200);
    expect(await workerReplay.json()).toMatchObject({ id: workerDelete.id });
    await owner.close();
  } finally {
    await heldReader?.cancel().catch(() => undefined);
    await owner?.close().catch(() => undefined);
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await Promise.all(children.map((child) => child.exited));
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
