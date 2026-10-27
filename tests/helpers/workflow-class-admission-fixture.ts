import { bytesDigest } from "../../src/json.ts";
import type { JsonObject, Sql } from "../../src/ports.ts";
import { createTakoformV2Engine } from "../../src/takoform-v2/engine.ts";
import { DURABLE_WORKFLOW_FORM_URL } from "../../src/takoform-v2/forms/durable-workflow.ts";
import { WORKER_BUNDLE_FORM_URL } from "../../src/takoform-v2/forms/worker-bundle.ts";
import { createWorkerBundleHost } from "../../src/takoform-v2/forms/worker-bundle-backend.ts";
import {
  referencesForWorkerDeployment,
  referencesForWorkerVersion,
} from "../../src/takoform-v2/forms/worker-references.ts";
import {
  MODULE_WORKER_FORM_URL,
  parseWorkerDeploymentSpec,
  parseWorkerVersionSpec,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../../src/takoform-v2/forms/worker-specs.ts";
import type { V2Form } from "../../src/takoform-v2/types.ts";
import { createDurableWorkflowForm } from "../../src/takoform-v2/workflow-backend.ts";
import { createV2WorkflowClassAdmission } from "../../src/takoform-v2/workflow-class-admission.ts";
import { createWorkflowRuntime } from "../../src/workflow-execution.ts";
import { createV2WorkflowResourceAuthority } from "../../src/workflow-v2-resource-authority.ts";

export const PRINCIPAL = "org:workflow-admission";
const SPACE = "production";
export const TARGET = "workflow-admission-local-target";
export const SPEC_CLASS = "ReportWorkflow";

export function createWorkflowAdmissionFixture(sql: Sql) {
  const source = new Map<string, Uint8Array>();
  const bundleHost = createWorkerBundleHost({
    sql,
    targetKey: TARGET,
    source: {
      async read({ url }) {
        const bytes = source.get(url);
        if (!bytes) throw new Error("fixture artifact missing");
        return bytes;
      },
    },
  });
  const inspected: string[] = [];
  const inspectedClassNames: string[] = [];
  const settlements: { acceptedId: string; actualId: string | null; status: string | null }[] = [];
  let verdict: "valid" | "invalid" | "unavailable" = "valid";
  const inspector = {
    async inspectWorkflowClass(input: {
      readonly className: string;
      readonly modules: readonly { readonly bytes: Uint8Array }[];
    }) {
      inspected.push(new TextDecoder().decode(input.modules[0]?.bytes));
      inspectedClassNames.push(input.className);
      if (input.className !== SPEC_CLASS) throw new Error("unexpected inspected Workflow class");
      return verdict === "valid"
        ? ({ outcome: "valid" } as const)
        : verdict === "invalid"
          ? ({ outcome: "invalid", error: "workflow_class_invalid" } as const)
          : ({ outcome: "unavailable", retryable: true } as const);
    },
  };
  const admission = createV2WorkflowClassAdmission({
    sql,
    targetKey: TARGET,
    bundleCustody: bundleHost.custody,
    inspector,
  });
  const runtime = createWorkflowRuntime({
    sql,
    clock: () => new Date(),
    randomId: () => "unused-workflow-owner",
    waitUntil: async () => {},
    v2ResourceAuthority: createV2WorkflowResourceAuthority(sql),
    host: {
      async openPaused() {
        throw new Error("no instance opened in class admission fixture");
      },
      async stop() {
        return "stopped" as const;
      },
    },
  });
  const backend = {
    id: "workflow-admission-fixture-only",
    targetKey: TARGET,
    async execute(input: { form: string; spec: JsonObject }) {
      return {
        kind: "complete" as const,
        observed:
          input.form === WORKER_VERSION_FORM_URL
            ? { ready: true, resolvedBindings: true, bundleVerified: true }
            : input.form === WORKER_DEPLOYMENT_FORM_URL
              ? {
                  ready: true,
                  active: true,
                  selectedVersions: parseWorkerDeploymentSpec(input.spec).versions.map(
                    ({ workerVersion, weight }) => ({
                      resourceUid: workerVersion.resourceUid,
                      weight,
                    }),
                  ),
                }
              : { ready: true },
        output: {},
      };
    },
    async reconcile() {
      return { kind: "unknown" as const };
    },
  };
  const form = (extras: Partial<V2Form> = {}): V2Form => ({
    validateCreate() {},
    validateUpdate() {},
    backend,
    ...extras,
  });
  const engine = createTakoformV2Engine({
    sql,
    replayWindowSeconds: 3_600,
    authorize: async () => true,
    forms: {
      [MODULE_WORKER_FORM_URL]: form(),
      [WORKER_BUNDLE_FORM_URL]: bundleHost.form,
      [WORKER_VERSION_FORM_URL]: form({
        references: (spec) => referencesForWorkerVersion(parseWorkerVersionSpec(spec)),
      }),
      [WORKER_DEPLOYMENT_FORM_URL]: form({
        references: (spec) => referencesForWorkerDeployment(parseWorkerDeploymentSpec(spec)),
      }),
      [DURABLE_WORKFLOW_FORM_URL]: createDurableWorkflowForm({
        sql,
        clock: () => new Date(),
        targetKey: TARGET,
        classAdmission: admission,
        runtime,
      }),
    },
  });
  async function create(formUrl: string, name: string, spec: JsonObject, settle = true) {
    const operation = await engine.acceptCreate({
      principal: PRINCIPAL,
      key: `workflow-admission-create-${name}`,
      input: { form: formUrl, space: SPACE, name, spec },
    });
    if (settle) {
      const result = await engine.runNext();
      settlements.push({
        acceptedId: operation.id,
        actualId: result?.id ?? null,
        status: result?.status ?? null,
      });
      if (result?.id !== operation.id || result.status !== "succeeded")
        throw new Error("Workflow fixture operation did not succeed");
    }
    return operation;
  }
  const digest = async (bytes: Uint8Array) => (await bytesDigest(bytes)).slice(7);
  async function version(workerUid: string, name: string) {
    const moduleUrl = `https://artifacts.example.test/${name}/index.mjs`;
    const manifestUrl = `https://artifacts.example.test/${name}/manifest.json`;
    const moduleBytes = new TextEncoder().encode(
      `// ${name}\nexport class ReportWorkflow { run() { return {}; } }`,
    );
    const manifestBytes = new TextEncoder().encode(
      JSON.stringify({
        entrypoint: "index.mjs",
        files: [
          {
            path: "index.mjs",
            url: moduleUrl,
            sha256: await digest(moduleBytes),
            mediaType: "application/javascript+module",
          },
        ],
      }),
    );
    source.set(moduleUrl, moduleBytes);
    source.set(manifestUrl, manifestBytes);
    const bundle = await create(WORKER_BUNDLE_FORM_URL, `${name}-bundle`, {
      artifact: { url: manifestUrl, sha256: await digest(manifestBytes) },
    });
    return create(WORKER_VERSION_FORM_URL, name, {
      worker: { resourceUid: workerUid },
      bundle: { resourceUid: bundle.resourceUid },
      handlers: ["fetch"],
    });
  }
  function request(workerUid: string) {
    return {
      principal: PRINCIPAL,
      space: SPACE,
      targetKey: TARGET,
      resourceUid: "workflow-new-resource",
      spec: { worker: { resourceUid: workerUid }, className: SPEC_CLASS },
    };
  }
  return {
    sql,
    engine,
    admission,
    bundleCustody: bundleHost.custody,
    create,
    version,
    request,
    inspected,
    inspectedClassNames,
    settlements,
    setVerdict(value: typeof verdict) {
      verdict = value;
    },
    source,
  };
}
