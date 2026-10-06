import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
  parseWorkerVersionSpec,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import { createV2Store } from "../src/takoform-v2/store.ts";
import type { V2Backend, V2Execution, V2Form } from "../src/takoform-v2/types.ts";
import { createV2WorkerPublicationState } from "../src/takoform-v2/worker-publication-state.ts";
import { createV2StaticWorkerPublication } from "../src/takoform-v2/worker-static-publication.ts";
import type {
  WorkerdDeploymentPublication,
  WorkerdPublicationIdentity,
  WorkerdStaticSite,
} from "../src/workerd-runtime.ts";

const TARGET_KEY = "fixture-worker-static-publication";
const MANIFEST_URL = "https://artifacts.example.test/site/manifest.json";
const FILE_URL = "https://artifacts.example.test/site/index.html";
const ASSET_BYTES = new TextEncoder().encode("<main>verified static content</main>");

function setup(runtime = fencedRuntime()) {
  const root = mkdtempSync(join(tmpdir(), "v2-static-publication-"));
  const db = new Database(join(root, "state.sqlite"));
  migrateSqlite(db);
  const sql = createSqliteSql(db);
  let nowMs = Date.UTC(2026, 9, 6, 12);
  const now = () => new Date(nowMs++);
  let sourceReads = 0;
  let sourceAvailable = true;
  const digest = async (bytes: Uint8Array) => (await bytesDigest(bytes)).slice("sha256:".length);
  const assetSource = {
    async read({ url }: { url: string }) {
      sourceReads += 1;
      if (!sourceAvailable) throw new Error("fixture source is unavailable");
      if (url === MANIFEST_URL) {
        const manifestBytes = new TextEncoder().encode(
          JSON.stringify({
            files: [
              {
                path: "index.html",
                url: FILE_URL,
                sha256: await digest(ASSET_BYTES),
                mediaType: "text/html",
              },
            ],
          }),
        );
        return manifestBytes;
      }
      if (url === FILE_URL) return ASSET_BYTES;
      throw new Error("unexpected fixture URL");
    },
  };
  const assetHost = createStaticAssetBundleHost({
    sql,
    source: assetSource,
    targetKey: TARGET_KEY,
  });
  const publicationState = createV2WorkerPublicationState({
    sql,
    now,
    assetCustody: assetHost.custody,
  });
  const ordinaryBackend: V2Backend = {
    id: "fixture-v2-worker-support-v1",
    targetKey: TARGET_KEY,
    async execute(input: V2Execution) {
      return {
        kind: "complete" as const,
        observed:
          input.form === WORKER_VERSION_FORM_URL
            ? { ready: true, resolvedBindings: true }
            : input.form === WORKER_ENDPOINT_FORM_URL
              ? { tlsReady: true, activeDeploymentRouteReady: true }
              : { ready: true },
        output: input.previousOutput,
      };
    },
    async reconcile(input: V2Execution) {
      return await this.execute(input);
    },
  };
  const form = (extra: Partial<V2Form> = {}): V2Form => ({
    validateCreate() {},
    validateUpdate() {},
    backend: ordinaryBackend,
    ...extra,
  });
  const forms = {
    [MODULE_WORKER_FORM_URL]: form(),
    [STATIC_ASSET_BUNDLE_FORM_URL]: assetHost.form,
    [WORKER_VERSION_FORM_URL]: form({
      references(spec) {
        return referencesForWorkerVersion(parseWorkerVersionSpec(spec));
      },
    }),
    [WORKER_ENDPOINT_FORM_URL]: form({
      references(spec) {
        return [
          {
            resourceUid: (spec.worker as { resourceUid: string }).resourceUid,
            formUrl: MODULE_WORKER_FORM_URL,
            readiness: "observed",
          },
        ];
      },
      initialOutput() {
        return { hostname: "static.example.test", url: "https://static.example.test/" };
      },
    }),
    [WORKER_DEPLOYMENT_FORM_URL]: form({
      references(spec) {
        const workerUid = (spec.worker as { resourceUid: string }).resourceUid;
        const versions = spec.versions as {
          workerVersion: { resourceUid: string };
        }[];
        return [
          { resourceUid: workerUid, formUrl: MODULE_WORKER_FORM_URL, readiness: "observed" },
          ...versions.map(({ workerVersion }) => ({
            resourceUid: workerVersion.resourceUid,
            formUrl: WORKER_VERSION_FORM_URL,
            readiness: "ready" as const,
            targetSpecMatch: { path: ["worker", "resourceUid"], equals: workerUid },
          })),
        ];
      },
    }),
  };
  const engine = createTakoformV2Engine({
    sql,
    now,
    replayWindowSeconds: 3600,
    leaseMilliseconds: 60_000,
    authorize: async () => true,
    forms,
  });
  const publication = createV2StaticWorkerPublication({
    targetKey: TARGET_KEY,
    publicationState,
    runtime,
  });
  const store = createV2Store(sql);

  return {
    root,
    db,
    sql,
    now,
    engine,
    store,
    assetHost,
    runtime,
    publication,
    sourceReads: () => sourceReads,
    disableSource() {
      sourceAvailable = false;
    },
    async create(formUrl: string, name: string, spec: JsonObject, settle = true) {
      const accepted = await engine.acceptCreate({
        principal: "org-static",
        key: `create-${name}-static-publication-key`,
        input: { form: formUrl, space: "production", name, spec },
      });
      if (settle) {
        const result = await engine.runNext();
        expect(result).toMatchObject({ id: accepted.id, status: "succeeded" });
      }
      return accepted;
    },
    async execution(operationId: string): Promise<V2Execution> {
      const op = await store.operation(operationId);
      if (!op) throw new Error("fixture operation missing");
      const resource = await store.resource(op.resource_uid);
      if (!resource) throw new Error("fixture resource missing");
      const token = `lease-${operationId}`;
      const time = now().getTime();
      expect(await store.claim(op.id, token, time, time + 60_000)).toBe(true);
      expect(await store.markDispatch(op.id, token, now().toISOString())).toBe(true);
      return {
        operationId: op.id,
        leaseToken: token,
        backendKey: op.backend_key,
        backendId: op.backend_id,
        targetKey: op.target_key,
        resourceUid: resource.uid,
        principal: op.principal,
        action: op.action,
        generation: op.generation,
        form: resource.form_url,
        space: resource.space,
        name: resource.name,
        spec: JSON.parse(op.accepted_spec_json),
        previousObserved: JSON.parse(resource.observed_json),
        previousOutput: JSON.parse(resource.output_json),
      };
    },
    close() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function fencedRuntime(initial: WorkerdPublicationIdentity | null = null) {
  let identity = initial;
  let publication: WorkerdDeploymentPublication<WorkerdStaticSite> | null = null;
  let publishCalls = 0;
  let observe: "factual" | "unknown" = "factual";
  let fenceCurrent = true;
  const runtime = {
    async publishFenced(
      _name: string,
      resolve: (
        current: WorkerdPublicationIdentity | null,
      ) => Promise<WorkerdDeploymentPublication<WorkerdStaticSite> | null>,
      isFenceCurrent: () => Promise<boolean>,
    ) {
      // Match WorkerdRuntime's actual ordering: both pre-resolution checks
      // happen before resolve(current), followed by a post-resolution check.
      if (
        !fenceCurrent ||
        !(await isFenceCurrent()) ||
        !fenceCurrent ||
        !(await isFenceCurrent())
      ) {
        throw new Error("stale fence");
      }
      const candidate = await resolve(identity);
      if (!fenceCurrent || !(await isFenceCurrent())) throw new Error("stale fence");
      if (
        candidate?.versions.some(
          (version) =>
            version.site.hostnames.length !== 0 ||
            version.site.workerResourceUid !== candidate.workerResourceUid ||
            version.site.generation !== candidate.generation,
        )
      ) {
        throw new Error("invalid private Worker Version variant");
      }
      publishCalls += 1;
      publication = candidate;
      identity = candidate
        ? {
            generation: candidate.generation,
            workerResourceUid: candidate.workerResourceUid,
            hostnames: [...candidate.hostnames].sort(),
            versions: candidate.versions
              .map(({ versionId, workerVersionUid, weight }) => ({
                versionId,
                workerVersionUid,
                weight,
              }))
              .sort((left, right) => left.workerVersionUid.localeCompare(right.workerVersionUid)),
          }
        : null;
    },
    async observeExactPublication(_name: string, expected: WorkerdPublicationIdentity | null) {
      if (observe === "unknown") return "unknown" as const;
      return JSON.stringify(identity) === JSON.stringify(expected)
        ? ("matches" as const)
        : ("different" as const);
    },
    setObserve(value: "factual" | "unknown") {
      observe = value;
    },
    setFenceCurrent(value: boolean) {
      fenceCurrent = value;
    },
    setCurrent(value: WorkerdPublicationIdentity | null) {
      identity = value;
    },
    get identity() {
      return identity;
    },
    get publication() {
      return publication;
    },
    get publishCalls() {
      return publishCalls;
    },
  };
  return runtime;
}

async function deploymentFixture(f: ReturnType<typeof setup>) {
  const worker = await f.create(MODULE_WORKER_FORM_URL, "worker", {});
  const assetDigest = await bytesDigest(
    new TextEncoder().encode(
      JSON.stringify({
        files: [
          {
            path: "index.html",
            url: FILE_URL,
            sha256: await bytesDigest(ASSET_BYTES).then((value) => value.slice(7)),
            mediaType: "text/html",
          },
        ],
      }),
    ),
  ).then((value) => value.slice(7));
  const asset = await f.create(STATIC_ASSET_BUNDLE_FORM_URL, "assets", {
    artifact: { url: MANIFEST_URL, sha256: assetDigest },
  });
  const version = await f.create(WORKER_VERSION_FORM_URL, "version", {
    worker: { resourceUid: worker.resourceUid },
    handlers: [],
    assets: {
      bundle: { resourceUid: asset.resourceUid },
      runWorkerFirst: false,
      notFoundHandling: "single_page_application",
    },
  });
  await f.create(WORKER_ENDPOINT_FORM_URL, "endpoint", {
    worker: { resourceUid: worker.resourceUid },
  });
  f.disableSource();
  const spec = {
    worker: { resourceUid: worker.resourceUid },
    versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
  };
  const deployment = await f.create(WORKER_DEPLOYMENT_FORM_URL, "deployment", spec, false);
  return { worker, asset, version, deployment, spec };
}

test("publishes accepted static Worker material through the fenced runtime and reconciles exact readback", async () => {
  const f = setup();
  try {
    const { worker, version, deployment } = await deploymentFixture(f);
    const readsBeforePublication = f.sourceReads();
    f.disableSource();
    const execution = await f.execution(deployment.id);
    const result = await f.publication.publish(execution);
    const runtime = f.runtime;

    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") throw new Error("fixture publication was not confirmed");
    expect(result.identity?.workerResourceUid).toBe(worker.resourceUid);
    expect(runtime.publishCalls).toBe(1);
    expect(runtime.publication?.workerResourceUid).toBe(worker.resourceUid);
    expect(runtime.publication?.hostnames).toEqual(["static.example.test"]);
    expect(runtime.publication?.generation).toBe(`takoserver-v2-operation:${deployment.id}`);
    expect(runtime.publication?.versions).toHaveLength(1);
    expect(runtime.publication?.versions[0]).toMatchObject({
      workerVersionUid: version.resourceUid,
      weight: 10_000,
      site: {
        kind: "static",
        workerResourceUid: worker.resourceUid,
        hostnames: [],
        assets: { runWorkerFirst: false, notFoundHandling: "single-page-application" },
      },
    });
    expect(runtime.publication?.versions[0]?.assets?.get("index.html")).toEqual(ASSET_BYTES);
    expect(f.sourceReads()).toBe(readsBeforePublication);

    const recovered = await f.publication.observe(execution);
    expect(recovered).toEqual(result);
    expect(runtime.publishCalls).toBe(1);
  } finally {
    f.close();
  }
});

test("keeps unknown serving state unknown and never republishes during reconciliation", async () => {
  const f = setup();
  try {
    const { deployment } = await deploymentFixture(f);
    const execution = await f.execution(deployment.id);
    const runtime = f.runtime;
    runtime.setObserve("unknown");

    expect(await f.publication.publish(execution)).toMatchObject({ kind: "unknown" });
    const writesAfterExecute = runtime.publishCalls;
    expect(await f.publication.observe(execution)).toMatchObject({ kind: "unknown" });
    expect(runtime.publishCalls).toBe(writesAfterExecute);
  } finally {
    f.close();
  }
});

test("stale pre-resolution fence prevents publication", async () => {
  const runtime = fencedRuntime();
  const f = setup(runtime);
  try {
    const { deployment } = await deploymentFixture(f);
    const execution = await f.execution(deployment.id);
    runtime.setFenceCurrent(false);

    expect(await f.publication.publish(execution)).toMatchObject({ kind: "unknown" });
    expect(runtime.publishCalls).toBe(0);
    expect(runtime.identity).toBeNull();
  } finally {
    f.close();
  }
});

test("replaces a same-Worker prior publication only after resolving its source Operation", async () => {
  const f = setup();
  try {
    const { worker, asset, version, deployment } = await deploymentFixture(f);
    const firstExecution = await f.execution(deployment.id);
    const first = await f.publication.publish(firstExecution);
    expect(first.kind).toBe("confirmed");
    if (first.kind !== "confirmed" || !first.identity) {
      throw new Error("fixture publication was not confirmed");
    }
    const settledAt = f.now().toISOString();
    expect(
      await f.store.settle({
        id: firstExecution.operationId,
        token: firstExecution.leaseToken,
        status: "succeeded",
        effect: "complete",
        at: settledAt,
        retainUntil: new Date(Date.parse(settledAt) + 60_000).toISOString(),
        observedJson: JSON.stringify({
          ready: true,
          active: true,
          selectedVersions: first.identity.versions.map(({ workerVersionUid, weight }) => ({
            resourceUid: workerVersionUid,
            weight,
          })),
        }),
        outputJson: "{}",
      }),
    ).toBe(true);

    const nextVersion = await f.create(WORKER_VERSION_FORM_URL, "version-next", {
      worker: { resourceUid: worker.resourceUid },
      handlers: [],
      assets: {
        bundle: { resourceUid: asset.resourceUid },
        runWorkerFirst: false,
        notFoundHandling: "single_page_application",
      },
    });
    const changedSpec = {
      worker: { resourceUid: worker.resourceUid },
      versions: [
        { workerVersion: { resourceUid: version.resourceUid }, weight: 5_000 },
        { workerVersion: { resourceUid: nextVersion.resourceUid }, weight: 5_000 },
      ],
    };
    const update = await f.engine.acceptUpdate({
      principal: "org-static",
      key: "update-deployment-static-publication-key",
      uid: deployment.resourceUid,
      expectedGeneration: 1,
      spec: changedSpec,
    });
    const updateExecution = await f.execution(update.id);
    const changed = await f.publication.publish(updateExecution);
    expect(changed.kind).toBe("confirmed");
    expect(f.runtime.publishCalls).toBe(2);
    expect(f.runtime.identity?.generation).toBe(`takoserver-v2-operation:${update.id}`);
    expect(
      f.runtime.identity?.versions
        .map(({ workerVersionUid, weight }) => ({
          workerVersionUid,
          weight,
        }))
        .sort((left, right) => left.workerVersionUid.localeCompare(right.workerVersionUid)),
    ).toEqual(
      [
        { workerVersionUid: version.resourceUid, weight: 5_000 },
        { workerVersionUid: nextVersion.resourceUid, weight: 5_000 },
      ].sort((left, right) => left.workerVersionUid.localeCompare(right.workerVersionUid)),
    );

    if (changed.kind !== "confirmed" || !changed.identity) {
      throw new Error("fixture update publication was not confirmed");
    }
    const updateSettledAt = f.now().toISOString();
    expect(
      await f.store.settle({
        id: updateExecution.operationId,
        token: updateExecution.leaseToken,
        status: "succeeded",
        effect: "complete",
        at: updateSettledAt,
        retainUntil: new Date(Date.parse(updateSettledAt) + 60_000).toISOString(),
        observedJson: JSON.stringify({
          ready: true,
          active: true,
          selectedVersions: changed.identity.versions.map(({ workerVersionUid, weight }) => ({
            resourceUid: workerVersionUid,
            weight,
          })),
        }),
        outputJson: "{}",
      }),
    ).toBe(true);

    const deletion = await f.engine.acceptDelete({
      principal: "org-static",
      key: "delete-deployment-static-publication-key",
      uid: deployment.resourceUid,
      expectedGeneration: 2,
    });
    const deleteExecution = await f.execution(deletion.id);
    const removed = await f.publication.publish(deleteExecution);
    expect(removed).toEqual({ kind: "confirmed", identity: null });
    expect(removed).not.toHaveProperty("observed");
    expect(removed).not.toHaveProperty("output");
    expect(f.runtime.publishCalls).toBe(3);
    expect(f.runtime.identity).toBeNull();
    expect(await f.publication.observe(deleteExecution)).toEqual(removed);
    expect(await f.store.operation(deletion.id)).toMatchObject({ status: "reconciling" });
    expect(f.runtime.publishCalls).toBe(3);
  } finally {
    f.close();
  }
});

test("does not republish when this Operation marker is present with a mismatched full identity", async () => {
  const runtime = fencedRuntime();
  const f = setup(runtime);
  try {
    const { worker, deployment } = await deploymentFixture(f);
    const execution = await f.execution(deployment.id);
    runtime.setCurrent({
      generation: `takoserver-v2-operation:${deployment.id}`,
      workerResourceUid: worker.resourceUid,
      hostnames: ["tampered.example.test"],
      versions: [
        { versionId: "v2-existing", workerVersionUid: "existing-version-uid", weight: 10_000 },
      ],
    });

    expect(await f.publication.publish(execution)).toMatchObject({ kind: "unknown" });
    expect(runtime.publishCalls).toBe(0);
  } finally {
    f.close();
  }
});

test("refuses malformed non-v2 incumbent markers without replacing the private publication", async () => {
  const runtime = fencedRuntime();
  const f = setup(runtime);
  try {
    const { worker, deployment } = await deploymentFixture(f);
    runtime.setCurrent({
      generation: "legacy-or-malformed-generation",
      workerResourceUid: worker.resourceUid,
      hostnames: [],
      versions: [
        { versionId: "legacy-version", workerVersionUid: "legacy-version-uid", weight: 10_000 },
      ],
    });
    const execution = await f.execution(deployment.id);
    expect(await f.publication.publish(execution)).toMatchObject({ kind: "unknown" });
    expect(runtime.publishCalls).toBe(0);
  } finally {
    f.close();
  }
});

test("refuses an incumbent publication belonging to another Worker UID", async () => {
  const runtime = fencedRuntime();
  const f = setup(runtime);
  try {
    const { deployment } = await deploymentFixture(f);
    const execution = await f.execution(deployment.id);
    runtime.setCurrent({
      generation: "takoserver-v2-operation:11111111-1111-4111-8111-111111111111",
      workerResourceUid: "foreign-worker-resource-uid",
      hostnames: [],
      versions: [
        { versionId: "v2-foreign", workerVersionUid: "foreign-version-uid", weight: 10_000 },
      ],
    });

    expect(await f.publication.publish(execution)).toMatchObject({ kind: "unknown" });
    expect(runtime.publishCalls).toBe(0);
  } finally {
    f.close();
  }
});
