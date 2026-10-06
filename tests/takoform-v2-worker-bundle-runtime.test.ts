import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { bytesDigest } from "../src/json.ts";
import type { Sql } from "../src/ports.ts";
import type {
  WorkerModuleInspectionInput,
  WorkerModuleInspectionResult,
} from "../src/providers/worker-module-semantic-inspection.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import type { V2ArtifactSource } from "../src/takoform-v2/forms/artifact-source.ts";
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";
import { createWorkerBundleHost } from "../src/takoform-v2/forms/worker-bundle-backend.ts";
import {
  MODULE_WORKER_FORM_URL,
  parseModuleWorkerSpec,
  parseWorkerVersionSpec,
  validateModuleWorkerUpdate,
  validateWorkerVersionUpdate,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import type { V2Execution, V2Form } from "../src/takoform-v2/types.ts";
import { createV2WorkerBundleRuntime } from "../src/takoform-v2/worker-bundle-runtime.ts";
import { compileWorkerdVersionGraph } from "../src/workerd-version-graph.ts";
import { createWorkerdWorkerModuleInspector } from "../src/workerd-worker-module-inspector.ts";
import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";

const MANIFEST_URL = "https://artifacts.example.test/bundle/manifest.json";
const MODULE_URL = "https://artifacts.example.test/bundle/src/index.mjs";
const MESSAGE_URL = "https://artifacts.example.test/bundle/message.txt";
const MODULE_PATH = "src/index.mjs";
const MESSAGE_PATH = "message.txt";
const MODULE_BYTES = new TextEncoder().encode(
  'import message from "../message.txt";\nexport default { fetch() { return new Response(message); } };\n',
);
const MESSAGE_BYTES = new TextEncoder().encode("bundle bytes from verified custody");

interface Probe {
  inspectionInput?: WorkerModuleInspectionInput;
  inspection?: WorkerModuleInspectionResult;
  compiledGraph?: ReturnType<typeof compileWorkerdVersionGraph>;
  runtimeError?: unknown;
  execution?: V2Execution;
  mutateExecution?: (execution: V2Execution) => V2Execution;
  pauseChunkRead?: {
    armed: boolean;
    readonly entered: () => void;
    readonly resume: Promise<void>;
  };
}

function complete() {
  return { kind: "complete" as const, observed: { ready: true }, output: {} };
}

async function fixture(input: {
  readonly probe: Probe;
  readonly inspectModule?: (
    moduleInput: WorkerModuleInspectionInput,
  ) => Promise<WorkerModuleInspectionResult>;
  readonly afterAccept?: (options: {
    readonly db: Database;
    readonly bundleUid: string;
    readonly operation: { readonly id: string };
  }) => void;
}): Promise<void> {
  const db = new Database(":memory:");
  try {
    for (const name of [
      "0070_takoform_v2.sql",
      "0071_v2_sqlite_migration_set_custody.sql",
      "0072_v2_artifact_custody.sql",
      "0073_v2_reference_acceptance.sql",
    ]) {
      db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    }
    const baseSql = createSqliteSql(db);
    const sql: Sql = {
      async query(statement, params) {
        const pause = input.probe.pauseChunkRead;
        if (pause?.armed && statement.includes("SELECT chunk_index, bytes")) {
          pause.armed = false;
          pause.entered();
          await pause.resume;
        }
        return await baseSql.query(statement, params);
      },
      async run(statement, params) {
        return await baseSql.run(statement, params);
      },
      async batch(statements) {
        return await baseSql.batch(statements);
      },
    };
    const moduleSha256 = (await bytesDigest(MODULE_BYTES)).slice(7);
    const messageSha256 = (await bytesDigest(MESSAGE_BYTES)).slice(7);
    const manifestBytes = new TextEncoder().encode(
      JSON.stringify({
        entrypoint: MODULE_PATH,
        files: [
          {
            path: MODULE_PATH,
            url: MODULE_URL,
            sha256: moduleSha256,
            mediaType: "application/javascript+module",
          },
          {
            path: MESSAGE_PATH,
            url: MESSAGE_URL,
            sha256: messageSha256,
            mediaType: "text/plain",
          },
        ],
      }),
    );
    const manifestSha256 = (await bytesDigest(manifestBytes)).slice(7);
    const blobs = new Map<string, Uint8Array>([
      [MANIFEST_URL, manifestBytes],
      [MODULE_URL, MODULE_BYTES],
      [MESSAGE_URL, MESSAGE_BYTES],
    ]);
    const source: V2ArtifactSource = {
      async read({ url, sha256, maxBytes }) {
        const bytes = blobs.get(url);
        if (
          !bytes ||
          bytes.byteLength > maxBytes ||
          (await bytesDigest(bytes)) !== `sha256:${sha256}`
        ) {
          throw new Error("source unavailable");
        }
        return bytes;
      },
    };
    const { custody, form: bundleForm } = createWorkerBundleHost({
      sql,
      source,
      targetKey: "runtime-test-worker-bundle",
    });
    const runtime = createV2WorkerBundleRuntime({
      custody,
      inspectModule:
        input.inspectModule ??
        (async () => ({
          outcome: "valid",
          exportedHandlers: ["fetch"],
        })),
    });
    const moduleWorkerForm: V2Form = {
      validateCreate(spec) {
        parseModuleWorkerSpec(spec);
      },
      validateUpdate(previous, spec) {
        validateModuleWorkerUpdate(previous, spec);
      },
      backend: {
        id: "runtime-test-module-worker",
        targetKey: "runtime-test-module-worker-target",
        async execute() {
          return complete();
        },
        async reconcile() {
          return complete();
        },
      },
    };
    const versionForm: V2Form = {
      validateCreate(spec) {
        parseWorkerVersionSpec(spec);
      },
      validateUpdate(previous, spec) {
        validateWorkerVersionUpdate(previous, spec);
      },
      references(spec) {
        const parsed = parseWorkerVersionSpec(spec);
        if (!parsed.bundle) throw new Error("bundle is required by this runtime fixture");
        return [
          {
            resourceUid: parsed.worker.resourceUid,
            formUrl: MODULE_WORKER_FORM_URL,
            readiness: "observed",
          },
          {
            resourceUid: parsed.bundle.resourceUid,
            formUrl: WORKER_BUNDLE_FORM_URL,
            readiness: "observed",
          },
        ];
      },
      backend: {
        id: "runtime-test-worker-version",
        targetKey: "runtime-test-worker-version-target",
        async execute(execution) {
          input.probe.execution = execution;
          try {
            const readExecution = input.probe.mutateExecution?.(execution) ?? execution;
            const projected = await runtime.inspectVersion(readExecution);
            input.probe.inspectionInput = projected.inspectionInput;
            input.probe.inspection = projected.inspection;
            input.probe.compiledGraph = compileWorkerdVersionGraph({
              directory: "runtime-test-version",
              ...projected.graphInputs,
              environment: [],
              serviceBindings: [],
              hostnames: ["runtime-test.example.test"],
              declaredHandlers: parseWorkerVersionSpec(execution.spec).handlers,
              readiness: {
                publication: "runtime-test-publication",
                probeHostname: "runtime-test.example.test",
              },
            });
            return complete();
          } catch (error) {
            input.probe.runtimeError = error;
            return { kind: "no_effect", code: "bundle_unavailable", message: "Bundle unavailable" };
          }
        },
        async reconcile(execution) {
          return await this.execute(execution);
        },
      },
    };
    const engine = createTakoformV2Engine({
      sql,
      replayWindowSeconds: 3600,
      authorize: async (principal, space) => principal === "alice" && space === "runtime-test",
      forms: {
        [MODULE_WORKER_FORM_URL]: moduleWorkerForm,
        [WORKER_BUNDLE_FORM_URL]: bundleForm,
        [WORKER_VERSION_FORM_URL]: versionForm,
      },
    });
    const bundle = await engine.acceptCreate({
      principal: "alice",
      key: "runtime-test-bundle-create-0001",
      input: {
        form: WORKER_BUNDLE_FORM_URL,
        space: "runtime-test",
        name: "bundle",
        spec: { artifact: { url: MANIFEST_URL, sha256: manifestSha256 } },
      },
    });
    expect(await engine.runNext()).toMatchObject({ id: bundle.id, status: "succeeded" });
    blobs.clear();
    const moduleWorker = await engine.acceptCreate({
      principal: "alice",
      key: "runtime-test-module-worker-create-0001",
      input: {
        form: MODULE_WORKER_FORM_URL,
        space: "runtime-test",
        name: "module-worker",
        spec: {},
      },
    });
    expect(await engine.runNext()).toMatchObject({ id: moduleWorker.id, status: "succeeded" });
    const workerVersion = await engine.acceptCreate({
      principal: "alice",
      key: "runtime-test-version-create-0001",
      input: {
        form: WORKER_VERSION_FORM_URL,
        space: "runtime-test",
        name: "worker-version",
        spec: {
          worker: { resourceUid: moduleWorker.resourceUid },
          bundle: { resourceUid: bundle.resourceUid },
          handlers: ["fetch"],
        },
      },
    });
    input.afterAccept?.({ db, bundleUid: bundle.resourceUid, operation: workerVersion });
    expect(await engine.runNext()).toMatchObject({ id: workerVersion.id });
  } finally {
    db.close();
  }
}

test("an accepted WorkerVersion projects only exact verified custody bytes to inspection", async () => {
  const probe: Probe = {};
  await fixture({ probe });
  expect(probe.runtimeError).toBeUndefined();
  expect(probe.inspectionInput).toMatchObject({
    mainModule: MODULE_PATH,
    declaredHandlers: ["fetch"],
    modules: [
      {
        name: MODULE_PATH,
        digest: `sha256:${await bytesDigest(MODULE_BYTES).then((value) => value.slice(7))}`,
        mediaType: "application/javascript+module",
        bytes: MODULE_BYTES,
      },
      {
        name: MESSAGE_PATH,
        digest: `sha256:${await bytesDigest(MESSAGE_BYTES).then((value) => value.slice(7))}`,
        mediaType: "text/plain",
        bytes: MESSAGE_BYTES,
      },
    ],
  });
  expect(probe.compiledGraph?.site).toMatchObject({
    mainModule: MODULE_PATH,
    moduleMediaTypes: {
      [MODULE_PATH]: "application/javascript+module",
      [MESSAGE_PATH]: "text/plain",
    },
  });
  expect([...(probe.compiledGraph?.modules ?? new Map()).entries()]).toMatchObject([
    [MODULE_PATH, MODULE_BYTES],
    [MESSAGE_PATH, MESSAGE_BYTES],
  ]);
});

const nativeWorkerd = nativeEvidenceBinary("workerd-artifact") ?? null;
test.skipIf(nativeWorkerd === null)(
  "actual workerd inspector accepts modules read from verified v2 bundle custody",
  async () => {
    const probe: Probe = {};
    const inspector = createWorkerdWorkerModuleInspector({
      repositoryRoot: resolve(import.meta.dir, ".."),
      binary: nativeWorkerd,
    });
    await fixture({ probe, inspectModule: (moduleInput) => inspector.inspect(moduleInput) });
    expect(probe.inspection).toMatchObject({
      outcome: "valid",
      exportedHandlers: ["fetch"],
    });
  },
);

test("a stale consumer lease cannot read a referenced bundle", async () => {
  const probe: Probe = {
    mutateExecution: (execution) => ({ ...execution, leaseToken: "stale-lease-token-000000" }),
  };
  await fixture({ probe });
  expect(probe.runtimeError).toBeDefined();
  expect(probe.inspectionInput).toBeUndefined();
});

test("a forged principal cannot read another owner's referenced bundle", async () => {
  const probe: Probe = {
    mutateExecution: (execution) => ({ ...execution, principal: "mallory" }),
  };
  await fixture({ probe });
  expect(probe.runtimeError).toBeDefined();
  expect(probe.inspectionInput).toBeUndefined();
});

test("a lease takeover while held bytes are being read fences the old reader before projection", async () => {
  let markReadEntered = () => {};
  let resumeRead = () => {};
  const readEntered = new Promise<void>((resolve) => {
    markReadEntered = resolve;
  });
  const readGate = new Promise<void>((resolve) => {
    resumeRead = resolve;
  });
  const probe: Probe = {
    pauseChunkRead: {
      armed: false,
      entered: () => markReadEntered(),
      resume: readGate,
    },
  };
  await fixture({
    probe,
    afterAccept({ db, operation }) {
      const pause = probe.pauseChunkRead;
      if (!pause) throw new Error("read pause fixture missing");
      pause.armed = true;
      void readEntered.then(() => {
        db.query("UPDATE tf_v2_operations SET lease_token = ? WHERE id = ?").run(
          "replacement-lease-token-0001",
          operation.id,
        );
        resumeRead();
      });
    },
  });
  expect(probe.runtimeError).toBeDefined();
  expect(probe.inspectionInput).toBeUndefined();
});

test("unverified bundle custody is denied even when the accepted reference still exists", async () => {
  const probe: Probe = {};
  await fixture({
    probe,
    afterAccept({ db }) {
      db.exec("DROP TRIGGER tf_v2_artifact_owner_update_guard");
      db.exec(
        `UPDATE tf_v2_artifact_owners SET state = 'staging', observation_json = NULL,
          verified_operation_id = NULL, verified_lease_token = NULL`,
      );
    },
  });
  expect(probe.runtimeError).toBeDefined();
  expect(probe.inspectionInput).toBeUndefined();
});

test("damaged held bytes are denied rather than projected", async () => {
  const probe: Probe = {};
  await fixture({
    probe,
    afterAccept({ db }) {
      db.exec("DELETE FROM tf_v2_artifact_chunks WHERE file_index = 1");
    },
  });
  expect(probe.runtimeError).toBeDefined();
  expect(probe.inspectionInput).toBeUndefined();
});
