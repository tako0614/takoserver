import { expect, test } from "bun:test";
import {
  blankPaths,
  pathLabel,
  type ReferenceSlot,
  slotLabel,
  starterSpec,
  valueAt,
  withValueAt,
} from "../console/src/form-specs.ts";
import { KNOWN_FORM_GROUPS } from "../console/src/forms.ts";
import {
  parseActorNamespaceSpec,
  referencesForActorNamespace,
} from "../src/takoform-v2/forms/actor-namespace.ts";
import { parseAtLeastOnceQueueSpec } from "../src/takoform-v2/forms/at-least-once-queue.ts";
import {
  durableWorkflowReferences,
  parseDurableWorkflowSpec,
} from "../src/takoform-v2/forms/durable-workflow.ts";
import { parseEdgeKVNamespaceSpec } from "../src/takoform-v2/forms/edge-kv-namespace.ts";
import { parseObjectBucketSpec } from "../src/takoform-v2/forms/object-bucket.ts";
import {
  parseQueueConsumerSpec,
  queueConsumerReferences,
} from "../src/takoform-v2/forms/queue-consumer.ts";
import { parseSQLiteDatabaseSpec } from "../src/takoform-v2/forms/sqlite-database.ts";
import {
  parseSQLiteMigrationApplicationSpec,
  sqliteMigrationApplicationReferences,
} from "../src/takoform-v2/forms/sqlite-migration-application.ts";
import { parseSQLiteMigrationSetSpec } from "../src/takoform-v2/forms/sqlite-migration-set.ts";
import { parseStaticAssetBundleSpec } from "../src/takoform-v2/forms/static-asset-bundle.ts";
import { parseWorkerBundleSpec } from "../src/takoform-v2/forms/worker-bundle.ts";
import {
  parseWorkerCronTriggerSpec,
  workerCronTriggerReferences,
} from "../src/takoform-v2/forms/worker-cron-trigger.ts";
import {
  referencesForWorkerDeployment,
  referencesForWorkerEndpoint,
  referencesForWorkerVersion,
} from "../src/takoform-v2/forms/worker-references.ts";
import {
  parseModuleWorkerSpec,
  parseWorkerDeploymentSpec,
  parseWorkerEndpointSpec,
  parseWorkerVersionSpec,
} from "../src/takoform-v2/forms/worker-specs.ts";
import type { V2ReferenceRequirement } from "../src/takoform-v2/types.ts";

type Check = (spec: unknown) => readonly V2ReferenceRequirement[];
const none =
  (parse: (spec: unknown) => unknown): Check =>
  (spec) => {
    parse(spec);
    return [];
  };

/** This Host's own parser and reference rules for each Form the Console offers. */
const HOST: Record<string, Check> = {
  "WorkerBundle/0.2.0": none(parseWorkerBundleSpec),
  "StaticAssetBundle/0.2.0": none(parseStaticAssetBundleSpec),
  "SQLiteMigrationSet/0.2.0": none(parseSQLiteMigrationSetSpec),
  "ModuleWorker/0.3.0": none(parseModuleWorkerSpec),
  "WorkerVersion/0.5.0": (spec) => referencesForWorkerVersion(parseWorkerVersionSpec(spec)),
  "WorkerDeployment/0.4.0": (spec) =>
    referencesForWorkerDeployment(parseWorkerDeploymentSpec(spec)),
  "WorkerCronTrigger/0.3.0": (spec) =>
    workerCronTriggerReferences(parseWorkerCronTriggerSpec(spec)),
  "WorkerEndpoint/0.3.0": (spec) => referencesForWorkerEndpoint(parseWorkerEndpointSpec(spec)),
  "SQLiteDatabase/0.2.0": none(parseSQLiteDatabaseSpec),
  "SQLiteMigrationApplication/0.2.0": (spec) =>
    sqliteMigrationApplicationReferences(parseSQLiteMigrationApplicationSpec(spec)),
  "EdgeKVNamespace/0.2.0": none(parseEdgeKVNamespaceSpec),
  "ObjectBucket/0.2.0": none(parseObjectBucketSpec),
  "AtLeastOnceQueue/0.2.0": none(parseAtLeastOnceQueueSpec),
  "QueueConsumer/0.3.0": (spec) => queueConsumerReferences(parseQueueConsumerSpec(spec)),
  "ActorNamespace/0.3.0": (spec) => referencesForActorNamespace(parseActorNamespaceSpec(spec)),
  "DurableWorkflow/0.3.0": (spec) => durableWorkflowReferences(parseDurableWorkflowSpec(spec)),
};

