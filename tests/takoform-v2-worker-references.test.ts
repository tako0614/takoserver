import { expect, test } from "bun:test";
import { STATIC_ASSET_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/static-asset-bundle.ts";
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";
import {
  referencesForModuleWorker,
  referencesForWorkerDeployment,
  referencesForWorkerEndpoint,
  referencesForWorkerForm,
  referencesForWorkerVersion,
} from "../src/takoform-v2/forms/worker-references.ts";
import {
  MODULE_WORKER_FORM_URL,
  parseWorkerDeploymentSpec,
  parseWorkerEndpointSpec,
  parseWorkerVersionSpec,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import type { V2ReferenceRequirement } from "../src/takoform-v2/types.ts";

test("WorkerVersion declares its complete exact direct reference set", () => {
  const parsed = parseWorkerVersionSpec({
    worker: { resourceUid: "module-owner" },
    bundle: { resourceUid: "worker-bundle" },
    handlers: ["fetch"],
    assets: {
      bundle: { resourceUid: "static-assets" },
      runWorkerFirst: true,
      notFoundHandling: "none",
    },
    kvBindings: [{ name: "CACHE", resource: { resourceUid: "kv" } }],
    sqliteBindings: [{ name: "DB", resource: { resourceUid: "db" } }],
    bucketBindings: [{ name: "BUCKET", resource: { resourceUid: "bucket" } }],
    queueProducerBindings: [{ name: "QUEUE", resource: { resourceUid: "queue" } }],
    serviceBindings: [{ name: "SERVICE", resource: { resourceUid: "service" } }],
    actorBindings: [{ name: "ACTOR", resource: { resourceUid: "actor" } }],
    workflowBindings: [{ name: "WORKFLOW", resource: { resourceUid: "workflow" } }],
  });

  expect(referencesForWorkerVersion(parsed)).toEqual([
    {
      resourceUid: "actor",
      formUrl: "https://edge.forms.takoform.com/forms/ActorNamespace/0.3.0/",
      readiness: "observed",
    },
    {
      resourceUid: "bucket",
      formUrl: "https://edge.forms.takoform.com/forms/ObjectBucket/0.2.0/",
      readiness: "observed",
    },
    {
      resourceUid: "db",
      formUrl: "https://edge.forms.takoform.com/forms/SQLiteDatabase/0.2.0/",
      readiness: "observed",
    },
    {
      resourceUid: "kv",
      formUrl: "https://edge.forms.takoform.com/forms/EdgeKVNamespace/0.2.0/",
      readiness: "observed",
    },
    { resourceUid: "module-owner", formUrl: MODULE_WORKER_FORM_URL, readiness: "observed" },
    {
      resourceUid: "queue",
      formUrl: "https://edge.forms.takoform.com/forms/AtLeastOnceQueue/0.2.0/",
      readiness: "observed",
    },
    { resourceUid: "service", formUrl: MODULE_WORKER_FORM_URL, readiness: "observed" },
    { resourceUid: "static-assets", formUrl: STATIC_ASSET_BUNDLE_FORM_URL, readiness: "observed" },
    { resourceUid: "worker-bundle", formUrl: WORKER_BUNDLE_FORM_URL, readiness: "observed" },
    {
      resourceUid: "workflow",
      formUrl: "https://edge.forms.takoform.com/forms/DurableWorkflow/0.3.0/",
      readiness: "observed",
    },
  ] satisfies readonly V2ReferenceRequirement[]);
});

test("WorkerVersion omits absent assets and deduplicates a shared owner binding", () => {
  const parsed = parseWorkerVersionSpec({
    worker: { resourceUid: "shared" },
    bundle: { resourceUid: "bundle" },
    handlers: [],
    serviceBindings: [{ name: "SELF", resource: { resourceUid: "shared" } }],
  });

  expect(referencesForWorkerVersion(parsed)).toEqual([
    { resourceUid: "bundle", formUrl: WORKER_BUNDLE_FORM_URL, readiness: "observed" },
    { resourceUid: "shared", formUrl: MODULE_WORKER_FORM_URL, readiness: "observed" },
  ]);
});

test("conflicting Forms for one repeated UID are rejected instead of hidden", () => {
  const parsed = parseWorkerVersionSpec({
    worker: { resourceUid: "same" },
    bundle: { resourceUid: "same" },
    handlers: ["fetch"],
  });

  expect(() => referencesForWorkerVersion(parsed)).toThrow(
    expect.objectContaining({ code: "invalid_spec" }),
  );
});

test("Deployment binds exact WorkerVersion Form, readiness, and owner-spec relation", () => {
  const parsed = parseWorkerDeploymentSpec({
    worker: { resourceUid: "module-owner" },
    versions: [
      { workerVersion: { resourceUid: "version-a" }, weight: 4_000 },
      { workerVersion: { resourceUid: "version-b" }, weight: 6_000 },
    ],
  });

  expect(referencesForWorkerDeployment(parsed)).toEqual([
    { resourceUid: "module-owner", formUrl: MODULE_WORKER_FORM_URL, readiness: "observed" },
    {
      resourceUid: "version-a",
      formUrl: WORKER_VERSION_FORM_URL,
      readiness: "ready",
      targetSpecMatch: { path: ["worker", "resourceUid"], equals: "module-owner" },
    },
    {
      resourceUid: "version-b",
      formUrl: WORKER_VERSION_FORM_URL,
      readiness: "ready",
      targetSpecMatch: { path: ["worker", "resourceUid"], equals: "module-owner" },
    },
  ] satisfies readonly V2ReferenceRequirement[]);
});

test("Endpoint observes its exact ModuleWorker target; ModuleWorker has no references", () => {
  expect(
    referencesForWorkerEndpoint(parseWorkerEndpointSpec({ worker: { resourceUid: "owner" } })),
  ).toEqual([{ resourceUid: "owner", formUrl: MODULE_WORKER_FORM_URL, readiness: "observed" }]);
  expect(referencesForModuleWorker({})).toEqual([]);
});

test("exact Worker Form dispatcher parses its schema and rejects unknown Form identity", () => {
  const input = { worker: { resourceUid: "owner" } };
  expect(referencesForWorkerForm(WORKER_ENDPOINT_FORM_URL, input)).toEqual([
    { resourceUid: "owner", formUrl: MODULE_WORKER_FORM_URL, readiness: "observed" },
  ]);
  expect(
    referencesForWorkerForm(WORKER_DEPLOYMENT_FORM_URL, {
      worker: { resourceUid: "owner" },
      versions: [{ workerVersion: { resourceUid: "version" }, weight: 10_000 }],
    }),
  ).toEqual([
    { resourceUid: "owner", formUrl: MODULE_WORKER_FORM_URL, readiness: "observed" },
    {
      resourceUid: "version",
      formUrl: WORKER_VERSION_FORM_URL,
      readiness: "ready",
      targetSpecMatch: { path: ["worker", "resourceUid"], equals: "owner" },
    },
  ]);
  expect(() => referencesForWorkerForm("https://example.test/other/1/", input)).toThrow(
    expect.objectContaining({ code: "invalid_spec" }),
  );
});
