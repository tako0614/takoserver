import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesDigest } from "../src/json.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { JsonObject } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { STATIC_ASSET_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/static-asset-bundle.ts";
import { createStaticAssetBundleHost } from "../src/takoform-v2/forms/static-asset-bundle-backend.ts";
import { referencesForWorkerVersion } from "../src/takoform-v2/forms/worker-references.ts";
import {
  MODULE_WORKER_FORM_URL,
  parseModuleWorkerSpec,
  parseWorkerDeploymentSpec,
  parseWorkerVersionSpec,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import type { V2Execution, V2Form } from "../src/takoform-v2/types.ts";
import { createWorkerCronTriggerAdmissionReader } from "../src/takoform-v2/worker-cron-trigger-backend.ts";
import { createWorkerDeploymentForm } from "../src/takoform-v2/worker-deployment-backend.ts";
import type { V2WorkerPublicationResolution } from "../src/takoform-v2/worker-publication-state.ts";
import { createV2WorkerPublicationState } from "../src/takoform-v2/worker-publication-state.ts";
import { spawnWorkerdWithParentDeath } from "../src/workerd-linux-process.ts";
import type { WorkerdProcess } from "../src/workerd-supervisor.ts";
import {
  openWorkerdWorkerRuntimeOwner,
  type WorkerdWorkerRuntimeOwner,
} from "../src/workerd-worker-runtime-owner.ts";

const TARGET_KEY = "fixture-v2-worker-runtime-owner";
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
const initial = identity();
const server = Bun.serve({ hostname: "127.0.0.1", port: initial.port, fetch(request) {
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

async function unusedPort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = Number(server.port);
  await server.stop(true);
  return port;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("accepted Deployment create, update, replay and delete settle only through the UID-owned native runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "v2-deployment-backend-"));
  const binary = join(root, "bun-workerd-stand-in.js");
  await writeFile(binary, `#!${process.execPath}\n${CHILD_SOURCE}`, { mode: 0o700 });
  await chmod(binary, 0o700);
  const db = new Database(join(root, "state.sqlite"));
  migrateSqlite(db);
  const sql = createSqliteSql(db);
  const fileBytes = new TextEncoder().encode("<h1>owned static worker</h1>");
  const fileUrl = "https://artifacts.example.test/static/index.html";
  const manifestUrl = "https://artifacts.example.test/static/manifest.json";
  const manifestBytes = new TextEncoder().encode(
    JSON.stringify({
      files: [
        { path: "index.html", url: fileUrl, sha256: sha256(fileBytes), mediaType: "text/html" },
      ],
    }),
  );
  let sourceAvailable = true;
  const assets = createStaticAssetBundleHost({
    sql,
    targetKey: TARGET_KEY,
    source: {
      async read({ url }) {
        if (!sourceAvailable) throw new Error("source removed");
        if (url === manifestUrl) return manifestBytes;
        if (url === fileUrl) return fileBytes;
        throw new Error("unknown source");
      },
    },
  });
  const publicationState = createV2WorkerPublicationState({ sql, assetCustody: assets.custody });
  let owner: WorkerdWorkerRuntimeOwner | undefined;
  let loseNextOwnerAcknowledgement = false;
  let clockMs = Date.now();
  const children: ReturnType<typeof spawnWorkerdWithParentDeath>[] = [];
  const deploymentForm = createWorkerDeploymentForm({
    targetKey: TARGET_KEY,
    publicationState,
    scheduledAttachments: createWorkerCronTriggerAdmissionReader({
      sql,
      now: () => new Date(clockMs),
    }),
    ownerForWorker(workerUid) {
      const selectedOwner = owner;
      if (!selectedOwner || selectedOwner.workerResourceUid !== workerUid)
        throw new Error("owner unavailable");
      return {
        workerResourceUid: selectedOwner.workerResourceUid,
        async execute(input) {
          const confirmed = await selectedOwner.execute(input);
          if (loseNextOwnerAcknowledgement && confirmed.kind === "confirmed") {
            loseNextOwnerAcknowledgement = false;
            return { kind: "unknown" as const };
          }
          return confirmed;
        },
      };
    },
  });
  // Only the prerequisite ModuleWorker/Version confirmations are seeded here.
  // Deployment effects use the real UID-owned runtime and held asset custody;
  // this fixture does not qualify the unfinished WorkerVersion ABI as a Form.
  const simpleBackend = {
    id: "fixture-identity-or-version",
    targetKey: TARGET_KEY,
    async execute(input: V2Execution) {
      return {
        kind: "complete" as const,
        observed:
          input.form === WORKER_VERSION_FORM_URL
            ? { ready: true, resolvedBindings: true }
            : { ready: true },
        output: {},
      };
    },
    async reconcile() {
      return { kind: "unknown" as const };
    },
  };
  const workerForm: V2Form = {
    validateCreate: parseModuleWorkerSpec,
    validateUpdate: (_previous, next) => {
      parseModuleWorkerSpec(next);
    },
    backend: simpleBackend,
  };
  const versionForm: V2Form = {
    validateCreate: parseWorkerVersionSpec,
    validateUpdate: (_previous, next) => {
      parseWorkerVersionSpec(next);
    },
    references: (spec) => referencesForWorkerVersion(parseWorkerVersionSpec(spec)),
    backend: simpleBackend,
  };
  const engine = createTakoformV2Engine({
    sql,
    now: () => new Date(clockMs),
    replayWindowSeconds: 3600,
    leaseMilliseconds: 1_000,
    authorize: async () => true,
    forms: {
      [MODULE_WORKER_FORM_URL]: workerForm,
      [STATIC_ASSET_BUNDLE_FORM_URL]: assets.form,
      [WORKER_VERSION_FORM_URL]: versionForm,
      [WORKER_DEPLOYMENT_FORM_URL]: deploymentForm,
    },
  });
  const create = async (form: string, name: string, spec: JsonObject) => {
    const accepted = await engine.acceptCreate({
      principal: "org-fixture",
      key: `create-${name}-key-0001`,
      input: { form, space: "prod", name, spec },
    });
    expect(await engine.runNext()).toMatchObject({ id: accepted.id, status: "succeeded" });
    return accepted;
  };
  try {
    const worker = await create(MODULE_WORKER_FORM_URL, "worker", {});
    const asset = await create(STATIC_ASSET_BUNDLE_FORM_URL, "assets", {
      artifact: { url: manifestUrl, sha256: sha256(manifestBytes) },
    });
    const version = await create(WORKER_VERSION_FORM_URL, "version", {
      worker: { resourceUid: worker.resourceUid },
      handlers: [],
      assets: {
        bundle: { resourceUid: asset.resourceUid },
        runWorkerFirst: false,
        notFoundHandling: "none",
      },
    });
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
    const spec = {
      worker: { resourceUid: worker.resourceUid },
      versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
    };
    const deployment = await create(WORKER_DEPLOYMENT_FORM_URL, "deployment", spec);
    expect(
      await engine.getResource({ principal: "org-fixture", uid: deployment.resourceUid }),
    ).toMatchObject({
      observed: {
        ready: true,
        active: true,
        selectedVersions: [{ resourceUid: version.resourceUid, weight: 10_000 }],
      },
      output: {},
    });
    expect(children).toHaveLength(1);
    const replay = await engine.acceptCreate({
      principal: "org-fixture",
      key: "create-deployment-key-0001",
      input: { form: WORKER_DEPLOYMENT_FORM_URL, space: "prod", name: "deployment", spec },
    });
    expect(replay.id).toBe(deployment.id);
    expect(children).toHaveLength(1);
    const update = await engine.acceptUpdate({
      principal: "org-fixture",
      key: "update-deployment-key-0001",
      uid: deployment.resourceUid,
      expectedGeneration: 1,
      spec,
    });
    loseNextOwnerAcknowledgement = true;
    expect(await engine.runNext()).toMatchObject({
      id: update.id,
      status: "reconciling",
      effect: "unknown",
    });
    expect(children).toHaveLength(2);
    clockMs += 2_000;
    expect(await engine.runNext()).toMatchObject({ id: update.id, status: "succeeded" });
    expect(children).toHaveLength(2); // reconciliation did not mint another native incarnation
    const deleted = await engine.acceptDelete({
      principal: "org-fixture",
      key: "delete-deployment-key-0001",
      uid: deployment.resourceUid,
      expectedGeneration: 2,
    });
    expect(await engine.runNext()).toMatchObject({ id: deleted.id, status: "succeeded" });
    expect(children.every((child) => child.exitCode !== null || child.signalCode !== null)).toBe(
      true,
    );
    await owner.close();
  } finally {
    await owner?.close().catch(() => undefined);
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await Promise.all(children.map((child) => child.exited));
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an unconfirmed send, mismatched receipt, or lost SQL fence never settles a Deployment", async () => {
  const operationId = "940cd8af-b03f-4e06-bb45-25b348bb3ecd";
  const workerUid = "worker-backend-fence";
  const versionUid = "version-backend-fence";
  const secondVersionUid = "version-backend-second";
  const spec = parseWorkerDeploymentSpec({
    worker: { resourceUid: workerUid },
    versions: [
      { workerVersion: { resourceUid: versionUid }, weight: 7_000 },
      { workerVersion: { resourceUid: secondVersionUid }, weight: 3_000 },
    ],
  });
  const versionSpec = parseWorkerVersionSpec({
    worker: { resourceUid: workerUid },
    handlers: [],
    assets: {
      bundle: { resourceUid: "assets-backend-fence" },
      runWorkerFirst: false,
      notFoundHandling: "none",
    },
  });
  const execution: V2Execution = {
    operationId,
    leaseToken: "lease-backend-fence",
    backendKey: "backend-key-backend-fence",
    backendId: "selfhost-v2-worker-deployment-owner-v1",
    targetKey: TARGET_KEY,
    resourceUid: "deployment-backend-fence",
    principal: "org-fixture",
    action: "create",
    generation: 1,
    form: WORKER_DEPLOYMENT_FORM_URL,
    space: "prod",
    name: "deployment",
    spec: spec as unknown as JsonObject,
    previousObserved: {},
    previousOutput: {},
  };
  const snapshot = {
    sourceOperationId: operationId,
    worker: {
      uid: workerUid,
      principal: execution.principal,
      space: execution.space,
      generation: 1,
    },
    deployment: {
      uid: execution.resourceUid,
      generation: 1,
      spec,
      versions: [
        { uid: versionUid, generation: 1, weight: 7_000, spec: versionSpec },
        { uid: secondVersionUid, generation: 1, weight: 3_000, spec: versionSpec },
      ],
    },
    endpoint: null,
  };
  let fenceCurrent = true;
  let attachmentRequired = false;
  let attachmentCurrent = true;
  let attachmentReads = 0;
  let loseFenceDuringOwnerCall = false;
  let loseAttachmentDuringOwnerCall = false;
  let ownerCalls = 0;
  let result: Awaited<ReturnType<WorkerdWorkerRuntimeOwner["execute"]>> = {
    kind: "not_dispatched",
    code: "fixture_no_send",
  };
  const resolution = (): V2WorkerPublicationResolution => ({
    kind: "ready",
    snapshot,
    sqlGuard: { sql: "1", params: [] },
    stillCurrent: async () => fenceCurrent,
    readVersionMaterials: async () => ({ bundle: null, assets: null }),
  });
  // Reopening the Deployment backend without composing the canonical Cron
  // reader must fail at construction; accepted attachments can outlive Cron
  // registration in a Host process, so absence is never an empty set.
  expect(() =>
    createWorkerDeploymentForm({
      targetKey: TARGET_KEY,
      publicationState: { resolve: async () => resolution() },
      ownerForWorker: () => {
        ownerCalls += 1;
        throw new Error("missing attachment reader must not reach owner");
      },
    } as unknown as Parameters<typeof createWorkerDeploymentForm>[0]),
  ).toThrow("scheduledAttachments is required");
  expect(ownerCalls).toBe(0);
  const form = createWorkerDeploymentForm({
    targetKey: TARGET_KEY,
    publicationState: { resolve: async () => resolution() },
    scheduledAttachments: {
      async requiresScheduledHandler(input) {
        attachmentReads += 1;
        expect(input).toMatchObject({
          workerUid,
          principal: execution.principal,
          space: execution.space,
          targetKey: TARGET_KEY,
          sourceOperationId: operationId,
          leaseToken: execution.leaseToken,
          backendId: execution.backendId,
          backendKey: execution.backendKey,
        });
        return {
          kind: "ready" as const,
          required: attachmentRequired,
          attachmentUids: attachmentRequired ? ["cron-backend-fence"] : [],
          stillCurrent: async () => attachmentCurrent,
        };
      },
    },
    ownerForWorker: () => ({
      workerResourceUid: workerUid,
      async execute() {
        ownerCalls += 1;
        if (loseFenceDuringOwnerCall) fenceCurrent = false;
        if (loseAttachmentDuringOwnerCall) attachmentCurrent = false;
        return result;
      },
    }),
  });
  expect(form.references?.(execution.spec)).toHaveLength(3);
  attachmentRequired = true;
  expect(await form.backend.execute(execution)).toMatchObject({
    kind: "no_effect",
    code: "worker_scheduled_handler_missing",
  });
  expect(ownerCalls).toBe(0);
  snapshot.deployment.generation = 2;
  expect(
    await form.backend.execute({ ...execution, action: "update", generation: 2 }),
  ).toMatchObject({
    kind: "no_effect",
    code: "worker_scheduled_handler_missing",
  });
  expect(ownerCalls).toBe(0);
  snapshot.deployment.generation = 1;
  attachmentRequired = false;
  attachmentCurrent = false;
  expect(await form.backend.execute(execution)).toMatchObject({ kind: "unknown" });
  expect(ownerCalls).toBe(0);
  attachmentCurrent = true;
  expect(await form.backend.execute(execution)).toMatchObject({ kind: "unknown" });
  expect(await form.backend.reconcile(execution)).toMatchObject({ kind: "unknown" });
  expect(ownerCalls).toBe(2); // same accepted Operation reaches the same owner seam

  result = { kind: "unknown" };
  expect(await form.backend.reconcile(execution)).toMatchObject({ kind: "unknown" });
  result = {
    kind: "confirmed",
    deferRetirementUntilDeadline: false,
    identity: {
      generation: `takoserver-v2-operation:${operationId}`,
      workerResourceUid: workerUid,
      hostnames: [],
      versions: [{ versionId: "v2-not-the-version", workerVersionUid: versionUid, weight: 10_000 }],
    },
  };
  expect(await form.backend.reconcile(execution)).toMatchObject({ kind: "unknown" });
  const versionDigest = await bytesDigest(new TextEncoder().encode(`${versionUid}\u00001`));
  const secondDigest = await bytesDigest(new TextEncoder().encode(`${secondVersionUid}\u00001`));
  const exactVersions = [
    {
      versionId: `v2-${versionDigest.slice("sha256:".length)}`,
      workerVersionUid: versionUid,
      weight: 7_000,
    },
    {
      versionId: `v2-${secondDigest.slice("sha256:".length)}`,
      workerVersionUid: secondVersionUid,
      weight: 3_000,
    },
  ];
  result = {
    kind: "confirmed",
    deferRetirementUntilDeadline: false,
    identity: {
      generation: `takoserver-v2-operation:${operationId}`,
      workerResourceUid: workerUid,
      hostnames: [],
      versions: exactVersions.map((version, index) =>
        index === 0 ? { ...version, weight: 6_999 } : version,
      ),
    },
  };
  expect(await form.backend.reconcile(execution)).toMatchObject({ kind: "unknown" });
  result = {
    kind: "confirmed",
    deferRetirementUntilDeadline: false,
    identity: {
      generation: `takoserver-v2-operation:${operationId}`,
      workerResourceUid: workerUid,
      hostnames: [],
      versions: exactVersions,
    },
  };
  fenceCurrent = false;
  expect(await form.backend.reconcile(execution)).toMatchObject({ kind: "unknown" });
  fenceCurrent = true;
  loseFenceDuringOwnerCall = true;
  expect(await form.backend.reconcile(execution)).toMatchObject({ kind: "unknown" });
  loseFenceDuringOwnerCall = false;
  fenceCurrent = true;
  loseAttachmentDuringOwnerCall = true;
  expect(await form.backend.reconcile(execution)).toMatchObject({ kind: "unknown" });
  loseAttachmentDuringOwnerCall = false;
  attachmentCurrent = true;
  expect(await form.backend.reconcile(execution)).toMatchObject({
    kind: "complete",
    observed: {
      ready: true,
      active: true,
      selectedVersions: [
        { resourceUid: versionUid, weight: 7_000 },
        { resourceUid: secondVersionUid, weight: 3_000 },
      ],
    },
    output: {},
  });
  expect(await form.backend.execute({ ...execution, backendId: "wrong-backend" })).toMatchObject({
    kind: "unknown",
  });
  expect(ownerCalls).toBe(8);
  const scheduledVersionSpec = parseWorkerVersionSpec({
    worker: { resourceUid: workerUid },
    bundle: { resourceUid: "bundle-scheduled-backend-fence" },
    handlers: ["scheduled"],
  });
  const first = snapshot.deployment.versions[0];
  const second = snapshot.deployment.versions[1];
  if (!first || !second) throw new Error("weighted fixture versions missing");
  first.spec = scheduledVersionSpec;
  attachmentRequired = true;
  expect(await form.backend.reconcile(execution)).toMatchObject({
    kind: "no_effect",
    code: "worker_scheduled_handler_missing",
  });
  expect(ownerCalls).toBe(8);
  second.spec = scheduledVersionSpec;
  expect(await form.backend.reconcile(execution)).toMatchObject({ kind: "complete" });
  expect(ownerCalls).toBe(9);
  expect(attachmentReads).toBeGreaterThan(7);
});
