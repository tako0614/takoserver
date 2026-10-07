import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import type { Sql } from "../src/ports.ts";
import { createSelfhostV2WorkerComposition } from "../src/selfhost-v2-worker-composition.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { referencesForWorkerDeployment } from "../src/takoform-v2/forms/worker-references.ts";
import {
  MODULE_WORKER_FORM_URL,
  parseModuleWorkerSpec,
  parseWorkerDeploymentSpec,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import { MODULE_WORKER_LIFECYCLE_BACKEND_ID } from "../src/takoform-v2/worker-lifecycle-backend.ts";
import type { WorkerdWorkerRuntimeOwner } from "../src/workerd-worker-runtime-owner.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "selfhost-v2-worker-suspend-"));
  const database = new Database(join(root, "control.sqlite"));
  migrateSqlite(database);
  const sql = createSqliteSql(database);
  const objects = createMemoryObjectStore();
  const clock = () => new Date();
  let ambiguousShutdownRead = false;
  const compositionSql: Sql = {
    ...sql,
    async query(statement, params) {
      const rows = await sql.query(statement, params);
      if (
        ambiguousShutdownRead &&
        statement.includes("FROM tf_v2_resources r LEFT JOIN tf_v2_operations op")
      ) {
        return rows.map((row) => ({ ...row, operation_status: "running" }));
      }
      return rows;
    },
  };
  const composition = createSelfhostV2WorkerComposition({
    sql: compositionSql,
    objects,
    clock,
    config: {
      cursorSigningKey: new Uint8Array(32).fill(0x52),
      documentation: "https://docs.example.test/v2",
      authenticationDocumentation: "https://docs.example.test/v2/authentication",
    },
    rootDirectory: join(root, "v2-worker-owners"),
    targetKey: "selfhost-v2-worker-primary",
    workerdBinary: null,
  });
  const engine = createTakoformV2Engine({
    sql,
    now: clock,
    replayWindowSeconds: 3600,
    authorize: async () => true,
    forms: {
      [MODULE_WORKER_FORM_URL]: {
        validateCreate: parseModuleWorkerSpec,
        validateUpdate: (_previous, next) => {
          parseModuleWorkerSpec(next);
        },
        backend: backend(MODULE_WORKER_LIFECYCLE_BACKEND_ID),
      },
      [WORKER_VERSION_FORM_URL]: {
        validateCreate: () => undefined,
        validateUpdate: () => undefined,
        references: (spec) => {
          const workerUid = (spec.worker as Record<string, unknown> | undefined)?.resourceUid;
          if (typeof workerUid !== "string") throw new TypeError("test Version Worker is missing");
          return [
            { resourceUid: workerUid, formUrl: MODULE_WORKER_FORM_URL, readiness: "observed" },
          ];
        },
        backend: backend("test-v2-version"),
      },
      [WORKER_DEPLOYMENT_FORM_URL]: {
        validateCreate: parseWorkerDeploymentSpec,
        validateUpdate: (_previous, next) => {
          parseWorkerDeploymentSpec(next);
        },
        references: (spec) => referencesForWorkerDeployment(parseWorkerDeploymentSpec(spec)),
        backend: backend("test-v2-deployment"),
      },
    },
  });
  return {
    root,
    database,
    sql,
    composition,
    engine,
    makeShutdownReadAmbiguous() {
      ambiguousShutdownRead = true;
    },
  };
}

function backend(id: string) {
  return {
    id,
    targetKey: "selfhost-v2-worker-primary",
    async execute(input: { form: string; spec: Record<string, unknown> }) {
      if (input.form === WORKER_VERSION_FORM_URL) {
        return {
          kind: "complete" as const,
          observed: { ready: true, resolvedBindings: true },
          output: {},
        };
      }
      if (input.form === WORKER_DEPLOYMENT_FORM_URL) {
        const spec = parseWorkerDeploymentSpec(input.spec);
        return {
          kind: "complete" as const,
          observed: {
            ready: true,
            active: true,
            selectedVersions: spec.versions.map(({ workerVersion, weight }) => ({
              resourceUid: workerVersion.resourceUid,
              weight,
            })),
          },
          output: {},
        };
      }
      return { kind: "complete" as const, observed: { ready: false }, output: {} };
    },
    async reconcile() {
      return { kind: "unknown" as const };
    },
  };
}

