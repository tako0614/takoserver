import { expect, test } from "bun:test";
import { formLabel, formName, KNOWN_FORM_GROUPS } from "../console/src/forms.ts";
import { ACTOR_NAMESPACE_FORM_URL } from "../src/takoform-v2/forms/actor-namespace.ts";
import { AT_LEAST_ONCE_QUEUE_FORM_URL } from "../src/takoform-v2/forms/at-least-once-queue.ts";
import { EDGE_KV_NAMESPACE_FORM_URL } from "../src/takoform-v2/forms/edge-kv-namespace.ts";
import { OBJECT_BUCKET_FORM_URL } from "../src/takoform-v2/forms/object-bucket.ts";
import { QUEUE_CONSUMER_FORM_URL } from "../src/takoform-v2/forms/queue-consumer.ts";
import { SQLITE_DATABASE_FORM_URL } from "../src/takoform-v2/forms/sqlite-database.ts";
import { SQLITE_MIGRATION_APPLICATION_FORM_URL } from "../src/takoform-v2/forms/sqlite-migration-application.ts";
import { SQLITE_MIGRATION_SET_FORM_URL } from "../src/takoform-v2/forms/sqlite-migration-set.ts";
import { STATIC_ASSET_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/static-asset-bundle.ts";
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";
import { WORKER_CRON_TRIGGER_FORM_URL } from "../src/takoform-v2/forms/worker-cron-trigger.ts";
import {
  MODULE_WORKER_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import { DURABLE_WORKFLOW_FORM_URL } from "../src/workflow-v2-resource-authority.ts";

test("the Console asks about exactly the Forms the Host implements", () => {
  const offered = KNOWN_FORM_GROUPS.flatMap((group) => [...group.forms]);
  expect(new Set(offered).size).toBe(offered.length);
  expect([...offered].sort()).toEqual(
    [
      WORKER_BUNDLE_FORM_URL,
      STATIC_ASSET_BUNDLE_FORM_URL,
      SQLITE_MIGRATION_SET_FORM_URL,
      MODULE_WORKER_FORM_URL,
      WORKER_VERSION_FORM_URL,
      WORKER_DEPLOYMENT_FORM_URL,
      WORKER_CRON_TRIGGER_FORM_URL,
      WORKER_ENDPOINT_FORM_URL,
      SQLITE_DATABASE_FORM_URL,
      SQLITE_MIGRATION_APPLICATION_FORM_URL,
      EDGE_KV_NAMESPACE_FORM_URL,
      OBJECT_BUCKET_FORM_URL,
      AT_LEAST_ONCE_QUEUE_FORM_URL,
      QUEUE_CONSUMER_FORM_URL,
      ACTOR_NAMESPACE_FORM_URL,
      DURABLE_WORKFLOW_FORM_URL,
    ].sort(),
  );
});

test("names a Form by kind and version", () => {
  expect(formLabel(MODULE_WORKER_FORM_URL)).toBe("ModuleWorker 0.3.0");
  expect(formLabel("https://forms.example.test/Widget/1.0.0")).toBe(
    "https://forms.example.test/Widget/1.0.0",
  );
});

test("reads a Form in a list by kind and version, naming any other host", () => {
  expect(formName(WORKER_BUNDLE_FORM_URL)).toBe("WorkerBundle 0.2.0");
  expect(formName("https://forms.example.com/forms/Widget/1.0.0/")).toBe(
    "forms.example.com · Widget 1.0.0",
  );
  expect(formName("https://forms.example.test/Widget/1.0.0")).toBe(
    "https://forms.example.test/Widget/1.0.0",
  );
});

test("never reads two different Form URLs the same", () => {
  const urls = [
    "https://edge.forms.takoform.com/forms/X/1.0.0/",
    "https://edge.forms.takoform.com/preview/forms/X/1.0.0/",
    "https://EDGE.forms.takoform.com/forms/X/1.0.0/",
    "https://edge.forms.takoform.com:443/forms/X/1.0.0/",
    "https://h.example/a/forms/X/1/",
    "https://h.example/b/forms/X/1/",
  ];
  expect(new Set(urls.map(formName)).size).toBe(urls.length);
  expect(formName(urls[0] as string)).toBe("X 1.0.0");
});

test("the list filter matches the Form as people read it", async () => {
  const { matchingResources } = await import("../console/src/resource-state.ts");
  const resource = (name: string, form: string) => ({
    uid: name,
    form,
    space: "org",
    name,
    generation: 1,
    observedGeneration: 1,
    observedAt: null,
    phase: "idle" as const,
    spec: {},
    observed: {},
    output: {},
    lastOperation: `op-${name}`,
  });
  const all = [
    resource("hello-deployment", WORKER_DEPLOYMENT_FORM_URL),
    resource("notes", SQLITE_DATABASE_FORM_URL),
  ];
  const names = (term: string) => matchingResources(all, term).map((entry) => entry.name);
  expect(names("WorkerDeployment 0.4.0")).toEqual(["hello-deployment"]);
  expect(names("sqlitedatabase 0.2")).toEqual(["notes"]);
  expect(names("edge.forms.takoform.com/forms/SQLite")).toEqual(["notes"]);
  expect(names("  ")).toEqual(["hello-deployment", "notes"]);
});