/** What a person would type into the starter's empty values. */
function filled(spec: Record<string, unknown>, references: readonly ReferenceSlot[]) {
  let next = structuredClone(spec);
  references.forEach((slot, index) => {
    next = withValueAt(next, slot.path, `uid-${index + 1}`) ?? next;
  });
  if ("artifact" in next)
    next.artifact = {
      url: "https://artifacts.example.com/v1/manifest.json",
      sha256: "a".repeat(64),
    };
  if ("className" in next) next.className = "ExampleClass";
  return next;
}

const offered = KNOWN_FORM_GROUPS.flatMap((group) => [...group.forms]);

test("has a starter for every Form the Console offers, and only those", () => {
  const keys = offered.map((url) => /\/forms\/(.+)\/$/u.exec(url)?.[1]);
  expect(keys.sort()).toEqual(Object.keys(HOST).sort());
  for (const url of offered) expect(starterSpec(url)).not.toBeNull();
  expect(starterSpec("https://forms.example/fixture-only/key-value/1.0.0/")).toBeNull();
});

test("each starter, once its empty values are filled, is a spec this Host accepts", () => {
  for (const url of offered) {
    const starter = starterSpec(url);
    if (!starter) throw new Error(`no starter for ${url}`);
    const host = HOST[/\/forms\/(.+)\/$/u.exec(url)?.[1] ?? ""];
    if (!host) throw new Error(`no Host check for ${url}`);
    const spec = filled(starter.spec, starter.references);
    const required = host(spec);
    // Every place the starter offers to fill is one the Host checks, with the same Form.
    expect(
      required.map((reference) => ({ uid: reference.resourceUid, form: reference.formUrl })),
    ).toEqual(
      starter.references.map((slot, index) => ({ uid: `uid-${index + 1}`, form: slot.form })),
    );
    // Left empty, a reference is something the Host refuses, so the Console must ask for it.
    if (starter.references.length > 0) expect(() => host(starter.spec)).toThrow();
  }
});

test("writes a chosen UID only into a place the spec still has", () => {
  const starter = starterSpec("https://edge.forms.takoform.com/forms/WorkerDeployment/0.4.0/");
  if (!starter) throw new Error("no WorkerDeployment starter");
  const slot = starter.references[1];
  if (!slot) throw new Error("no version slot");
  expect(slotLabel(slot)).toBe("versions[0].workerVersion");
  const chosen = withValueAt(starter.spec, slot.path, "uid-version");
  expect(valueAt(chosen, slot.path)).toBe("uid-version");
  // The starter itself is untouched.
  expect(valueAt(starter.spec, slot.path)).toBe("");
  // A person who removed the versions list does not get it back.
  expect(withValueAt({ worker: { resourceUid: "" } }, slot.path, "uid-version")).toBeNull();
});

test("names the places a starter still leaves empty, as a person reads them", () => {
  const starter = starterSpec("https://edge.forms.takoform.com/forms/QueueConsumer/0.3.0/");
  if (!starter) throw new Error("no QueueConsumer starter");
  expect(blankPaths(starter.spec).map(pathLabel)).toEqual(["queue", "worker"]);
  const bundle = starterSpec("https://edge.forms.takoform.com/forms/WorkerBundle/0.2.0/");
  expect(blankPaths(bundle?.spec).map(pathLabel)).toEqual(["artifact.url", "artifact.sha256"]);
  expect(blankPaths({ a: [{ b: "" }, { b: "x" }] }).map(pathLabel)).toEqual(["a[0].b"]);
  expect(blankPaths({})).toEqual([]);
});
