import { expect, test } from "bun:test";
import { formLabel, KNOWN_FORM_GROUPS } from "../console/src/forms.ts";
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
