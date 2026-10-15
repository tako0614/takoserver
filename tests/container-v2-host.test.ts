import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CONTAINER_CONTRACT as C } from "../src/container-contract.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createContainerBindingAuthority } from "../src/takoform-v2/container-binding-authority.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { createContainerDockerForm } from "../src/takoform-v2/forms/container-backend.ts";
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";
import {
  parseContainerWorkerVersionSpec,
  referencesForContainerWorkerVersion,
} from "../src/takoform-v2/forms/worker-container-specs.ts";
import { MODULE_WORKER_FORM_URL } from "../src/takoform-v2/forms/worker-specs.ts";
import type { V2Form } from "../src/takoform-v2/types.ts";

const F = C.fields;
test("candidate v2 Host validates before effects, pins authorized references and protects deletion", async () => {
  const database = new Database(":memory:");
  for (const name of [
    "0070_takoform_v2.sql",
    "0071_v2_sqlite_migration_set_custody.sql",
    "0072_v2_artifact_custody.sql",
    "0073_v2_reference_acceptance.sql",
    "0075_v2_artifact_progress.sql",
    "0081_v2_private_inputs.sql",
  ])
    database.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  const sql = createSqliteSql(database);
  const targetKey = "local-candidate";
  let effects = 0;
  const form = createContainerDockerForm({
    targetKey,
    capacityProfile: {
      id: "selfhost.container.http.standard",
      memoryBytes: 268435456,
      nanoCpus: 500000000,
      pidsLimit: 128,
    },
    runtime: {
      async reconcile(revision) {
        effects++;
        return {
          state: "ready",
          desiredGeneration: revision.generation,
          servingGeneration: revision.generation,
          retiringGenerations: [],
        };
      },
      async remove() {
        effects++;
        return { state: "deleted", desiredGeneration: 1, retiringGenerations: [] };
      },
    },
  });
  const fixtureForm: V2Form = {
    validateCreate() {},
    validateUpdate() {},
    backend: {
      id: "candidate-fixture",
      targetKey,
      async execute() {
        return { kind: "complete", observed: { [F.ready]: true }, output: {} };
      },
      async reconcile() {
        return { kind: "unknown" };
      },
    },
  };
  const workerVersion: V2Form = {
    ...fixtureForm,
    validateCreate(spec) {
      parseContainerWorkerVersionSpec(spec);
    },
    references(spec) {
      return referencesForContainerWorkerVersion(parseContainerWorkerVersionSpec(spec));
    },
  };
  const authorize = async (principal: string, space: string) =>
    principal === "alice" && space === "default";
  const forms = {
    [C.formUrl]: form,
    [C.workerVersionUrl]: workerVersion,
    [MODULE_WORKER_FORM_URL]: fixtureForm,
    [WORKER_BUNDLE_FORM_URL]: fixtureForm,
  };
  const engine = createTakoformV2Engine({ sql, forms, authorize, replayWindowSeconds: 3600 });
  const spec = {
    [F.image]: `registry.example/app@sha256:${"a".repeat(64)}`,
    [F.httpPort]: 8080,
    [F.healthPath]: "/health",
    [F.workloadRevision]: "v1",
  };
  try {
    for (const patch of [
      { [F.requiredSensitiveVars]: ["TOKEN"] },
      { [F.outboundInternet]: true },
      { unknown: 1 },
      { [F.environment]: null },
    ])
      await expect(
        engine.acceptCreate({
          principal: "alice",
          key: crypto.randomUUID(),
          input: { form: C.formUrl, space: "default", name: "bad", spec: { ...spec, ...patch } },
        }),
      ).rejects.toMatchObject({ code: C.errors.invalidSpec, status: 422 });
    expect(effects).toBe(0);
    const create = async (url: string, name: string, desired: Record<string, unknown>) => {
      const accepted = await engine.acceptCreate({
        principal: "alice",
        key: crypto.randomUUID(),
        input: { form: url, space: "default", name, spec: desired as never },
      });
      await engine.runNext();
      return accepted;
    };
    const container = await create(C.formUrl, "app", spec);
    const worker = await create(MODULE_WORKER_FORM_URL, "worker", {});
    const bundle = await create(WORKER_BUNDLE_FORM_URL, "bundle", {});
    const version = await create(C.workerVersionUrl, "version", {
      worker: { resourceUid: worker.resourceUid },
      bundle: { resourceUid: bundle.resourceUid },
      handlers: ["fetch"],
      [F.containerBindings]: [
        { [F.name]: "APP", [F.resource]: { [F.resourceUid]: container.resourceUid } },
      ],
    });
    const resolve = createContainerBindingAuthority({
      sql,
      targetKey,
      authorize: (principal, space) => authorize(principal, space),
    });
    const claim = {
      principal: "alice",
      space: "default",
      workerVersionUid: version.resourceUid,
      operationId: version.id,
      bindingName: "APP",
      targetUid: container.resourceUid,
    };
    expect(await resolve(claim)).toEqual({
      resourceUid: container.resourceUid,
      incarnationId: targetKey,
    });
    for (const patch of [
      { principal: "mallory" },
      { space: "elsewhere" },
      { targetUid: bundle.resourceUid },
      { bindingName: "OTHER" },
      { operationId: "missing" },
    ])
      expect(await resolve({ ...claim, ...patch })).toBeNull();
    await expect(
      engine.acceptDelete({
        principal: "alice",
        key: crypto.randomUUID(),
        uid: container.resourceUid,
        expectedGeneration: 1,
      }),
    ).rejects.toMatchObject({ code: C.errors.dependencyConflict, status: 409 });
    const resource = await engine.getResource({ principal: "alice", uid: container.resourceUid });
    expect(resource.observed).toEqual({
      [F.ready]: true,
      [F.servingGeneration]: 1,
      [F.imageDigest]: `sha256:${"a".repeat(64)}`,
    });
    expect(resource.output).toEqual({});
    await engine.acceptDelete({
      principal: "alice",
      key: crypto.randomUUID(),
      uid: version.resourceUid,
      expectedGeneration: 1,
    });
    await engine.runNext();
    expect(await resolve(claim)).toBeNull();
    await engine.acceptDelete({
      principal: "alice",
      key: crypto.randomUUID(),
      uid: container.resourceUid,
      expectedGeneration: 1,
    });
    await engine.runNext();
  } finally {
    database.close();
  }
});
