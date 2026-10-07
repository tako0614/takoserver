import { expect, test } from "bun:test";
import { bytesDigest } from "../src/json.ts";
import type { JsonObject } from "../src/ports.ts";
import {
  parseWorkerBundleManifest,
  validateWorkerBundlePayload,
} from "../src/takoform-v2/forms/worker-bundle.ts";
import {
  inspectV2WorkerCodeVersionEligibility,
  projectV2WorkerCodeVersion,
} from "../src/takoform-v2/worker-code-runtime.ts";

const encoded = new TextEncoder();
const moduleBytes = encoded.encode("export default { fetch() { return new Response('ok'); } };\n");
const modulePath = "index.js";
const spec = {
  worker: { resourceUid: "worker-one" },
  bundle: { resourceUid: "bundle-one" },
  handlers: ["fetch"],
  workflowBindings: [{ name: "FLOW", resource: { resourceUid: "workflow-one" } }],
};
const resolvedWorkflowBindings = [{ name: "FLOW", resourceUid: "workflow-one" }];
const workflowForward = [
  {
    publicName: "FLOW",
    tenantId: "org:one",
    workflowResourceUid: "workflow-one",
    token: "a".repeat(64),
  },
];

async function bundle() {
  const digest = (await bytesDigest(moduleBytes)).slice("sha256:".length);
  const manifestBytes = encoded.encode(
    JSON.stringify({
      entrypoint: modulePath,
      files: [
        {
          path: modulePath,
          url: "https://artifacts.example.test/index.js",
          sha256: digest,
          mediaType: "application/javascript+module",
        },
      ],
    }),
  );
  const manifest = parseWorkerBundleManifest(manifestBytes);
  const spec = {
    artifact: {
      url: "https://artifacts.example.test/manifest.json",
      sha256: (await bytesDigest(manifestBytes)).slice("sha256:".length),
    },
  };
  const verified = await validateWorkerBundlePayload({
    spec,
    manifestBytes,
    fileBytes: [moduleBytes],
  });
  return {
    manifest,
    manifestBytes,
    files: [moduleBytes],
    observed: verified.observed as unknown as JsonObject,
  };
}

test("held Workflow module admits only exact accepted ref, with a separate Host-issued native grant", async () => {
  const held = await bundle();
  const base = {
    workerResourceUid: "worker-one",
    bundleResourceUid: "bundle-one",
    spec,
    bundle: held,
    inspectModule: async () => ({
      outcome: "valid" as const,
      exportedHandlers: ["fetch" as const],
    }),
  };
  await expect(inspectV2WorkerCodeVersionEligibility(base)).rejects.toMatchObject({
    code: "worker_binding_unavailable",
  });
  await expect(
    inspectV2WorkerCodeVersionEligibility({
      ...base,
      resolvedWorkflowBindings,
    }),
  ).resolves.toBeUndefined();
  const identity = {
    directory: "worker-one",
    hostnames: [],
    generation: "one",
    workerResourceUid: "worker-one",
    workerVersionUid: "version-one",
    versionId: "native-one",
    weight: 10_000,
    bundleResourceUid: "bundle-one",
  };
  await expect(
    projectV2WorkerCodeVersion({
      ...base,
      identity,
      resolvedWorkflowBindings,
    }),
  ).rejects.toMatchObject({ code: "worker_binding_unavailable" });
  await expect(
    projectV2WorkerCodeVersion({
      ...base,
      identity,
      resolvedWorkflowBindings,
      workflowForward,
    }),
  ).resolves.toMatchObject({ versionId: "native-one" });
  const firstForward = workflowForward[0];
  if (!firstForward) throw new Error("Workflow grant unavailable");
  await expect(
    projectV2WorkerCodeVersion({
      ...base,
      identity,
      resolvedWorkflowBindings,
      workflowForward: [{ ...firstForward, workflowResourceUid: "other" }],
    }),
  ).rejects.toMatchObject({ code: "worker_binding_unavailable" });
});
