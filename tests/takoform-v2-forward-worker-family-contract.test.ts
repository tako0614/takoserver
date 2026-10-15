import { expect, test } from "bun:test";
import {
  createObjectBucketStreamForm,
  type ObjectBucketStore,
} from "../src/takoform-v2/forms/object-bucket-backend.ts";
import { OBJECT_BUCKET_EOF_COUNTED_FORM_URL } from "../src/takoform-v2/forms/object-bucket-binding-profile.ts";
import {
  fixedReferencesForForwardWorkerVersion,
  referencesForForwardWorkerVersion,
  referencesForWorkerVersion,
} from "../src/takoform-v2/forms/worker-references.ts";
import {
  FORWARD_WORKER_DEPLOYMENT_FORM_URL,
  FORWARD_WORKER_VERSION_FORM_URL,
  parseForwardWorkerDeploymentSpec,
  parseForwardWorkerVersionSpec,
  parseWorkerVersionSpec,
  validateForwardWorkerVersionUpdate,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import type { V2Execution } from "../src/takoform-v2/types.ts";
import { createForwardWorkerDeploymentForm } from "../src/takoform-v2/worker-deployment-backend.ts";
import { createInternalV2ForwardWorkerVersionForm } from "../src/takoform-v2/worker-lifecycle-backend.ts";

const spec = {
  worker: { resourceUid: "worker" },
  bundle: { resourceUid: "bundle" },
  handlers: ["fetch"],
  bucketBindings: [{ name: "BUCKET", resource: { resourceUid: "bucket" } }],
};
function execution(form: string, backendId: string): V2Execution {
  return {
    operationId: "operation",
    leaseToken: "lease",
    backendKey: "backend",
    backendId,
    targetKey: "target",
    resourceUid: "resource",
    principal: "alice",
    action: "create",
    generation: 1,
    form,
    space: "space",
    name: "name",
    spec: {},
    previousObserved: {},
    previousOutput: {},
  };
}

test("forward family parser retains the old grammar and validates inherited Container names without runtime claims", () => {
  expect(parseForwardWorkerVersionSpec(spec).containerBindings).toEqual([]);
  expect(() => parseWorkerVersionSpec({ ...spec, containerBindings: [] })).toThrow();
  expect(
    parseForwardWorkerVersionSpec({
      ...spec,
      containerBindings: [{ name: "APP", resource: { resourceUid: "container" } }],
    }).containerBindings,
  ).toEqual([{ name: "APP", resource: { resourceUid: "container" } }]);
  expect(() =>
    parseForwardWorkerVersionSpec({
      ...spec,
      containerBindings: [{ name: "BUCKET", resource: { resourceUid: "container" } }],
    }),
  ).toThrow();
  expect(() => parseForwardWorkerVersionSpec({ ...spec, containerBindings: null })).toThrow();
  expect(() =>
    parseForwardWorkerVersionSpec({ ...spec, preferredForm: OBJECT_BUCKET_EOF_COUNTED_FORM_URL }),
  ).toThrow();
  expect(() =>
    validateForwardWorkerVersionUpdate(spec, {
      ...spec,
      containerBindings: [{ name: "APP", resource: { resourceUid: "container" } }],
    }),
  ).toThrow();
  expect(() =>
    parseForwardWorkerDeploymentSpec({
      worker: { resourceUid: "worker" },
      versions: [{ workerVersion: { resourceUid: "version" }, weight: 9999 }],
    }),
  ).toThrow();
});

test("forward family fixed references omit only variable choices and old reference identity stays exact", () => {
  const parsed = parseForwardWorkerVersionSpec({
    ...spec,
    containerBindings: [{ name: "APP", resource: { resourceUid: "container" } }],
  });
  const fixed = fixedReferencesForForwardWorkerVersion(parsed);
  expect(fixed.some((row) => row.resourceUid === "bucket")).toBe(false);
  expect(fixed.find((row) => row.resourceUid === "container")?.formUrl).toBe(
    "https://edge.forms.takoform.com/forms/Container/0.1.0/",
  );
  expect(
    referencesForWorkerVersion(parseWorkerVersionSpec(spec)).find(
      (row) => row.resourceUid === "bucket",
    )?.formUrl,
  ).toBe("https://edge.forms.takoform.com/forms/ObjectBucket/0.2.0/");
  expect(
    referencesForForwardWorkerVersion(parsed, [
      { resourceUid: "bucket", formUrl: OBJECT_BUCKET_EOF_COUNTED_FORM_URL },
    ]).find((row) => row.resourceUid === "bucket")?.formUrl,
  ).toBe(OBJECT_BUCKET_EOF_COUNTED_FORM_URL);
  expect(() =>
    referencesForForwardWorkerVersion(parsed, [
      { resourceUid: "bucket", formUrl: WORKER_VERSION_FORM_URL },
    ]),
  ).toThrow();
});

test("forward family missing Core preparation refuses admission instead of accepting caller profile metadata", async () => {
  const version = createInternalV2ForwardWorkerVersionForm({ targetKey: "target" });
  const deployment = createForwardWorkerDeploymentForm({ targetKey: "target" });
  if (!version.prepareAdmission || !deployment.prepareAdmission)
    throw new Error("missing prepare hook");
  expect(
    await version.prepareAdmission({
      action: "create",
      principal: "alice",
      space: "space",
      form: FORWARD_WORKER_VERSION_FORM_URL,
      resourceUid: "version",
      spec,
    }),
  ).toBeNull();
  expect(
    await deployment.prepareAdmission({
      action: "create",
      principal: "alice",
      space: "space",
      form: FORWARD_WORKER_DEPLOYMENT_FORM_URL,
      resourceUid: "deployment",
      spec: {
        worker: { resourceUid: "worker" },
        versions: [{ workerVersion: { resourceUid: "version" }, weight: 10000 }],
      },
    }),
  ).toBeNull();
  expect(() => version.validateCreate({ ...spec, requiredSensitiveVars: ["SECRET"] })).toThrow();
});

test("forward family constructors retain unsupported native execution despite asserted Form and profiles", async () => {
  let sends = 0;
  const store: ObjectBucketStore = {
    async create() {
      sends++;
      return "ready";
    },
    async reconcileCreate() {
      sends++;
      return "ready";
    },
    async observe() {
      sends++;
      return "ready";
    },
    async delete() {
      sends++;
      return "deleted";
    },
  };
  const bucket = createObjectBucketStreamForm(
    Object.assign(
      { store, targetKey: "target" },
      { form: OBJECT_BUCKET_EOF_COUNTED_FORM_URL, profile: "eof-counted" },
    ),
  );
  expect(
    await bucket.backend.execute(execution(OBJECT_BUCKET_EOF_COUNTED_FORM_URL, bucket.backend.id)),
  ).toMatchObject({ kind: "unknown", code: "object_bucket_forward_body_profile_unavailable" });
  expect(sends).toBe(0);
  const version = createInternalV2ForwardWorkerVersionForm({ targetKey: "target" });
  const deployment = createForwardWorkerDeploymentForm({ targetKey: "target" });
  expect(
    await version.backend.execute(execution(FORWARD_WORKER_VERSION_FORM_URL, version.backend.id)),
  ).toMatchObject({ kind: "unknown", code: "worker_forward_materializer_unavailable" });
  expect(
    await deployment.backend.execute(
      execution(FORWARD_WORKER_DEPLOYMENT_FORM_URL, deployment.backend.id),
    ),
  ).toMatchObject({ kind: "unknown", code: "worker_forward_materializer_unavailable" });
});
