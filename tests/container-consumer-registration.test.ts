import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTAINER_CONTRACT as C } from "../src/container-contract.ts";
import { bytesDigest } from "../src/json.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import {
  CONTAINER_0_2_FORM_URL,
  CONTAINER_CONSUMER_WORKER_DEPLOYMENT_FORM_URL,
  CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL,
  parseContainerConsumerWorkerVersionSpec,
  validateContainerConsumerWorkerVersionUpdate,
  WORKER_DEPLOYMENT_SLOT_FORM_URLS,
} from "../src/takoform-v2/forms/container-consumer-specs.ts";
import { OBJECT_BUCKET_EOF_COUNTED_FORM_URL } from "../src/takoform-v2/forms/object-bucket-binding-profile.ts";
import { createObjectBucketWorkerBindingAuthority } from "../src/takoform-v2/forms/object-bucket-worker-binding-authority.ts";
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";
import { WORKER_CRON_TRIGGER_FORM_URL } from "../src/takoform-v2/forms/worker-cron-trigger.ts";
import {
  CONTAINER_WORKER_DEPLOYMENT_FORM_URL,
  FORWARD_WORKER_DEPLOYMENT_FORM_URL,
  FORWARD_WORKER_VERSION_FORM_URL,
  MODULE_WORKER_FORM_URL,
  parseForwardWorkerVersionSpec,
  validateForwardWorkerVersionUpdate,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import { createForwardWorkerNative106Recipe } from "../src/takoform-v2/forward-worker-native-schema.ts";
import { createV2Store } from "../src/takoform-v2/store.ts";
import type { V2Execution } from "../src/takoform-v2/types.ts";
import { createContainerConsumerWorkerDeploymentForm } from "../src/takoform-v2/worker-deployment-backend.ts";
import { createForwardV2WorkerInvocationLifecycle } from "../src/takoform-v2/worker-invocation-custody.ts";
import {
  createContainerConsumerV2NativeEffectCustody,
  createForwardV2NativeEffectCustody,
} from "../src/takoform-v2/worker-native-effects.ts";
import { createV2WorkerNativeIdentityMigrationRecipe } from "../src/takoform-v2/worker-native-identity-schema.ts";
import {
  openForwardWorkerdWorkerRuntimeOwner,
  openWorkerdWorkerRuntimeOwner,
} from "../src/workerd-worker-runtime-owner.ts";
import {
  type AdmissionFixture,
  admissionFixture,
  BUNDLE_MANIFEST_HELD_URL,
  CONTAINER_0_3_FORM_URL,
  compositionFixture,
  containerGraphFixture,
  TARGET,
} from "./helpers/container-consumer-registration.ts";

const UNREGISTERED_NEIGHBORS = [
  "https://edge.forms.takoform.com/forms/WorkerVersion/0.9.0/",
  "https://edge.forms.takoform.com/forms/WorkerDeployment/0.8.0/",
] as const;

/** A Container target of each kind, plus the unlisted 0.3.0 that must be refused. */
async function containers(f: AdmissionFixture) {
  return {
    c01: await f.create(C.formUrl, "c01", {}),
    c02: await f.create(CONTAINER_0_2_FORM_URL, "c02", {}),
    c03: await f.create(CONTAINER_0_3_FORM_URL, "c03", {}),
  };
}

test("the single-active slot list is the four Deployment Forms and nothing else", () => {
  expect([...WORKER_DEPLOYMENT_SLOT_FORM_URLS]).toEqual([
    WORKER_DEPLOYMENT_FORM_URL,
    CONTAINER_WORKER_DEPLOYMENT_FORM_URL,
    FORWARD_WORKER_DEPLOYMENT_FORM_URL,
    CONTAINER_CONSUMER_WORKER_DEPLOYMENT_FORM_URL,
  ]);
});

test("Version 0.7.0 still seals Container 0.1.0 only, while 0.8.0 seals each binding's exact Form", async () => {
  const f = admissionFixture();
  try {
    const w = await f.worker("a");
    const { c01, c02, c03 } = await containers(f);

    const bindings = (...pairs: [string, { resourceUid: string }][]) => ({
      ...w.versionSpec(),
      containerBindings: pairs.map(([name, target]) => ({
        name,
        resource: { resourceUid: target.resourceUid },
      })),
    });

    // Old 0.7.0 -> Container 0.1.0 is unchanged; -> 0.2.0 is refused before any effect.
    const before = await f.operationCount();
    const old01 = await f.create(
      FORWARD_WORKER_VERSION_FORM_URL,
      "v07-c01",
      bindings(["APP", c01]),
    );
    expect(await f.sealedForms(old01.id)).toMatchObject({ [c01.resourceUid]: C.formUrl });
    const afterOld = await f.operationCount();
    expect(afterOld).toBe(before + 1);
    const refusedOld = await f.refusal(
      FORWARD_WORKER_VERSION_FORM_URL,
      "v07-c02",
      bindings(["APP", c02]),
    );
    expect(refusedOld).toMatchObject({ status: 409 });
    expect(await f.operationCount()).toBe(afterOld);

    // New 0.8.0 seals mixed Container 0.1/0.2 per binding, exactly.
    const mixed = await f.create(
      CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL,
      "v08-mixed",
      bindings(["APP", c01], ["LEGACY", c02]),
    );
    expect(await f.sealedForms(mixed.id)).toMatchObject({
      [c01.resourceUid]: C.formUrl,
      [c02.resourceUid]: CONTAINER_0_2_FORM_URL,
    });
    // The unlisted Container 0.3.0, a non-Container target and a missing UID stay refused.
    const mark = await f.operationCount();
    for (const target of [c03.resourceUid, w.worker.resourceUid, "missing-uid"])
      expect(
        await f.refusal(
          CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL,
          `v08-bad-${target.slice(0, 6)}`,
          bindings(["APP", { resourceUid: target }]),
        ),
      ).toMatchObject({ status: 409 });
    expect(await f.operationCount()).toBe(mark);
  } finally {
    f.close();
  }
});

test("each Deployment Form selects only its own closed Version Forms", async () => {
  const f = admissionFixture();
  try {
    const w = await f.worker("a");
    const v07 = await f.create(FORWARD_WORKER_VERSION_FORM_URL, "v07", w.versionSpec());
    const v08 = await f.create(CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL, "v08", w.versionSpec());

    // Deployment 0.6.0 never gains Version 0.8.0 ...
    const mark = await f.operationCount();
    expect(
      await f.refusal(
        FORWARD_WORKER_DEPLOYMENT_FORM_URL,
        "d06-v08",
        w.deploymentSpec({ resourceUid: v08.resourceUid }),
      ),
    ).toMatchObject({ status: 409 });
    expect(await f.operationCount()).toBe(mark);
    // ... while it keeps selecting 0.5.0 and 0.7.0 exactly as before.
    const d06 = await f.create(
      FORWARD_WORKER_DEPLOYMENT_FORM_URL,
      "d06",
      w.deploymentSpec(w.v05, { resourceUid: v07.resourceUid }),
    );
    expect(await f.sealedForms(d06.id)).toMatchObject({
      [v07.resourceUid]: FORWARD_WORKER_VERSION_FORM_URL,
    });

    // Deployment 0.7.0 selects 0.5.0, 0.7.0 and 0.8.0, each sealed under its own Form.
    const other = await f.worker("b");
    const o07 = await f.create(FORWARD_WORKER_VERSION_FORM_URL, "o07", other.versionSpec());
    const o08 = await f.create(
      CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL,
      "o08",
      other.versionSpec(),
    );
    const d07 = await f.create(
      CONTAINER_CONSUMER_WORKER_DEPLOYMENT_FORM_URL,
      "d07",
      other.deploymentSpec(
        other.v05,
        { resourceUid: o07.resourceUid },
        { resourceUid: o08.resourceUid },
      ),
    );
    expect(await f.sealedForms(d07.id)).toMatchObject({
      [other.v05.resourceUid]: "https://edge.forms.takoform.com/forms/WorkerVersion/0.5.0/",
      [o07.resourceUid]: FORWARD_WORKER_VERSION_FORM_URL,
      [o08.resourceUid]: CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL,
    });
    // A Version of a different Worker is never selectable.
    const foreignMark = await f.operationCount();
    expect(
      await f.refusal(CONTAINER_CONSUMER_WORKER_DEPLOYMENT_FORM_URL, "d07-foreign", {
        ...other.deploymentSpec({ resourceUid: v08.resourceUid }),
      }),
    ).toMatchObject({ status: 409 });
    expect(await f.operationCount()).toBe(foreignMark);
  } finally {
    f.close();
  }
});

/**
 * The slot predicate is Core's own prepareAdmission; this file never restates it. Every
 * pair below crosses the Deployment Forms in BOTH creation orders on one Worker.
 */
const FORMS = [
  ["0.4.0", WORKER_DEPLOYMENT_FORM_URL],
  ["0.6.0", FORWARD_WORKER_DEPLOYMENT_FORM_URL],
  ["0.7.0", CONTAINER_CONSUMER_WORKER_DEPLOYMENT_FORM_URL],
] as const;

for (const [firstLabel, first] of FORMS)
  for (const [secondLabel, second] of FORMS) {
    if (firstLabel === secondLabel) continue;
    test(`single-active Deployment: ${firstLabel} then ${secondLabel} on one Worker is refused`, async () => {
      const f = admissionFixture();
      try {
        const w = await f.worker("a");
        await f.create(first, "first", w.deploymentSpec(w.v05));
        const mark = await f.operationCount();
        expect(await f.refusal(second, "second", w.deploymentSpec(w.v05))).toMatchObject({
          status: 409,
        });
        expect(await f.operationCount()).toBe(mark);
      } finally {
        f.close();
      }
    });
  }

test("single-active Deployment: a second 0.7.0 UID, a pending incumbent and a different Worker", async () => {
  const f = admissionFixture();
  try {
    const w = await f.worker("a");
    // Build every Worker first: runNext() always settles the oldest queued Operation.
    const free = new Map<string, Awaited<ReturnType<typeof f.worker>>>();
    for (const [label] of FORMS) free.set(label, await f.worker(`free-${label}`));
    // A queued (never run) incumbent already occupies the slot.
    await f.create(
      CONTAINER_CONSUMER_WORKER_DEPLOYMENT_FORM_URL,
      "pending",
      w.deploymentSpec(w.v05),
      false,
    );
    for (const [label, form] of FORMS) {
      const mark = await f.operationCount();
      expect(await f.refusal(form, `rival-${label}`, w.deploymentSpec(w.v05))).toMatchObject({
        status: 409,
      });
      expect(await f.operationCount()).toBe(mark);
    }
    // A different Worker is unaffected in every Form.
    for (const [label, form] of FORMS) {
      const other = free.get(label);
      if (!other) throw new Error("missing fixture Worker");
      expect(await f.refusal(form, `free-${label}`, other.deploymentSpec(other.v05))).toBeNull();
    }
  } finally {
    f.close();
  }
});

test("single-active Deployment: same-UID update, failed and deleting incumbents, and replacement after DELETE", async () => {
  const f = admissionFixture();
  try {
    const w = await f.worker("a");
    const v07 = await f.create(FORWARD_WORKER_VERSION_FORM_URL, "v07", w.versionSpec());
    const d = await f.create(
      CONTAINER_CONSUMER_WORKER_DEPLOYMENT_FORM_URL,
      "d07",
      w.deploymentSpec(w.v05),
    );
    // Same-UID update excludes itself.
    const update = await f.engine.acceptUpdate({
      principal: "alice",
      uid: d.resourceUid,
      key: "container-consumer-update-key-0001",
      expectedGeneration: 1,
      spec: w.deploymentSpec({ resourceUid: v07.resourceUid }),
    });
    expect(update.resourceUid).toBe(d.resourceUid);
    expect(await f.engine.runNext()).toMatchObject({ id: update.id, status: "succeeded" });

    // A DELETE that has been accepted but not run still owns the slot.
    const del = await f.engine.acceptDelete({
      principal: "alice",
      uid: d.resourceUid,
      key: "container-consumer-delete-key-0001",
      expectedGeneration: 2,
    });
    for (const [label, form] of FORMS)
      expect(await f.refusal(form, `deleting-${label}`, w.deploymentSpec(w.v05))).toMatchObject({
        status: 409,
      });
    expect(await f.engine.runNext()).toMatchObject({ id: del.id, status: "succeeded" });
    // Once the DELETE settles, the slot is free for ANY Deployment Form.
    expect(
      await f.refusal(FORWARD_WORKER_DEPLOYMENT_FORM_URL, "replacement", w.deploymentSpec(w.v05)),
    ).toBeNull();
  } finally {
    f.close();
  }

  // A Resource whose create settled failed/none still owns its UID until DELETE settles.
  const failing = admissionFixture();
  try {
    const w = await failing.worker("a");
    failing.setDeploymentMode("no_effect");
    const op = await failing.accept(
      CONTAINER_CONSUMER_WORKER_DEPLOYMENT_FORM_URL,
      "failed",
      w.deploymentSpec(w.v05),
    );
    expect(await failing.engine.runNext()).toMatchObject({ id: op.id, status: "failed" });
    failing.setDeploymentMode("complete");
    expect(
      await failing.refusal(
        FORWARD_WORKER_DEPLOYMENT_FORM_URL,
        "behind-failed",
        w.deploymentSpec(w.v05),
      ),
    ).toMatchObject({ status: 409 });
  } finally {
    failing.close();
  }
});

test("no neighboring Form URL is registered as part of the pair", async () => {
  const f = admissionFixture();
  try {
    const w = await f.worker("a");
    for (const form of UNREGISTERED_NEIGHBORS) {
      const mark = await f.operationCount();
      const refusal = await f.refusal(form, "neighbor", w.versionSpec());
      expect(refusal).not.toBeNull();
      expect(await f.operationCount()).toBe(mark);
    }
  } finally {
    f.close();
  }
});

// ---------------------------------------------------------------------------------------
// Production composition: registration, publication readers and the runtime-owner port.
// ---------------------------------------------------------------------------------------

test("the forward composition registers exactly the new pair; the retained one registers none", async () => {
  const f = await compositionFixture();
  try {
    for (const url of [
      CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL,
      CONTAINER_CONSUMER_WORKER_DEPLOYMENT_FORM_URL,
      FORWARD_WORKER_VERSION_FORM_URL,
      FORWARD_WORKER_DEPLOYMENT_FORM_URL,
    ])
      expect(Object.hasOwn(f.compositionForms, url)).toBe(true);
    for (const url of [
      CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL,
      CONTAINER_CONSUMER_WORKER_DEPLOYMENT_FORM_URL,
      FORWARD_WORKER_VERSION_FORM_URL,
      FORWARD_WORKER_DEPLOYMENT_FORM_URL,
      ...UNREGISTERED_NEIGHBORS,
    ])
      expect(Object.hasOwn(f.retainedForms, url)).toBe(false);
    for (const url of UNREGISTERED_NEIGHBORS)
      expect(Object.hasOwn(f.compositionForms, url)).toBe(false);
    // Distinct identities: the new pair is never the 0.7.0 / 0.6.0 object under another key.
    expect(f.compositionForms[CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL]).not.toBe(
      f.compositionForms[FORWARD_WORKER_VERSION_FORM_URL],
    );
    expect(f.compositionForms[CONTAINER_CONSUMER_WORKER_DEPLOYMENT_FORM_URL]).not.toBe(
      f.compositionForms[FORWARD_WORKER_DEPLOYMENT_FORM_URL],
    );
  } finally {
    await f.close();
  }
});

test("a static Version 0.8.0 settles in the real composition and stays pinned to its own Form", async () => {
  const f = await compositionFixture();
  try {
    const w = await f.staticWorker("a", CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL);
    const row = (
      await f.sql.query("SELECT form_url FROM tf_v2_resources WHERE uid = ?", [
        w.version.resourceUid,
      ])
    )[0];
    expect(row?.form_url).toBe(CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL);
  } finally {
    await f.close();
  }
});

test("a CODE Version 0.8.0 is refused by the capability gate for a Container binding or a private input, never by grammar", async () => {
  const f = await compositionFixture();
  try {
    // The composition HAS a forward sealer, and 0.7.0 uses it ...
    expect(f.compositionForms[FORWARD_WORKER_VERSION_FORM_URL]?.privateInputs).toBeDefined();
    // ... but none is wired to 0.8.0, so it has no private-input surface at all.
    expect(
      f.compositionForms[CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL]?.privateInputs,
    ).toBeUndefined();
    const worker = await f.create(f.engine, MODULE_WORKER_FORM_URL, "worker", {});
    const bundle = await f.create(f.engine, WORKER_BUNDLE_FORM_URL, "bundle", {
      artifact: { url: BUNDLE_MANIFEST_HELD_URL, sha256: f.bundleSha256 },
    });
    const base = {
      worker: { resourceUid: worker.op.resourceUid },
      bundle: { resourceUid: bundle.op.resourceUid },
      handlers: ["fetch"],
    };
    const mark = Number((await f.sql.query("SELECT COUNT(*) AS n FROM tf_v2_operations"))[0]?.n);
    // Control: the same code Version without either is accepted (not run: that needs workerd).
    const accepted = await f.create(
      f.engine,
      CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL,
      "plain",
      base,
      false,
    );
    expect(accepted.op.resourceUid).toBeTruthy();
    const after = Number((await f.sql.query("SELECT COUNT(*) AS n FROM tf_v2_operations"))[0]?.n);
    expect(after).toBe(mark + 1);
    for (const [label, extra] of [
      [
        "container",
        { containerBindings: [{ name: "APP", resource: { resourceUid: "any-container-uid" } }] },
      ],
      ["secret", { requiredSensitiveVars: ["TOKEN"] }],
    ] as const)
      await expect(
        f.create(
          f.engine,
          CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL,
          `refused-${label}`,
          { ...base, ...extra },
          false,
        ),
      ).rejects.toMatchObject({ status: 422, code: "capability_required" });
    expect(Number((await f.sql.query("SELECT COUNT(*) AS n FROM tf_v2_operations"))[0]?.n)).toBe(
      after,
    );
  } finally {
    await f.close();
  }
});

test("Deployment 0.7.0 reaches the runtime-owner port through the production readers, once, with the exact graph", async () => {
  const f = await compositionFixture();
  try {
    const w = await f.staticWorker("a", CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL);
    const versionId = await f.versionId(w.version.resourceUid, 1);
    f.owner.deployments.set(w.worker.resourceUid, [
      { versionId, workerVersionUid: w.version.resourceUid, weight: 10_000 },
    ]);
    const deployment = await f.create(
      f.engine,
      CONTAINER_CONSUMER_WORKER_DEPLOYMENT_FORM_URL,
      "deployment",
      {
        worker: { resourceUid: w.worker.resourceUid },
        versions: [{ workerVersion: { resourceUid: w.version.resourceUid }, weight: 10_000 }],
      },
    );
    expect(deployment.settled).toMatchObject({ status: "succeeded", effect: "complete" });
    // The owner double saw the exact accepted Operation, once, under the new Form.
    expect(f.owner.calls).toEqual([
      {
        form: CONTAINER_CONSUMER_WORKER_DEPLOYMENT_FORM_URL,
        action: "create",
        operationId: deployment.op.id,
        resourceUid: deployment.op.resourceUid,
        spec: {
          worker: { resourceUid: w.worker.resourceUid },
          versions: [{ workerVersion: { resourceUid: w.version.resourceUid }, weight: 10_000 }],
        },
      },
    ]);
    const resource = (
      await f.sql.query("SELECT observed_json FROM tf_v2_resources WHERE uid = ?", [
        deployment.op.resourceUid,
      ])
    )[0];
    expect(JSON.parse(String(resource?.observed_json))).toEqual({
      ready: true,
      active: true,
      selectedVersions: [{ resourceUid: w.version.resourceUid, weight: 10_000 }],
    });
    // Committed-serving readback (boot recovery path) sees the same graph, form and all.
    const serving = await f.publicationState.resolveCurrentServing({
      workerUid: w.worker.resourceUid,
      targetKey: TARGET,
      sourceOperationId: deployment.op.id,
      expectedIdentity: {
        generation: `takoserver-v2-operation:${deployment.op.id}`,
        workerResourceUid: w.worker.resourceUid,
        hostnames: [],
        versions: [{ workerVersionUid: w.version.resourceUid, weight: 10_000 }],
      },
    });
    expect(serving.kind).toBe("ready");
    if (serving.kind !== "ready") return;
    expect(serving.snapshot.deployment?.versions[0]?.form).toBe(
      CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL,
    );
    expect(await serving.stillCurrent()).toBe(true);
  } finally {
    await f.close();
  }
});

test("registration is not a false closure: a Deployment 0.7.0 with no native owner never settles", async () => {
  const f = await compositionFixture();
  try {
    const w = await f.staticWorker("a", CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL);
    const created = await f.create(
      f.noOwnerEngine,
      CONTAINER_CONSUMER_WORKER_DEPLOYMENT_FORM_URL,
      "deployment",
      {
        worker: { resourceUid: w.worker.resourceUid },
        versions: [{ workerVersion: { resourceUid: w.version.resourceUid }, weight: 10_000 }],
      },
    );
    // Admission and the graph readers pass, but no owner can confirm: the backend reports
    // unknown, never complete, and the Resource must not claim an active Deployment.
    expect(created.settled?.status).not.toBe("succeeded");
    expect(created.settled?.effect).toBe("unknown");
    expect(f.owner.calls).toEqual([]);
    const resource = (
      await f.sql.query("SELECT observed_json FROM tf_v2_resources WHERE uid = ?", [
        created.op.resourceUid,
      ])
    )[0];
    expect(JSON.parse(String(resource?.observed_json))).not.toMatchObject({ active: true });
  } finally {
    await f.close();
  }
});

test("Endpoint admission and execution follow a Deployment 0.7.0 over a Version 0.8.0 to the owner port", async () => {
  const f = await compositionFixture();
  try {
    const w = await f.staticWorker("a", CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL);
    const versionId = await f.versionId(w.version.resourceUid, 1);
    const weightedVersions = [
      { versionId, workerVersionUid: w.version.resourceUid, weight: 10_000 },
    ];
    f.owner.deployments.set(w.worker.resourceUid, weightedVersions);
    const endpointSpec = { worker: { resourceUid: w.worker.resourceUid } };
    // Without an active Deployment the Endpoint is refused at acceptance (existing semantics).
    await expect(
      f.create(f.engine, WORKER_ENDPOINT_FORM_URL, "endpoint-early", endpointSpec, false),
    ).rejects.toMatchObject({ status: 409 });
    const deployment = await f.create(
      f.engine,
      CONTAINER_CONSUMER_WORKER_DEPLOYMENT_FORM_URL,
      "deployment",
      {
        worker: { resourceUid: w.worker.resourceUid },
        versions: [{ workerVersion: { resourceUid: w.version.resourceUid }, weight: 10_000 }],
      },
    );
    expect(deployment.settled).toMatchObject({ status: "succeeded" });
    const endpoint = await f.create(f.engine, WORKER_ENDPOINT_FORM_URL, "endpoint", endpointSpec);
    expect(endpoint.settled).toMatchObject({ status: "succeeded", effect: "complete" });
    f.owner.endpointHostnames.set(w.worker.resourceUid, [f.hostnameFor(endpoint.op.resourceUid)]);
    // The owner saw the Deployment first and the Endpoint second, each under its own Form.
    expect(f.owner.calls.map((call) => [call.form, call.action])).toEqual([
      [CONTAINER_CONSUMER_WORKER_DEPLOYMENT_FORM_URL, "create"],
      [WORKER_ENDPOINT_FORM_URL, "create"],
    ]);
    // A second Endpoint on the same Worker stays refused.
    await expect(
      f.create(f.engine, WORKER_ENDPOINT_FORM_URL, "endpoint-two", endpointSpec, false),
    ).rejects.toMatchObject({ status: 409 });
  } finally {
    await f.close();
  }
});

test("DELETE of a Deployment 0.7.0 settles through the owner port and frees the slot for either Form", async () => {
  const f = await compositionFixture();
  try {
    const w = await f.staticWorker("a", CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL);
    // A 0.7.0 Version of the same Worker, so Deployment 0.6.0 has a spec it could otherwise take.
    const v07 = await f.create(f.engine, FORWARD_WORKER_VERSION_FORM_URL, "version-07", {
      worker: { resourceUid: w.worker.resourceUid },
      handlers: [],
      assets: {
        bundle: { resourceUid: w.assets.resourceUid },
        runWorkerFirst: false,
        notFoundHandling: "none",
      },
    });
    expect(v07.settled).toMatchObject({ status: "succeeded" });
    f.owner.deployments.set(w.worker.resourceUid, [
      {
        versionId: await f.versionId(w.version.resourceUid, 1),
        workerVersionUid: w.version.resourceUid,
        weight: 10_000,
      },
    ]);
    const spec07 = {
      worker: { resourceUid: w.worker.resourceUid },
      versions: [{ workerVersion: { resourceUid: w.version.resourceUid }, weight: 10_000 }],
    };
    const spec06 = {
      worker: { resourceUid: w.worker.resourceUid },
      versions: [{ workerVersion: { resourceUid: v07.op.resourceUid }, weight: 10_000 }],
    };
    const created = await f.create(
      f.engine,
      CONTAINER_CONSUMER_WORKER_DEPLOYMENT_FORM_URL,
      "d07",
      spec07,
    );
    // The 0.6.0 spec is admissible on its own; only the occupied slot refuses it here.
    await expect(
      f.create(f.engine, FORWARD_WORKER_DEPLOYMENT_FORM_URL, "d06-early", spec06, false),
    ).rejects.toMatchObject({ status: 409 });
    const del = await f.engine.acceptDelete({
      principal: "alice",
      uid: created.op.resourceUid,
      key: "container-consumer-composition-delete-key-0001",
      expectedGeneration: 1,
    });
    expect(await f.engine.runNext()).toMatchObject({
      id: del.id,
      status: "succeeded",
      effect: "complete",
    });
    expect(f.owner.calls.at(-1)).toMatchObject({
      form: CONTAINER_CONSUMER_WORKER_DEPLOYMENT_FORM_URL,
      action: "delete",
    });
    // The very same spec is accepted once the 0.7.0 DELETE settled: the slot, not the spec, refused.
    const replacement = await f.create(
      f.engine,
      FORWARD_WORKER_DEPLOYMENT_FORM_URL,
      "d06",
      spec06,
      false,
    );
    expect(replacement.op.resourceUid).not.toBe(created.op.resourceUid);
  } finally {
    await f.close();
  }
});

test("a Deployment 0.6.0 reader never serves a Version 0.8.0 even when a row is swapped under it", async () => {
  const f = await compositionFixture();
  try {
    const w = await f.staticWorker("a", FORWARD_WORKER_VERSION_FORM_URL);
    f.owner.deployments.set(w.worker.resourceUid, [
      {
        versionId: await f.versionId(w.version.resourceUid, 1),
        workerVersionUid: w.version.resourceUid,
        weight: 10_000,
      },
    ]);
    const deployment = await f.create(f.engine, FORWARD_WORKER_DEPLOYMENT_FORM_URL, "d06", {
      worker: { resourceUid: w.worker.resourceUid },
      versions: [{ workerVersion: { resourceUid: w.version.resourceUid }, weight: 10_000 }],
    });
    expect(deployment.settled).toMatchObject({ status: "succeeded" });
    const input = {
      workerUid: w.worker.resourceUid,
      targetKey: TARGET,
      sourceOperationId: deployment.op.id,
      expectedIdentity: {
        generation: `takoserver-v2-operation:${deployment.op.id}`,
        workerResourceUid: w.worker.resourceUid,
        hostnames: [],
        versions: [{ workerVersionUid: w.version.resourceUid, weight: 10_000 }],
      },
    };
    // Control: the exact 0.6.0 -> 0.7.0 graph is readable.
    expect((await f.publicationState.resolveCurrentServing(input)).kind).toBe("ready");
    // Corrupt SQL: the same Version UID now claims to be 0.8.0. 0.6.0 must not read it, and the
    // sealed reference (0.7.0) no longer matches the row either.
    f.db.exec("DROP TRIGGER tf_v2_resource_identity_immutable");
    f.db
      .query("UPDATE tf_v2_resources SET form_url = ? WHERE uid = ?")
      .run(CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL, w.version.resourceUid);
    expect((await f.publicationState.resolveCurrentServing(input)).kind).toBe("unresolved");
    // Make the corruption self-consistent: the Deployment's sealed reference now also names
    // 0.8.0. Nothing but Deployment 0.6.0's own closed Version set refuses this graph.
    f.db.exec("DROP TRIGGER tf_v2_operation_reference_immutable");
    f.db
      .query(
        "UPDATE tf_v2_operation_references SET form_url = ? WHERE operation_id = ? AND target_uid = ?",
      )
      .run(CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL, deployment.op.id, w.version.resourceUid);
    expect((await f.publicationState.resolveCurrentServing(input)).kind).toBe("unresolved");
  } finally {
    await f.close();
  }
});

// ---------------------------------------------------------------------------------------
// Hosted-selection (Container) publication reader over mixed Container 0.1 / 0.2 targets.
// ---------------------------------------------------------------------------------------

test("a Version 0.8.0 with mixed Container 0.1/0.2 bindings is read exactly, and only by the Container reader", async () => {
  const f = containerGraphFixture();
  try {
    const g = await f.graph({
      versionForm: CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL,
      deploymentForm: CONTAINER_CONSUMER_WORKER_DEPLOYMENT_FORM_URL,
      bindings: ["c01", "c02"],
    });
    const input = { execution: g.deploymentExecution };
    // The non-Container Forward reader and the generic reader never see Container bindings.
    expect((await f.nonContainer.resolveForward(input)).kind).toBe("unresolved");
    expect((await f.generic.resolveForward(input)).kind).toBe("unresolved");
    const result = await f.hosted.resolveForward(input);
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    const selected = result.snapshot.deployment?.versions[0];
    expect(selected?.form).toBe(CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL);
    expect(selected?.spec).toMatchObject({
      containerBindings: [
        { name: "APP", resource: { resourceUid: g.c01.resourceUid } },
        { name: "LEGACY", resource: { resourceUid: g.c02.resourceUid } },
      ],
    });
    expect(await result.stillCurrent()).toBe(true);
    // Either target changing after the read invalidates it.
    for (const target of [g.c01, g.c02]) {
      const again = await f.hosted.resolveForward(input);
      expect(again.kind).toBe("ready");
      if (again.kind !== "ready") return;
      f.db
        .query("UPDATE tf_v2_resources SET output_json = ? WHERE uid = ?")
        .run('{"changed":true}', target.resourceUid);
      expect(await again.stillCurrent()).toBe(false);
      f.db
        .query("UPDATE tf_v2_resources SET output_json = ? WHERE uid = ?")
        .run("{}", target.resourceUid);
    }
  } finally {
    f.close();
  }
});

test("a Version 0.7.0 sealed to Container 0.1.0 is still read by Deployment 0.7.0, but never against Container 0.2.0", async () => {
  const f = containerGraphFixture();
  try {
    const g = await f.graph({
      versionForm: FORWARD_WORKER_VERSION_FORM_URL,
      deploymentForm: CONTAINER_CONSUMER_WORKER_DEPLOYMENT_FORM_URL,
      bindings: ["c01"],
    });
    const ok = await f.hosted.resolveForward({ execution: g.deploymentExecution });
    expect(ok.kind).toBe("ready");
    if (ok.kind === "ready")
      expect(ok.snapshot.deployment?.versions[0]?.form).toBe(FORWARD_WORKER_VERSION_FORM_URL);
    // The Container target is swapped to Form 0.2.0 after sealing: Version 0.7.0 only ever
    // sealed 0.1.0, so this is unresolved even though Version 0.8.0 would accept 0.2.0.
    f.db.exec("DROP TRIGGER tf_v2_resource_identity_immutable");
    f.db
      .query("UPDATE tf_v2_resources SET form_url = ? WHERE uid = ?")
      .run(CONTAINER_0_2_FORM_URL, g.c01.resourceUid);
    expect((await f.hosted.resolveForward({ execution: g.deploymentExecution })).kind).toBe(
      "unresolved",
    );
    // Self-consistent corruption: the Version's sealed reference now says 0.2.0 as well, so only
    // Version 0.7.0's own fixed Container 0.1.0 vocabulary can still refuse the graph.
    f.db.exec("DROP TRIGGER tf_v2_operation_reference_immutable");
    f.db
      .query(
        "UPDATE tf_v2_operation_references SET form_url = ? WHERE operation_id = ? AND target_uid = ?",
      )
      .run(CONTAINER_0_2_FORM_URL, g.version.id, g.c01.resourceUid);
    expect((await f.hosted.resolveForward({ execution: g.deploymentExecution })).kind).toBe(
      "unresolved",
    );
  } finally {
    f.close();
  }
});

for (const mutation of [
  "missing-edge",
  "reference-form",
  "swap-c01-to-02",
  "swap-c02-to-01",
  "owner",
  "target-key",
  "generation",
] as const) {
  test(`Version 0.8.0 mixed graph fails closed on ${mutation} drift`, async () => {
    const f = containerGraphFixture();
    try {
      const g = await f.graph({
        versionForm: CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL,
        deploymentForm: CONTAINER_CONSUMER_WORKER_DEPLOYMENT_FORM_URL,
        bindings: ["c01", "c02"],
      });
      const control = await f.hosted.resolveForward({ execution: g.deploymentExecution });
      expect(control.kind).toBe("ready");
      const target = mutation === "swap-c02-to-01" ? g.c02 : g.c01;
      if (mutation === "missing-edge")
        f.db
          .query("DELETE FROM tf_v2_resource_references WHERE referrer_uid = ? AND target_uid = ?")
          .run(g.version.resourceUid, target.resourceUid);
      else if (mutation === "reference-form") {
        f.db.exec("DROP TRIGGER tf_v2_operation_reference_immutable");
        f.db
          .query(
            "UPDATE tf_v2_operation_references SET form_url = ? WHERE operation_id = ? AND target_uid = ?",
          )
          .run(MODULE_WORKER_FORM_URL, g.version.id, target.resourceUid);
      } else {
        f.db.exec("DROP TRIGGER tf_v2_resource_identity_immutable");
        const set = (column: string, value: string | number) =>
          f.db
            .query(`UPDATE tf_v2_resources SET ${column} = ? WHERE uid = ?`)
            .run(value, target.resourceUid);
        if (mutation === "swap-c01-to-02") set("form_url", CONTAINER_0_2_FORM_URL);
        if (mutation === "swap-c02-to-01") set("form_url", C.formUrl);
        if (mutation === "owner") set("principal", "bob");
        if (mutation === "target-key") set("target_key", "elsewhere");
        if (mutation === "generation") set("observed_generation", 0);
      }
      expect((await f.hosted.resolveForward({ execution: g.deploymentExecution })).kind).toBe(
        "unresolved",
      );
    } finally {
      f.close();
    }
  });
}

test("the forward invocation lifecycle constructor accepts a Version Form only with a Deployment Form that may select it", () => {
  // Construction never queries; a real in-memory port keeps the type honest.
  const sql = createSqliteSql(new Database(":memory:"));
  expect(() => createForwardV2WorkerInvocationLifecycle({ sql })).not.toThrow();
  expect(() =>
    createForwardV2WorkerInvocationLifecycle({
      sql,
      deploymentForm: CONTAINER_CONSUMER_WORKER_DEPLOYMENT_FORM_URL,
      selectedVersionForm: CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL,
    }),
  ).not.toThrow();
  // 0.6.0 (the default Deployment Form) never admits a 0.8.0 Version.
  expect(() =>
    createForwardV2WorkerInvocationLifecycle({
      sql,
      selectedVersionForm: CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL,
    }),
  ).toThrow(/not selectable/u);
  expect(() =>
    createForwardV2WorkerInvocationLifecycle({
      sql,
      // @ts-expect-error a non-forward Deployment Form is outside the closed set
      deploymentForm: WORKER_DEPLOYMENT_FORM_URL,
    }),
  ).toThrow(/unsupported WorkerDeployment Form/u);
});

// ---------------------------------------------------------------------------------------
// The real runtime-owner module's Form gate (no child is ever spawned in this test).
// ---------------------------------------------------------------------------------------

test("the forward runtime owner admits Deployment 0.7.0 past its Form gate; the retained owner and any other Form do not", async () => {
  const root = mkdtempSync(join(tmpdir(), "container-consumer-owner-gate-"));
  const resolved: string[] = [];
  const unresolved = async ({ execution }: { execution: V2Execution }) => {
    resolved.push(`${execution.form}#${execution.operationId}`);
    return {
      kind: "unresolved" as const,
      code: "graph_unresolved" as const,
      message: "fixture reader refuses every graph",
    };
  };
  const workerUid = "worker-owner-gate";
  const options = {
    rootDirectory: join(root, "owners"),
    workerResourceUid: workerUid,
    targetKey: TARGET,
    publicationState: { resolve: unresolved, resolveForward: unresolved },
    workerdBinary: process.execPath,
    listenerPortForOperation: async () => {
      throw new Error("the gate fixture has no native listener");
    },
    spawn() {
      throw new Error("the gate fixture cannot spawn a native child");
    },
  };
  const execution = (form: string, id: string): V2Execution => ({
    operationId: id,
    leaseToken: `lease-${id}`,
    backendKey: `backend-${id}`,
    backendId: "fixture-worker-deployment-backend",
    targetKey: TARGET,
    resourceUid: `deployment-${workerUid}`,
    principal: "alice",
    action: "create",
    generation: 1,
    form,
    space: "space",
    name: "deployment",
    spec: {
      worker: { resourceUid: workerUid },
      versions: [{ workerVersion: { resourceUid: "version" }, weight: 10_000 }],
    },
    previousObserved: {},
    previousOutput: {},
  });
  const mismatch = {
    kind: "not_dispatched",
    code: "worker_publication_target_mismatch",
  } as const;
  const results: unknown[] = [];
  try {
    const forward = await openForwardWorkerdWorkerRuntimeOwner(options);
    try {
      // Both forward-family Deployment Forms get past the exact Form gate; reader reach is unproved.
      for (const form of [
        FORWARD_WORKER_DEPLOYMENT_FORM_URL,
        CONTAINER_CONSUMER_WORKER_DEPLOYMENT_FORM_URL,
      ]) {
        const id = crypto.randomUUID();
        const result = await forward.execute(execution(form, id));
        // Not the Form-gate refusal. (What follows the gate needs a real workerd runtime, which
        // this test deliberately does not have, so only the gate itself is asserted.)
        expect(result).not.toEqual(mismatch);
        results.push(result);
      }
      // The new Form is handled exactly like 0.6.0 once past the gate.
      expect(results[1]).toEqual(results[0]);
      // ... a neighbouring Form never does.
      const before = resolved.length;
      for (const form of UNREGISTERED_NEIGHBORS)
        expect(await forward.execute(execution(form, crypto.randomUUID()))).toEqual(mismatch);
      expect(resolved.length).toBe(before);
    } finally {
      await forward.close();
    }
    const retained = await openWorkerdWorkerRuntimeOwner({
      ...options,
      rootDirectory: join(root, "retained-owners"),
    });
    try {
      const before = resolved.length;
      for (const form of [
        FORWARD_WORKER_DEPLOYMENT_FORM_URL,
        CONTAINER_CONSUMER_WORKER_DEPLOYMENT_FORM_URL,
      ])
        expect(await retained.execute(execution(form, crypto.randomUUID()))).toEqual(mismatch);
      expect(resolved.length).toBe(before);
    } finally {
      await retained.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("each backend executes only its own exact Form: a real 0.6.0 / 0.7.0 Operation is never run by the other Form's backend", async () => {
  const f = await compositionFixture();
  try {
    // A real, claimed Deployment 0.6.0 Operation over a Version 0.7.0. Run by the right backend
    // it completes (positive control: the claim and the graph are valid, so a missing Form check
    // would be observable as a confirmed owner call); run by the 0.7.0 backend it must not be.
    const w = await f.staticWorker("a", FORWARD_WORKER_VERSION_FORM_URL);
    f.owner.deployments.set(w.worker.resourceUid, [
      {
        versionId: await f.versionId(w.version.resourceUid, 1),
        workerVersionUid: w.version.resourceUid,
        weight: 10_000,
      },
    ]);
    const spec = {
      worker: { resourceUid: w.worker.resourceUid },
      versions: [{ workerVersion: { resourceUid: w.version.resourceUid }, weight: 10_000 }],
    };
    const d06 = await f.create(f.engine, FORWARD_WORKER_DEPLOYMENT_FORM_URL, "d06", spec, false);
    const execution = await f.claim(d06.op.id);
    const d06Form = f.engineForms[FORWARD_WORKER_DEPLOYMENT_FORM_URL];
    const d07Form = f.engineForms[CONTAINER_CONSUMER_WORKER_DEPLOYMENT_FORM_URL];
    if (!d06Form || !d07Form) throw new Error("form is not registered");
    expect(await d07Form.backend.execute(execution)).toMatchObject({ kind: "unknown" });
    expect(f.owner.calls).toEqual([]);
    // The Cron reader is a second exact-Form gate. Isolate the backend's own gate by wiring a
    // permissive attachment reader (a labeled double): the backend alone must still refuse.
    const isolated = createContainerConsumerWorkerDeploymentForm({
      targetKey: TARGET,
      publicationState: f.publicationState,
      scheduledAttachments: {
        async requiresScheduledHandler() {
          return {
            kind: "ready",
            required: false,
            attachmentUids: [],
            stillCurrent: async () => true,
          };
        },
      },
      ownerForWorker: async (workerUid) => f.owner.owner(workerUid),
    });
    expect(await isolated.backend.execute(execution)).toMatchObject({ kind: "unknown" });
    expect(f.owner.calls).toEqual([]);
    expect(await d06Form.backend.execute(execution)).toMatchObject({ kind: "complete" });
    expect(f.owner.calls).toHaveLength(1);

    // The same for a real, claimed Version 0.7.0 Operation and the 0.8.0 backend.
    const v07 = await f.create(
      f.engine,
      FORWARD_WORKER_VERSION_FORM_URL,
      "v07-b",
      {
        worker: { resourceUid: w.worker.resourceUid },
        handlers: [],
        assets: {
          bundle: { resourceUid: w.assets.resourceUid },
          runWorkerFirst: false,
          notFoundHandling: "none",
        },
      },
      false,
    );
    const versionExecution = await f.claim(v07.op.id);
    const v07Form = f.engineForms[FORWARD_WORKER_VERSION_FORM_URL];
    const v08Form = f.engineForms[CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL];
    if (!v07Form || !v08Form) throw new Error("form is not registered");
    expect(await v08Form.backend.execute(versionExecution)).toMatchObject({ kind: "unknown" });
    expect(await v07Form.backend.execute(versionExecution)).toMatchObject({ kind: "complete" });
  } finally {
    await f.close();
  }
});

test("a Version 0.8.0 bucket binding resolves through the bucket authority exactly as 0.7.0's does", async () => {
  for (const versionForm of [
    FORWARD_WORKER_VERSION_FORM_URL,
    CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL,
  ]) {
    const f = admissionFixture();
    try {
      const w = await f.worker("a");
      const bucket = await f.create(OBJECT_BUCKET_EOF_COUNTED_FORM_URL, "bucket", {});
      const version = await f.create(versionForm, "version", {
        ...w.versionSpec(),
        bucketBindings: [{ name: "BUCKET", resource: { resourceUid: bucket.resourceUid } }],
      });
      const digest = await bytesDigest(
        new TextEncoder().encode(`${version.resourceUid}\u0000${version.generation}`),
      );
      const claim = {
        principal: "alice",
        space: "space",
        targetKey: TARGET,
        workerUid: w.worker.resourceUid,
        workerVersionUid: version.resourceUid,
        workerVersionOperationId: version.id,
        nativeVersionId: `v2-${digest.slice("sha256:".length)}`,
        incarnationId: "incarnation-1",
        servingSourceOperationId: version.id,
        bindings: [{ name: "BUCKET", resourceUid: bucket.resourceUid }],
      };
      const authority = createObjectBucketWorkerBindingAuthority({ sql: f.sql, targetKey: TARGET });
      const resolved = await authority.resolveCurrentBucketBinding(claim, "BUCKET");
      expect(resolved).not.toBeNull();
      expect(resolved?.targetFormUrl).toBe(OBJECT_BUCKET_EOF_COUNTED_FORM_URL);
      // A binding the Version did not declare never resolves.
      expect(
        await authority.resolveCurrentBucketBinding(
          { ...claim, bindings: [{ name: "OTHER", resourceUid: bucket.resourceUid }] },
          "BUCKET",
        ),
      ).toBeNull();
    } finally {
      f.close();
    }
  }
});

test("the composition's OWN registered Deployment 0.7.0 reads its Cron attachments, observable without any owner", async () => {
  const f = await compositionFixture();
  try {
    const w = await f.staticWorker("a", CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL);
    // An accepted (not yet settled) Cron attachment on the Worker, whose static Version declares
    // no `scheduled` handler. Only a Cron reader that understands the 0.7.0 claim can see it.
    await f.create(
      f.engine,
      WORKER_CRON_TRIGGER_FORM_URL,
      "cron",
      { worker: { resourceUid: w.worker.resourceUid }, cron: "*/5 * * * *" },
      false,
    );
    const d07 = await f.create(
      f.engine,
      CONTAINER_CONSUMER_WORKER_DEPLOYMENT_FORM_URL,
      "deployment",
      {
        worker: { resourceUid: w.worker.resourceUid },
        versions: [{ workerVersion: { resourceUid: w.version.resourceUid }, weight: 10_000 }],
      },
      false,
    );
    const execution = await f.claim(d07.op.id);
    const ownDeployment = f.compositionForms[CONTAINER_CONSUMER_WORKER_DEPLOYMENT_FORM_URL];
    if (!ownDeployment) throw new Error("the composition did not register Deployment 0.7.0");
    // The composition's Form resolves the graph and reads the attachment through ITS Cron reader,
    // and settles the Operation with the Form-defined refusal before any owner is consulted. A
    // reader pinned to another Deployment Form (for example 0.6.0's, whose claim check requires
    // its own Form) would answer `unknown` here instead.
    expect(await ownDeployment.backend.execute(execution)).toMatchObject({
      kind: "no_effect",
      code: "worker_scheduled_handler_missing",
    });
    // No owner was ever opened for this Worker.
    expect(await readdir(f.options.rootDirectory)).toEqual([]);
  } finally {
    await f.close();
  }
});

// ---------------------------------------------------------------------------------------
// Pinned limit: native custody for the new pair fails closed on the INSTALLED 106 schema.
// ---------------------------------------------------------------------------------------

const DIGEST = `sha256:${"a".repeat(64)}` as const;

async function nativeFixture(form: string) {
  const db = new Database(":memory:");
  migrateSqlite(db);
  db.exec("PRAGMA foreign_keys = ON");
  const apply = (recipe: {
    readonly steps: readonly { readonly statements: readonly string[] }[];
  }) => {
    db.exec("BEGIN IMMEDIATE");
    for (const step of recipe.steps) for (const statement of step.statements) db.exec(statement);
    db.exec("COMMIT");
  };
  apply(createV2WorkerNativeIdentityMigrationRecipe());
  apply(createForwardWorkerNative106Recipe());
  const sql = createSqliteSql(db);
  const now = () => new Date();
  const backend = {
    id: "native-pin-backend",
    targetKey: "target-a",
    async execute() {
      return { kind: "unknown" as const };
    },
    async reconcile() {
      return { kind: "unknown" as const };
    },
  };
  const engine = createTakoformV2Engine({
    sql,
    now,
    replayWindowSeconds: 3600,
    leaseMilliseconds: 60_000,
    authorize: async () => true,
    forms: {
      [FORWARD_WORKER_VERSION_FORM_URL]: {
        validateCreate: parseForwardWorkerVersionSpec,
        validateUpdate: validateForwardWorkerVersionUpdate,
        backend,
      },
      [CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL]: {
        validateCreate: parseContainerConsumerWorkerVersionSpec,
        validateUpdate: validateContainerConsumerWorkerVersionUpdate,
        backend,
      },
    },
  });
  const accepted = await engine.acceptCreate({
    principal: "org-a",
    key: "native-pin-create-key",
    input: {
      form,
      space: "production",
      name: "version-a",
      spec: {
        worker: { resourceUid: "worker-a" },
        bundle: { resourceUid: "bundle-a" },
        handlers: ["fetch"],
        containerBindings: [],
      },
    },
  });
  const store = createV2Store(sql);
  const operation = await store.operation(accepted.id);
  const resource = operation && (await store.resource(operation.resource_uid));
  if (!operation || !resource) throw new Error("accepted source missing");
  const leaseToken = "native-pin-lease";
  const start = Date.now();
  expect(await store.claim(operation.id, leaseToken, start, start + 60_000)).toBe(true);
  expect(await store.markDispatch(operation.id, leaseToken, now().toISOString())).toBe(true);
  const execution: V2Execution = {
    operationId: operation.id,
    resourceUid: resource.uid,
    principal: operation.principal,
    action: operation.action,
    generation: operation.generation,
    form: resource.form_url,
    space: resource.space,
    name: resource.name,
    spec: JSON.parse(operation.accepted_spec_json),
    previousObserved: {},
    previousOutput: {},
    backendKey: operation.backend_key,
    backendId: operation.backend_id,
    targetKey: operation.target_key,
    leaseToken,
  };
  return { db, sql, now, execution };
}

test("native effect custody for Version 0.8.0 is aborted by the installed 106 schema trigger, while 0.7.0's is granted", async () => {
  // Control: the identical Operation shape under Version 0.7.0 is granted by the same schema.
  const old = await nativeFixture(FORWARD_WORKER_VERSION_FORM_URL);
  try {
    const custody = createForwardV2NativeEffectCustody({ sql: old.sql, now: old.now });
    expect(
      await custody.grant({
        execution: old.execution,
        nativeIdentity: "forward-script",
        closureDigest: DIGEST,
      }),
    ).toBe("granted");
  } finally {
    old.db.close();
  }
  const next = await nativeFixture(CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL);
  try {
    const custody = createContainerConsumerV2NativeEffectCustody({ sql: next.sql, now: next.now });
    // The 106 insert guard admits only WorkerVersion 0.5.0 / 0.7.0. When a successor schema
    // widens that domain this assertion must be flipped deliberately, together with the
    // readiness predicate every forward custody repeats.
    await expect(
      custody.grant({
        execution: next.execution,
        nativeIdentity: "consumer-script",
        closureDigest: DIGEST,
      }),
    ).rejects.toThrow(/tf_v2_worker_native_effect_claim_lost/u);
    expect(
      Number((await next.sql.query("SELECT COUNT(*) AS n FROM tf_v2_worker_native_effects"))[0]?.n),
    ).toBe(0);
  } finally {
    next.db.close();
  }
});

test("the retained Deployment's captured SQL guard also refuses a Deployment 0.7.0 that appears after capture", async () => {
  const f = await compositionFixture();
  try {
    const w = await f.staticWorker("a", WORKER_VERSION_FORM_URL);
    const d04 = await f.create(
      f.engine,
      WORKER_DEPLOYMENT_FORM_URL,
      "deployment-04",
      {
        worker: { resourceUid: w.worker.resourceUid },
        versions: [{ workerVersion: { resourceUid: w.version.resourceUid }, weight: 10_000 }],
      },
      false,
    );
    const resolved = await f.publicationState.resolve({ execution: await f.claim(d04.op.id) });
    expect(resolved.kind).toBe("ready");
    if (resolved.kind !== "ready") return;
    const holds = async () =>
      (
        await f.sql.query(`SELECT 1 AS ok WHERE ${resolved.sqlGuard.sql}`, [
          ...resolved.sqlGuard.params,
        ])
      ).length === 1;
    expect(await holds()).toBe(true);
    // A Deployment 0.7.0 for the same Worker lands between capture and the route CAS (the
    // single-active admission fence makes this impossible through the engine, so inject the row).
    await f.sql.run(
      `INSERT INTO tf_v2_resources
         (uid, principal, form_url, space, name, backend_id, target_key, active_name, generation,
          observed_generation, observed_at, phase, spec_json, observed_json, output_json,
          last_operation, busy_operation, deleted_at)
       SELECT 'raced-deployment-07', principal, ?, space, 'raced-07', backend_id, target_key,
              'raced-07', generation, observed_generation, observed_at, phase, spec_json,
              observed_json, output_json, last_operation, busy_operation, NULL
       FROM tf_v2_resources WHERE uid = ?`,
      [CONTAINER_CONSUMER_WORKER_DEPLOYMENT_FORM_URL, d04.op.resourceUid],
    );
    expect(await holds()).toBe(false);
  } finally {
    await f.close();
  }
});
