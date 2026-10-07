import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { JsonObject } from "../src/ports.ts";
import { createSelfhostV2SQLiteStore } from "../src/providers/selfhost-v2-sqlite-store.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { SQLITE_DATABASE_FORM_URL } from "../src/takoform-v2/forms/sqlite-database.ts";
import { createSQLiteDatabaseForm } from "../src/takoform-v2/forms/sqlite-database-backend.ts";
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";
import { createWorkerBundleHost } from "../src/takoform-v2/forms/worker-bundle-backend.ts";
import {
  MODULE_WORKER_FORM_URL,
  parseModuleWorkerSpec,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import { createInternalV2CodeWorkerVersionForm } from "../src/takoform-v2/worker-lifecycle-backend.ts";
import { createV2WorkerPublicationState } from "../src/takoform-v2/worker-publication-state.ts";

const QUEUE_SPEC = {
  worker: { resourceUid: "worker-one" },
  bundle: { resourceUid: "bundle-one" },
  handlers: ["queue"],
};
const SQLITE_SPEC = {
  worker: { resourceUid: "worker-one" },
  bundle: { resourceUid: "bundle-one" },
  handlers: ["fetch"],
  sqliteBindings: [{ name: "DB", resource: { resourceUid: "sqlite-one" } }],
};

function form(
  options: {
    queueSettlement?: {
      readonly address: string;
      queueIdForUid(queueUid: string): string;
      bindingToken(input: {
        readonly workerUid: string;
        readonly versionId: string;
        readonly servingSourceOperationId: string;
      }): string;
    };
    v2SqliteBinding?: {
      readonly address: string;
      issueGrant(): string;
      resolveCurrentBinding(): Promise<null>;
    };
  } = {},
) {
  const db = new Database(":memory:");
  try {
    return {
      db,
      version: createInternalV2CodeWorkerVersionForm({
        sql: createSqliteSql(db),
        targetKey: "selfhost-test",
        publicationState: {
          resolveVersion: async () => ({
            kind: "unresolved",
            code: "graph_unresolved",
            message: "not used",
          }),
        },
        retirement: { observeRetired: async () => ({ kind: "unknown" }) },
        inspectModule: async () => ({ outcome: "valid", exportedHandlers: ["queue"] }),
        ...options,
      }),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

test("Queue WorkerVersion admission needs an operator-composed native settlement boot", () => {
  const absent = form();
  try {
    expect(() => absent.version.validateCreate(QUEUE_SPEC)).toThrow(
      expect.objectContaining({ code: "capability_required", status: 422 }),
    );
  } finally {
    absent.db.close();
  }

  const composed = form({
    queueSettlement: {
      address: "127.0.0.1:4999",
      queueIdForUid: (uid) => `v2-queue:${uid}`,
      bindingToken: () => "A".repeat(43),
    },
  });
  try {
    expect(() => composed.version.validateCreate(QUEUE_SPEC)).not.toThrow();
  } finally {
    composed.db.close();
  }
});

test("SQLite WorkerVersion admission still refuses without an operator-composed native binding port", () => {
  const absent = form();
  try {
    expect(() => absent.version.validateCreate(SQLITE_SPEC)).toThrow(
      expect.objectContaining({ code: "capability_required", status: 422 }),
    );
  } finally {
    absent.db.close();
  }
});

test("SQLite WorkerVersion admission accepts only a structurally complete local private binding port", () => {
  const composed = form({
    v2SqliteBinding: {
      address: "127.0.0.1:4998",
      issueGrant: () => "grant",
      resolveCurrentBinding: async () => null,
    },
  });
  try {
    expect(() => composed.version.validateCreate(SQLITE_SPEC)).not.toThrow();
  } finally {
    composed.db.close();
  }
});

test("Queue admission rejects a remote settlement address at composition", () => {
  expect(() =>
    form({
      queueSettlement: {
        address: "example.test:4999",
        queueIdForUid: (uid) => `v2-queue:${uid}`,
        bindingToken: () => "A".repeat(43),
      },
    }),
  ).toThrow(TypeError);
});

test("Queue WorkerVersion becomes eligible only from held code and its inspected queue export", async () => {
  const db = new Database(":memory:");
  try {
    migrateSqlite(db);
    const sql = createSqliteSql(db);
    const bytes = new TextEncoder().encode("export default { queue() {} };\n");
    const sha256 = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
    const manifestUrl = "https://artifacts.example.test/queue/manifest.json";
    const fileUrl = "https://artifacts.example.test/queue/index.mjs";
    const manifest = new TextEncoder().encode(
      JSON.stringify({
        entrypoint: "index.mjs",
        files: [
          {
            path: "index.mjs",
            url: fileUrl,
            sha256: sha256(bytes),
            mediaType: "application/javascript+module",
          },
        ],
      }),
    );
    let sourceAvailable = true;
    const bundle = createWorkerBundleHost({
      sql,
      targetKey: "selfhost-test",
      source: {
        async read({ url }) {
          if (!sourceAvailable) throw new Error("source removed");
          if (url === manifestUrl) return manifest;
          if (url === fileUrl) return bytes;
          throw new Error("unknown artifact");
        },
      },
    });
    const publicationState = createV2WorkerPublicationState({
      sql,
      bundleCustody: bundle.custody,
    });
    let inspected = 0;
    let exportedHandlers: ("fetch" | "queue")[] = ["queue"];
    const version = createInternalV2CodeWorkerVersionForm({
      sql,
      targetKey: "selfhost-test",
      publicationState,
      retirement: { observeRetired: async () => ({ kind: "unknown" }) },
      inspectModule: async (input) => {
        inspected += 1;
        expect(input.declaredHandlers).toEqual(["queue"]);
        expect(input.modules.map((module) => module.bytes)).toEqual([bytes]);
        return { outcome: "valid", exportedHandlers };
      },
      queueSettlement: {
        address: "127.0.0.1:4999",
        queueIdForUid: (uid) => `v2-queue:${uid}`,
        bindingToken: () => "A".repeat(43),
      },
    });
    const engine = createTakoformV2Engine({
      sql,
      now: () => new Date(),
      replayWindowSeconds: 3600,
      leaseMilliseconds: 60_000,
      authorize: async () => true,
      forms: {
        [MODULE_WORKER_FORM_URL]: {
          validateCreate: parseModuleWorkerSpec,
          validateUpdate: (_previous, next) => parseModuleWorkerSpec(next),
          backend: {
            id: "identity-fixture",
            targetKey: "selfhost-test",
            execute: async () => ({ kind: "complete", observed: {}, output: {} }),
            reconcile: async () => ({ kind: "unknown" }),
          },
        },
        [WORKER_BUNDLE_FORM_URL]: bundle.form,
        [WORKER_VERSION_FORM_URL]: version,
      },
    });
    const create = async (formUrl: string, name: string, spec: JsonObject) => {
      const accepted = await engine.acceptCreate({
        principal: "org:one",
        key: `create-${name}-operation-key`,
        input: { form: formUrl, space: "one", name, spec },
      });
      expect(await engine.runNext()).toMatchObject({
        id: accepted.id,
        status: "succeeded",
        effect: "complete",
      });
      return accepted;
    };
    const worker = await create(MODULE_WORKER_FORM_URL, "worker", {});
    const heldBundle = await create(WORKER_BUNDLE_FORM_URL, "bundle", {
      artifact: { url: manifestUrl, sha256: sha256(manifest) },
    });
    sourceAvailable = false;
    const selected = await create(WORKER_VERSION_FORM_URL, "queue-version", {
      worker: { resourceUid: worker.resourceUid },
      bundle: { resourceUid: heldBundle.resourceUid },
      handlers: ["queue"],
    });
    expect(inspected).toBe(1);
    expect(
      await engine.getResource({ principal: "org:one", uid: selected.resourceUid }),
    ).toMatchObject({
      observed: { ready: true, resolvedBindings: true, bundleVerified: true },
    });

    exportedHandlers = ["fetch"];
    const mismatch = await engine.acceptCreate({
      principal: "org:one",
      key: "create-queue-mismatch-operation-key",
      input: {
        form: WORKER_VERSION_FORM_URL,
        space: "one",
        name: "queue-mismatch",
        spec: {
          worker: { resourceUid: worker.resourceUid },
          bundle: { resourceUid: heldBundle.resourceUid },
          handlers: ["queue"],
        },
      },
    });
    expect(await engine.runNext()).toMatchObject({
      id: mismatch.id,
      status: "reconciling",
      effect: "unknown",
    });
    expect(inspected).toBe(2);
    expect(
      await engine.getResource({ principal: "org:one", uid: mismatch.resourceUid }),
    ).toMatchObject({
      observedGeneration: 0,
      observed: {},
    });

    await sql.run("DELETE FROM tf_v2_artifact_chunks WHERE resource_uid = ?", [
      heldBundle.resourceUid,
    ]);
    const damaged = await engine.acceptCreate({
      principal: "org:one",
      key: "create-queue-damaged-operation-key",
      input: {
        form: WORKER_VERSION_FORM_URL,
        space: "one",
        name: "queue-damaged",
        spec: {
          worker: { resourceUid: worker.resourceUid },
          bundle: { resourceUid: heldBundle.resourceUid },
          handlers: ["queue"],
        },
      },
    });
    expect(await engine.runNext()).toMatchObject({
      id: damaged.id,
      status: "reconciling",
      effect: "unknown",
    });
    expect(inspected).toBe(2);
  } finally {
    db.close();
  }
});

test("SQLite WorkerVersion eligibility requires the settled native UID and its current observed database", async () => {
  const root = mkdtempSync(join(tmpdir(), "v2-version-sqlite-"));
  const db = new Database(":memory:");
  try {
    migrateSqlite(db);
    const sql = createSqliteSql(db);
    const targetKey = "selfhost-test";
    const store = createSelfhostV2SQLiteStore({ root, sql, targetKey });
    const bytes = new TextEncoder().encode("export default { fetch() {} };\n");
    const sha256 = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
    const manifestUrl = "https://artifacts.example.test/sqlite/manifest.json";
    const fileUrl = "https://artifacts.example.test/sqlite/index.mjs";
    const manifest = new TextEncoder().encode(
      JSON.stringify({
        entrypoint: "index.mjs",
        files: [
          {
            path: "index.mjs",
            url: fileUrl,
            sha256: sha256(bytes),
            mediaType: "application/javascript+module",
          },
        ],
      }),
    );
    const bundle = createWorkerBundleHost({
      sql,
      targetKey,
      source: {
        async read({ url }) {
          if (url === manifestUrl) return manifest;
          if (url === fileUrl) return bytes;
          throw new Error("unknown artifact");
        },
      },
    });
    let inspected = 0;
    const version = createInternalV2CodeWorkerVersionForm({
      sql,
      targetKey,
      publicationState: createV2WorkerPublicationState({ sql, bundleCustody: bundle.custody }),
      retirement: { observeRetired: async () => ({ kind: "unknown" }) },
      inspectModule: async (input) => {
        inspected += 1;
        expect(input.modules.map((module) => module.bytes)).toEqual([bytes]);
        return { outcome: "valid", exportedHandlers: ["fetch"] };
      },
      v2SqliteBinding: {
        address: "127.0.0.1:4998",
        issueGrant: () => "grant",
        resolveCurrentBinding: async () => null,
      },
    });
    const engine = createTakoformV2Engine({
      sql,
      now: () => new Date(),
      replayWindowSeconds: 3600,
      leaseMilliseconds: 60_000,
      authorize: async () => true,
      forms: {
        [MODULE_WORKER_FORM_URL]: {
          validateCreate: parseModuleWorkerSpec,
          validateUpdate: (_previous, next) => parseModuleWorkerSpec(next),
          backend: {
            id: "identity-fixture",
            targetKey,
            execute: async () => ({ kind: "complete", observed: {}, output: {} }),
            reconcile: async () => ({ kind: "unknown" }),
          },
        },
        [WORKER_BUNDLE_FORM_URL]: bundle.form,
        [SQLITE_DATABASE_FORM_URL]: createSQLiteDatabaseForm({ store }),
        [WORKER_VERSION_FORM_URL]: version,
      },
    });
    const create = async (formUrl: string, name: string, spec: JsonObject) => {
      const accepted = await engine.acceptCreate({
        principal: "org:one",
        key: `create-${name}-operation-key`,
        input: { form: formUrl, space: "one", name, spec },
      });
      expect(await engine.runNext()).toMatchObject({
        id: accepted.id,
        status: "succeeded",
        effect: "complete",
      });
      return accepted;
    };
    const worker = await create(MODULE_WORKER_FORM_URL, "worker", {});
    const heldBundle = await create(WORKER_BUNDLE_FORM_URL, "bundle", {
      artifact: { url: manifestUrl, sha256: sha256(manifest) },
    });
    const database = await create(SQLITE_DATABASE_FORM_URL, "sqlite", {});
    expect(
      (await engine.getResource({ principal: "org:one", uid: database.resourceUid })).observed,
    ).toEqual({ databaseExists: true });
    const spec = {
      worker: { resourceUid: worker.resourceUid },
      bundle: { resourceUid: heldBundle.resourceUid },
      handlers: ["fetch"],
      sqliteBindings: [{ name: "DB", resource: { resourceUid: database.resourceUid } }],
    };
    const selected = await create(WORKER_VERSION_FORM_URL, "sqlite-version", spec);
    expect(inspected).toBe(1);
    expect(
      await engine.getResource({ principal: "org:one", uid: selected.resourceUid }),
    ).toMatchObject({ observed: { ready: true, resolvedBindings: true, bundleVerified: true } });

    // A settled UID row is not enough if its observed native resource vanished.
    await sql.run("UPDATE tf_v2_resources SET observed_json = ? WHERE uid = ?", [
      JSON.stringify({ databaseExists: false }),
      database.resourceUid,
    ]);
    const unavailable = await engine.acceptCreate({
      principal: "org:one",
      key: "create-sqlite-unavailable-operation-key",
      input: { form: WORKER_VERSION_FORM_URL, space: "one", name: "sqlite-unavailable", spec },
    });
    expect(await engine.runNext()).toMatchObject({
      id: unavailable.id,
      status: "reconciling",
      effect: "unknown",
    });
    expect(inspected).toBe(1);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
