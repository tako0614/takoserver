import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import * as selfhost from "@takoserver/core/provider-extension/selfhost";
import {
  createSelfhostV2SQLiteStore,
  createSelfhostV2SqliteBindingBroker,
  createSelfhostV2SqliteQueueBindingBroker,
  createWorkerdWorkerModuleInspector,
  SELFHOST_DATA_PLANE_CONTENT_TYPE,
  SELFHOST_DATA_PLANE_PROTOCOL,
  SELFHOST_DATA_PLANE_SQL_PATH,
  type SelfhostV2SQLiteStore,
  SelfhostV2SQLiteStoreError,
  type SQLiteNativeExecution,
  type SQLiteStoreProofPort,
  type V2SqliteBindingBrokerOptions,
  type V2SqliteBindingGrant,
  type V2SqliteInvocationAuthority,
  type V2SqliteSelectedVersionObservation,
  type WorkerdWorkerModuleInspectorOptions,
} from "@takoserver/core/provider-extension/selfhost";
import * as portableV2 from "@takoserver/core/takoform-v2";
import { createWorkerdWorkerModuleInspector as existingWorkerdInspector } from "../src/workerd-worker-module-inspector.ts";

test("Node selfhost extension exposes the existing SQLite store and guarded broker through one subpath", () => {
  expect(Object.keys(selfhost).sort()).toEqual(
    [
      "DockerHttpRevisionError",
      "SelfhostContainerError",
      "SelfhostV2SQLiteStoreError",
      "SELFHOST_DATA_PLANE_CONTENT_TYPE",
      "SELFHOST_DATA_PLANE_PROTOCOL",
      "SELFHOST_DATA_PLANE_SQL_PATH",
      "createDockerHttpRevisionRuntime",
      "createSelfhostContainerRuntime",
      "createSelfhostV2SQLiteStore",
      "createSelfhostV2SqliteBindingBroker",
      "createSelfhostV2SqliteQueueBindingBroker",
      "createWorkerdWorkerModuleInspector",
    ].sort(),
  );
  expect(createWorkerdWorkerModuleInspector).toBe(existingWorkerdInspector);
  expect(selfhost.createSelfhostV2SQLiteStore).toBe(createSelfhostV2SQLiteStore);
  expect(selfhost.createSelfhostV2SqliteBindingBroker).toBe(createSelfhostV2SqliteBindingBroker);
  expect(selfhost.createSelfhostV2SqliteQueueBindingBroker).toBe(
    createSelfhostV2SqliteQueueBindingBroker,
  );
  expect(new SelfhostV2SQLiteStoreError("busy")).toMatchObject({ code: "busy" });
  expect(SELFHOST_DATA_PLANE_PROTOCOL).toBe("takoserver.selfhost-data@v1");
  expect(SELFHOST_DATA_PLANE_SQL_PATH).toBe("/.well-known/takoserver/selfhost-data/v1/sql");
  expect(SELFHOST_DATA_PLANE_CONTENT_TYPE).toBe("application/vnd.takoserver.selfhost-data.v1+json");

  const grant = {
    principal: "org:owner",
    space: "space",
    targetKey: "target",
    workerUid: "worker",
    workerVersionUid: "version",
    nativeVersionId: "native",
    incarnationId: "incarnation",
    servingSourceOperationId: "serving",
    bindings: [{ name: "DB", resourceUid: "database" }],
  } satisfies V2SqliteBindingGrant;
  const observation = {
    kind: "confirmed",
    workerUid: grant.workerUid,
    versionId: grant.nativeVersionId,
    incarnationId: grant.incarnationId,
    servingSourceOperationId: grant.servingSourceOperationId,
    status: "active",
  } satisfies V2SqliteSelectedVersionObservation;
  const options = {
    store: null as unknown as SelfhostV2SQLiteStore,
    stagingRoot: "/operator/private/sql-input",
    signingKey: new Uint8Array(32),
    async observeVersionTarget() {
      return observation;
    },
    async graphStillCurrent() {
      return false;
    },
    async resolveCurrentBinding() {
      return null;
    },
  } satisfies V2SqliteBindingBrokerOptions;
  expect(options.observeVersionTarget).toBeFunction();
  const inspectorOptions: WorkerdWorkerModuleInspectorOptions = { binary: null };
  expect(inspectorOptions.binary).toBeNull();
  expect(grant.bindings).toHaveLength(1);
  const proofs: SQLiteStoreProofPort = {
    async currentClaim(_input: SQLiteNativeExecution) {
      return null;
    },
    async acceptedCreate() {
      return null;
    },
  };
  const invocationAuthority: V2SqliteInvocationAuthority = {
    async read() {
      return null;
    },
    async readSelectedBindings() {
      return null;
    },
    async confirmSQLiteDrained() {
      return false;
    },
  };
  expect(proofs.currentClaim).toBeFunction();
  expect(invocationAuthority.readSelectedBindings).toBeFunction();
  expect(invocationAuthority.confirmSQLiteDrained).toBeFunction();
  for (const name of [
    "createSelfhostV2SQLiteStore",
    "SelfhostV2SQLiteStoreError",
    "createSelfhostV2SqliteBindingBroker",
    "createWorkerdWorkerModuleInspector",
    "SELFHOST_DATA_PLANE_SQL_PATH",
  ]) {
    expect(name in portableV2).toBe(false);
  }
});

test("Node SQLite extension imports stay outside the portable v2 browser closure", async () => {
  const nodeEntry = fileURLToPath(
    import.meta.resolve("@takoserver/core/provider-extension/selfhost"),
  );
  const nodeBundle = await Bun.build({
    entrypoints: [nodeEntry],
    target: "bun",
    format: "esm",
    minify: true,
    sourcemap: "none",
  });
  if (!nodeBundle.success) throw new Error(nodeBundle.logs.map(String).join("\n"));
  expect(nodeBundle.outputs).toHaveLength(1);
  expect(await nodeBundle.outputs[0]?.text()).toContain("node:sqlite");

  const portableEntry = fileURLToPath(import.meta.resolve("@takoserver/core/takoform-v2"));
  const browserBundle = await Bun.build({
    entrypoints: [portableEntry],
    target: "browser",
    format: "esm",
    minify: true,
    sourcemap: "none",
    plugins: [
      {
        name: "reject-node-imports",
        setup(build) {
          build.onResolve({ filter: /^(?:bun|node):/u }, (args) => {
            throw new Error(`portable v2 reached Node import: ${args.path}`);
          });
        },
      },
    ],
  });
  if (!browserBundle.success) throw new Error(browserBundle.logs.map(String).join("\n"));
  expect(browserBundle.outputs).toHaveLength(1);
  const portableSource = await browserBundle.outputs[0]?.text();
  expect(portableSource).not.toMatch(/\bnode:|\bDatabaseSync\b|\bcreateSelfhostV2SQLiteStore\b/u);
});
