import { expect, test } from "bun:test";
import { CONTAINER_CONTRACT as C } from "../src/container-contract.ts";
import {
  prepareContainerConsumerWorkerDeploymentReferences,
  prepareContainerConsumerWorkerVersionReferences,
  referencesForContainerConsumerWorkerDeployment,
  referencesForContainerConsumerWorkerVersion,
} from "../src/takoform-v2/forms/container-consumer-references.ts";
import {
  CONTAINER_0_1_FORM_URL,
  CONTAINER_0_2_FORM_URL,
  CONTAINER_CONSUMER_WORKER_DEPLOYMENT_FORM_URL,
  CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL,
  parseContainerConsumerWorkerVersionSpec,
} from "../src/takoform-v2/forms/container-consumer-specs.ts";
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";
import { referencesForForwardWorkerDeployment } from "../src/takoform-v2/forms/worker-references.ts";
import {
  FORWARD_WORKER_DEPLOYMENT_FORM_URL,
  FORWARD_WORKER_VERSION_FORM_URL,
  MODULE_WORKER_FORM_URL,
  parseForwardWorkerVersionSpec,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import {
  CONTAINER_0_3_FORM_URL,
  containerConsumerFixture,
  PRINCIPAL,
  SPACE,
  TARGET,
} from "./helpers/container-consumer-nonsecret.ts";

/**
 * WorkerVersion 0.8.0 / WorkerDeployment 0.7.0 consumer: the real v2 engine seals each
 * containerBinding against its exact target Form (Container 0.1.0 or 0.2.0), and the real
 * post-acceptance reader returns that exact (Version Form, target Form) pair. WorkerVersion
 * 0.7.0 keeps sealing Container 0.1.0 only. Core acceptance mechanics, not native proof.
 */
async function mixedGraph() {
  const f = await containerConsumerFixture();
  const worker = await f.create(MODULE_WORKER_FORM_URL, "worker");
  const bundle = await f.create(WORKER_BUNDLE_FORM_URL, "bundle");
  const first = await f.create(CONTAINER_0_1_FORM_URL, "container-one");
  const second = await f.create(CONTAINER_0_2_FORM_URL, "container-two");
  const spec = {
    worker: { resourceUid: worker.resourceUid },
    bundle: { resourceUid: bundle.resourceUid },
    handlers: ["fetch"],
    containerBindings: [
      { name: "LEGACY", resource: { resourceUid: first.resourceUid } },
      { name: "APP", resource: { resourceUid: second.resourceUid } },
    ],
  };
  const version = await f.create(CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL, "version", spec);
  return { f, worker, bundle, first, second, spec, version };
}

test("Version 0.8.0 seals each binding against its exact Container Form and the reader returns each pair", async () => {
  const { f, first, second, version } = await mixedGraph();
  try {
    const sealed = f.db
      .query(
        "SELECT target_uid, form_url FROM tf_v2_operation_references WHERE operation_id = ? ORDER BY target_uid",
      )
      .all(version.id) as { target_uid: string; form_url: string }[];
    const formOf = (uid: string) => sealed.find((row) => row.target_uid === uid)?.form_url;
    expect(formOf(first.resourceUid)).toBe(CONTAINER_0_1_FORM_URL);
    expect(formOf(second.resourceUid)).toBe(CONTAINER_0_2_FORM_URL);
    expect(await f.reader(f.claimFor(version, "LEGACY", first.resourceUid))).toEqual({
      principal: PRINCIPAL,
      space: SPACE,
      targetKey: TARGET,
      workerVersionUid: version.resourceUid,
      workerVersionFormUrl: CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL,
      workerVersionGeneration: 1,
      sourceOperationId: version.id,
      targetUid: first.resourceUid,
      targetFormUrl: C.formUrl,
      targetGeneration: 1,
      targetSourceOperationId: first.id,
    });
    expect(await f.reader(f.claimFor(version, "APP", second.resourceUid))).toEqual({
      principal: PRINCIPAL,
      space: SPACE,
      targetKey: TARGET,
      workerVersionUid: version.resourceUid,
      workerVersionFormUrl: CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL,
      workerVersionGeneration: 1,
      sourceOperationId: version.id,
      targetUid: second.resourceUid,
      targetFormUrl: CONTAINER_0_2_FORM_URL,
      targetGeneration: 1,
      targetSourceOperationId: second.id,
    });
    // A binding name cannot select the other binding's target, and authority is rechecked.
    expect(await f.reader(f.claimFor(version, "APP", first.resourceUid))).toBeNull();
    expect(await f.reader(f.claimFor(version, "LEGACY", second.resourceUid))).toBeNull();
    f.setAllowed(false);
    expect(await f.reader(f.claimFor(version, "APP", second.resourceUid))).toBeNull();
  } finally {
    f.close();
  }
});

test("Version 0.7.0 still seals Container 0.1.0 only and refuses a Container 0.2.0 target before any effect", async () => {
  const f = await containerConsumerFixture();
  try {
    const worker = await f.create(MODULE_WORKER_FORM_URL, "worker");
    const bundle = await f.create(WORKER_BUNDLE_FORM_URL, "bundle");
    const legacy = await f.create(CONTAINER_0_1_FORM_URL, "container-one");
    const next = await f.create(CONTAINER_0_2_FORM_URL, "container-two");
    const base = {
      worker: { resourceUid: worker.resourceUid },
      bundle: { resourceUid: bundle.resourceUid },
      handlers: ["fetch"],
    };
    const resourcesBefore = f.count("tf_v2_resources");
    const operationsBefore = f.count("tf_v2_operations");
    const referencesBefore = f.count("tf_v2_operation_references");
    const refused = await f.refuse(FORWARD_WORKER_VERSION_FORM_URL, "old-version", {
      ...base,
      containerBindings: [{ name: "APP", resource: { resourceUid: next.resourceUid } }],
    });
    expect(refused).toMatchObject({ code: "dependency_conflict" });
    // Refused at acceptance: no Version Resource, Operation or sealed reference was created.
    expect(f.count("tf_v2_resources")).toBe(resourcesBefore);
    expect(f.count("tf_v2_operations")).toBe(operationsBefore);
    expect(f.count("tf_v2_operation_references")).toBe(referencesBefore);
    // The same 0.7.0 Form with a Container 0.1.0 target keeps the previous pair exactly.
    const accepted = await f.create(FORWARD_WORKER_VERSION_FORM_URL, "old-version", {
      ...base,
      containerBindings: [{ name: "APP", resource: { resourceUid: legacy.resourceUid } }],
    });
    expect(await f.reader(f.claimFor(accepted, "APP", legacy.resourceUid))).toMatchObject({
      workerVersionFormUrl: FORWARD_WORKER_VERSION_FORM_URL,
      targetFormUrl: C.formUrl,
      targetUid: legacy.resourceUid,
    });
  } finally {
    f.close();
  }
});

test("Version 0.8.0 refuses any binding target that is not exactly Container 0.1.0 or 0.2.0", async () => {
  const f = await containerConsumerFixture();
  try {
    const worker = await f.create(MODULE_WORKER_FORM_URL, "worker");
    const bundle = await f.create(WORKER_BUNDLE_FORM_URL, "bundle");
    // A Container of an unlisted version exists and is live, yet is not an accepted target:
    // the Form must match exactly, never by "Container kind".
    const unlisted = await f.create(CONTAINER_0_3_FORM_URL, "container-three");
    const base = {
      worker: { resourceUid: worker.resourceUid },
      bundle: { resourceUid: bundle.resourceUid },
      handlers: ["fetch"],
    };
    const operations = f.count("tf_v2_operations");
    const references = f.count("tf_v2_operation_references");
    for (const resourceUid of [
      unlisted.resourceUid,
      bundle.resourceUid,
      worker.resourceUid,
      "absent-uid",
    ])
      for (const form of [
        CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL,
        FORWARD_WORKER_VERSION_FORM_URL,
      ]) {
        const refusal = await f.refuse(form, `bad-${form.length}-${resourceUid}`, {
          ...base,
          containerBindings: [{ name: "APP", resource: { resourceUid } }],
        });
        // 0.8.0 refuses at exact-reference admission. 0.7.0 may refuse earlier, at spec
        // reconciliation, when a bundle/worker UID is also required as a Container.
        expect(refusal).toMatchObject({
          code:
            form === CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL
              ? "dependency_conflict"
              : expect.stringMatching(/^(dependency_conflict|invalid_spec)$/u),
        });
      }
    // Refusal happens at acceptance: no Operation and no sealed reference was created.
    expect(f.count("tf_v2_operations")).toBe(operations);
    expect(f.count("tf_v2_operation_references")).toBe(references);
  } finally {
    f.close();
  }
});

test("a replacement UID never inherits the accepted pair, and a bound Container cannot be deleted", async () => {
  const { f, second, version } = await mixedGraph();
  try {
    // The bound Container cannot be deleted while a live Version references it.
    const deletion = await f.engine
      .acceptDelete({
        principal: PRINCIPAL,
        key: "container-consumer-delete-bound-key",
        uid: second.resourceUid,
        expectedGeneration: 1,
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(deletion).toMatchObject({ code: "dependency_conflict" });
    // A different Container 0.2.0 UID is not the sealed target for the APP binding.
    const replacement = await f.create(CONTAINER_0_2_FORM_URL, "replacement");
    expect(await f.reader(f.claimFor(version, "APP", replacement.resourceUid))).toBeNull();
    expect(await f.reader(f.claimFor(version, "APP", second.resourceUid))).not.toBeNull();
    // The Core schema makes a sealed reference immutable: its Form cannot be rewritten.
    expect(() =>
      f.db.exec(
        `UPDATE tf_v2_operation_references SET form_url = '${CONTAINER_0_1_FORM_URL}'
         WHERE operation_id = '${version.id}' AND target_uid = '${second.resourceUid}'`,
      ),
    ).toThrow("tf_v2_reference_immutable");
    expect(await f.reader(f.claimFor(version, "APP", second.resourceUid))).toMatchObject({
      targetFormUrl: CONTAINER_0_2_FORM_URL,
    });
  } finally {
    f.close();
  }
});

test("a committed Container 0.2.0 update changes only that target's committed source and keeps its Form", async () => {
  const { f, first, second, version } = await mixedGraph();
  try {
    const update = await f.engine.acceptUpdate({
      principal: PRINCIPAL,
      key: "container-consumer-update-two-key",
      uid: second.resourceUid,
      expectedGeneration: 1,
      spec: {},
    });
    expect((await f.engine.runNext())?.status).toBe("succeeded");
    expect(await f.reader(f.claimFor(version, "APP", second.resourceUid))).toMatchObject({
      workerVersionFormUrl: CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL,
      targetFormUrl: CONTAINER_0_2_FORM_URL,
      targetGeneration: 2,
      targetSourceOperationId: update.id,
    });
    // The sibling Container 0.1.0 binding is untouched by the other target's update.
    expect(await f.reader(f.claimFor(version, "LEGACY", first.resourceUid))).toMatchObject({
      targetFormUrl: C.formUrl,
      targetGeneration: 1,
      targetSourceOperationId: first.id,
    });
  } finally {
    f.close();
  }
});

test("a same-spec Version 0.8.0 update returns the new source and revokes the old accepted source", async () => {
  const { f, first, second, version, spec } = await mixedGraph();
  try {
    const update = await f.engine.acceptUpdate({
      principal: PRINCIPAL,
      key: "container-consumer-update-version-key",
      uid: version.resourceUid,
      expectedGeneration: 1,
      spec,
    });
    expect((await f.engine.runNext())?.status).toBe("succeeded");
    const latest = f.claimFor(
      { resourceUid: version.resourceUid, id: update.id },
      "APP",
      second.resourceUid,
      2,
    );
    expect(await f.reader(latest)).toMatchObject({
      workerVersionFormUrl: CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL,
      workerVersionGeneration: 2,
      sourceOperationId: update.id,
      targetFormUrl: CONTAINER_0_2_FORM_URL,
    });
    expect(await f.reader(f.claimFor(version, "APP", second.resourceUid, 1))).toBeNull();
    expect(
      await f.reader(
        f.claimFor(
          { resourceUid: version.resourceUid, id: update.id },
          "LEGACY",
          first.resourceUid,
          2,
        ),
      ),
    ).toMatchObject({ targetFormUrl: CONTAINER_0_1_FORM_URL, workerVersionGeneration: 2 });
  } finally {
    f.close();
  }
});

test("Deployment 0.7.0 admission looks up each Version by exact Form and refuses anything else", async () => {
  const spec = {
    worker: { resourceUid: "worker" },
    versions: [{ workerVersion: { resourceUid: "version" }, weight: 10000 }],
  };
  const admission = { sql: "1", params: [] } as never;
  type Lookup = (uid: string) => Promise<{ resourceUid: string; formUrl: string } | null>;
  /** What the preparation asks Core to seal for a Version whose live Form is `formUrl`. */
  const sealedFor = async (
    formUrl: string | null,
    form: string = CONTAINER_CONSUMER_WORKER_DEPLOYMENT_FORM_URL,
  ) => {
    let produced: unknown = "not-called";
    await prepareContainerConsumerWorkerDeploymentReferences(
      {
        form,
        spec,
        prepareExactReferences: async (read: (lookup: Lookup) => Promise<unknown>) => {
          produced = await read(async (resourceUid) =>
            formUrl === null ? null : { resourceUid, formUrl },
          );
          return null;
        },
      } as never,
      admission,
    );
    return produced;
  };
  for (const formUrl of [
    "https://edge.forms.takoform.com/forms/WorkerVersion/0.5.0/",
    "https://edge.forms.takoform.com/forms/WorkerVersion/0.6.0/",
    FORWARD_WORKER_VERSION_FORM_URL,
    CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL,
  ])
    expect(await sealedFor(formUrl)).toEqual([
      {
        resourceUid: "version",
        formUrl,
        readiness: "ready",
        targetSpecMatch: { path: ["worker", "resourceUid"], equals: "worker" },
      },
    ]);
  for (const formUrl of [
    "https://edge.forms.takoform.com/forms/WorkerVersion/0.4.0/",
    "https://edge.forms.takoform.com/forms/WorkerVersion/0.9.0/",
    CONTAINER_0_2_FORM_URL,
    null,
  ])
    expect(await sealedFor(formUrl)).toBeNull();
  // A Deployment 0.6.0 input, or a missing preparation capability, is not prepared at all.
  expect(
    await sealedFor(CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL, FORWARD_WORKER_DEPLOYMENT_FORM_URL),
  ).toBe("not-called");
  expect(
    await prepareContainerConsumerWorkerDeploymentReferences(
      { form: CONTAINER_CONSUMER_WORKER_DEPLOYMENT_FORM_URL, spec } as never,
      admission,
    ),
  ).toBeNull();
  expect(
    await prepareContainerConsumerWorkerVersionReferences({
      form: CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL,
      spec: {},
    } as never),
  ).toBeNull();
});

test("reference reconstruction accepts only sealed Container 0.1.0/0.2.0 and sealed Deployment Version Forms", () => {
  const spec = parseContainerConsumerWorkerVersionSpec({
    worker: { resourceUid: "worker" },
    bundle: { resourceUid: "bundle" },
    handlers: ["fetch"],
    containerBindings: [
      { name: "A", resource: { resourceUid: "one" } },
      { name: "B", resource: { resourceUid: "two" } },
    ],
  });
  expect(spec).toEqual(
    parseForwardWorkerVersionSpec({
      worker: { resourceUid: "worker" },
      bundle: { resourceUid: "bundle" },
      handlers: ["fetch"],
      containerBindings: [
        { name: "B", resource: { resourceUid: "two" } },
        { name: "A", resource: { resourceUid: "one" } },
      ],
    }),
  );
  const sealed = [
    { resourceUid: "one", formUrl: CONTAINER_0_1_FORM_URL },
    { resourceUid: "two", formUrl: CONTAINER_0_2_FORM_URL },
  ];
  const refs = referencesForContainerConsumerWorkerVersion(spec, sealed);
  expect(refs.filter((ref) => ref.resourceUid === "one")[0]?.formUrl).toBe(CONTAINER_0_1_FORM_URL);
  expect(refs.filter((ref) => ref.resourceUid === "two")[0]?.formUrl).toBe(CONTAINER_0_2_FORM_URL);
  for (const bad of [
    [{ resourceUid: "one", formUrl: CONTAINER_0_1_FORM_URL }],
    [...sealed, { resourceUid: "two", formUrl: CONTAINER_0_1_FORM_URL }],
    [
      sealed[0],
      { resourceUid: "two", formUrl: "https://edge.forms.takoform.com/forms/Container/0.3.0/" },
    ],
    [sealed[0], { resourceUid: "two", formUrl: WORKER_BUNDLE_FORM_URL }],
  ] as const)
    expect(() =>
      referencesForContainerConsumerWorkerVersion(spec, bad as unknown as typeof sealed),
    ).toThrow();

  const deployment = {
    worker: { resourceUid: "worker" },
    versions: [{ workerVersion: { resourceUid: "v8" }, weight: 10000 }],
  };
  const deploymentOk = referencesForContainerConsumerWorkerDeployment(deployment, [
    { resourceUid: "v8", formUrl: CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL },
  ]);
  expect(deploymentOk.find((ref) => ref.resourceUid === "v8")).toMatchObject({
    formUrl: CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL,
    readiness: "ready",
    targetSpecMatch: { path: ["worker", "resourceUid"], equals: "worker" },
  });
  for (const formUrl of [
    WORKER_VERSION_FORM_URL,
    "https://edge.forms.takoform.com/forms/WorkerVersion/0.6.0/",
    FORWARD_WORKER_VERSION_FORM_URL,
  ])
    expect(() =>
      referencesForContainerConsumerWorkerDeployment(deployment, [{ resourceUid: "v8", formUrl }]),
    ).not.toThrow();
  expect(() =>
    referencesForContainerConsumerWorkerDeployment(deployment, [
      { resourceUid: "v8", formUrl: "https://edge.forms.takoform.com/forms/WorkerVersion/0.9.0/" },
    ]),
  ).toThrow();
  // The previous Deployment 0.6.0 reconstruction keeps refusing a 0.8.0 Version.
  expect(() =>
    referencesForForwardWorkerDeployment(deployment, [
      { resourceUid: "v8", formUrl: CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL },
    ]),
  ).toThrow();
});