test("composition releases a Worker owner only for its exact terminal DELETE", async () => {
  const f = await fixture();
  try {
    expect(await f.composition.restoreOwners()).toEqual([]);
    const created = await f.engine.acceptCreate({
      principal: "org-fixture",
      key: "create-worker-key-0001",
      input: { form: MODULE_WORKER_FORM_URL, space: "prod", name: "worker", spec: {} },
    });
    expect(await f.engine.runNext()).toMatchObject({ id: created.id, status: "succeeded" });
    await f.composition.ownerForWorkerUid(created.resourceUid);

    const deleted = await f.engine.acceptDelete({
      principal: "org-fixture",
      key: "delete-worker-key-0001",
      uid: created.resourceUid,
      expectedGeneration: 1,
    });
    expect(await f.engine.runNext()).toMatchObject({ id: deleted.id, status: "succeeded" });

    const first = f.composition.suspendOwnersRetainingCustody();
    const duplicate = f.composition.suspendOwnersRetainingCustody();
    expect(duplicate).toBe(first);
    await Promise.all([first, duplicate]);
    await f.composition.closePrivateBindingServices();
  } finally {
    f.database.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("composition closes a live Worker owner only after SQL proves no serving Deployment", async () => {
  const f = await fixture();
  try {
    expect(await f.composition.restoreOwners()).toEqual([]);
    const created = await f.engine.acceptCreate({
      principal: "org-fixture",
      key: "create-unpublished-worker-key",
      input: { form: MODULE_WORKER_FORM_URL, space: "prod", name: "worker", spec: {} },
    });
    expect(await f.engine.runNext()).toMatchObject({ id: created.id, status: "succeeded" });
    await f.composition.ownerForWorkerUid(created.resourceUid);

    await f.composition.suspendOwnersRetainingCustody();
    await f.composition.closePrivateBindingServices();
  } finally {
    f.database.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("composition refuses to close an owner while SQL still has an active Deployment", async () => {
  const f = await fixture();
  let openedOwner: WorkerdWorkerRuntimeOwner | undefined;
  try {
    expect(await f.composition.restoreOwners()).toEqual([]);
    const worker = await f.engine.acceptCreate({
      principal: "org-fixture",
      key: "create-active-worker-key",
      input: { form: MODULE_WORKER_FORM_URL, space: "prod", name: "worker", spec: {} },
    });
    expect(await f.engine.runNext()).toMatchObject({ id: worker.id, status: "succeeded" });
    const version = await f.engine.acceptCreate({
      principal: "org-fixture",
      key: "create-active-version-key",
      input: {
        form: WORKER_VERSION_FORM_URL,
        space: "prod",
        name: "version",
        spec: { worker: { resourceUid: worker.resourceUid }, handlers: [] },
      },
    });
    expect(await f.engine.runNext()).toMatchObject({ id: version.id, status: "succeeded" });
    const deployment = await f.engine.acceptCreate({
      principal: "org-fixture",
      key: "create-active-deployment-key",
      input: {
        form: WORKER_DEPLOYMENT_FORM_URL,
        space: "prod",
        name: "deployment",
        spec: {
          worker: { resourceUid: worker.resourceUid },
          versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
        },
      },
    });
    expect(await f.engine.runNext()).toMatchObject({ id: deployment.id, status: "succeeded" });
    openedOwner = await f.composition.ownerForWorkerUid(worker.resourceUid);

    await expect(f.composition.suspendOwnersRetainingCustody()).rejects.toThrow(
      "v2 Worker serving state is uncertain during shutdown",
    );
  } finally {
    // The expected shutdown refusal must not leave an owner lock behind. This
    // path closes only after the owner itself proves no child/custody remains.
    if (openedOwner) await openedOwner.close();
    await f.composition.closePrivateBindingServices();
    f.database.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("composition refuses to stop services when current Worker SQL is ambiguous", async () => {
  const f = await fixture();
  let openedOwner: WorkerdWorkerRuntimeOwner | undefined;
  try {
    expect(await f.composition.restoreOwners()).toEqual([]);
    const created = await f.engine.acceptCreate({
      principal: "org-fixture",
      key: "create-ambiguous-worker-key",
      input: { form: MODULE_WORKER_FORM_URL, space: "prod", name: "worker", spec: {} },
    });
    expect(await f.engine.runNext()).toMatchObject({ id: created.id, status: "succeeded" });
    openedOwner = await f.composition.ownerForWorkerUid(created.resourceUid);
    f.makeShutdownReadAmbiguous();

    await expect(f.composition.suspendOwnersRetainingCustody()).rejects.toThrow(
      "v2 Worker SQL state is not settled for shutdown",
    );
  } finally {
    // The ambiguous SQL answer refuses coordinated shutdown, but the opened
    // empty owner can still independently prove retirement-only closure.
    if (openedOwner) await openedOwner.close();
    await f.composition.closePrivateBindingServices();
    f.database.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
