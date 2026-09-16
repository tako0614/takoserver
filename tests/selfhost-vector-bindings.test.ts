import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEphemeralSql } from "../src/compat.ts";
import type { ProviderOffering, ProviderRelation, ProviderTicket } from "../src/provider-port.ts";
import type { ProviderRuntimeInputLeasePort } from "../src/provider-runtime-input-port.ts";
import {
  createSelfhostDataPlaneAccess,
  createSelfhostProvider,
} from "../src/providers/selfhost.ts";
import { createVectorIndexStore } from "../src/vector-index-store.ts";
import type { WorkerdRuntime } from "../src/workerd-runtime.ts";

const EDGE_API = "edge.forms.takoform.com";
const VECTOR_FORM = {
  apiVersion: EDGE_API,
  kind: "VectorIndex",
  definitionVersion: "0.1.0-dev.1",
  schemaDigest: `sha256:${"v".repeat(64)}`,
} as const;
const VECTOR_INTERFACE_REF = {
  apiVersion: "interfaces.takoform.com/v1alpha1",
  name: "edge.vector",
  version: "0.1.0",
  schemaDigest: "sha256:6df8b7680b0ff278cb8fcb6f56c602ec5d6bb9b4ec115a6172e70e6b54d6cada",
} as const;
const VECTOR_BINDING_REF = {
  apiVersion: "bindings.takoform.com/v1alpha2",
  name: "module-worker.edge-vector",
  version: "1.0.0",
  schemaDigest: "sha256:bc367a665405e405ac99091fb7f1908a382123d63c4acbd807de97c10184a809",
} as const;
const WORKER_FORM = {
  apiVersion: EDGE_API,
  kind: "ModuleWorker",
  definitionVersion: "0.3.0",
  schemaDigest: `sha256:${"w".repeat(64)}`,
} as const;
const WORKER_VERSION_FORM = {
  apiVersion: EDGE_API,
  kind: "WorkerVersion",
  definitionVersion: "0.4.0-dev.1",
  schemaDigest: `sha256:${"x".repeat(64)}`,
} as const;
const BUNDLE_FORM = {
  apiVersion: EDGE_API,
  kind: "WorkerBundle",
  definitionVersion: "0.1.0",
  schemaDigest: `sha256:${"b".repeat(64)}`,
} as const;

const VECTOR_OFFERING: ProviderOffering = {
  id: "candidate.vector-index",
  kind: "takoform.VectorIndex",
  displayName: "Candidate VectorIndex",
  form: VECTOR_FORM,
  providedInterfaces: [VECTOR_INTERFACE_REF],
  bindingRefs: [],
  capabilities: ["create", "delete", "observe"],
};
const WORKER_OFFERING: ProviderOffering = {
  id: "selfhost.module-worker",
  kind: "takoform.ModuleWorker",
  displayName: "Module Worker",
  form: WORKER_FORM,
  providedInterfaces: [],
  bindingRefs: [],
  capabilities: ["create", "delete", "observe"],
};
const WORKER_VERSION_OFFERING: ProviderOffering = {
  id: "candidate.worker-version",
  kind: "takoform.WorkerVersion",
  displayName: "Candidate WorkerVersion",
  form: WORKER_VERSION_FORM,
  providedInterfaces: [],
  bindingRefs: [VECTOR_BINDING_REF],
  capabilities: ["create", "delete", "observe"],
};

const WORKER_ID = {
  tenantRef: "tenant-a",
  space: "default",
  name: "search-worker",
  uid: "worker-uid",
} as const;
const VECTOR_ID = {
  tenantRef: "tenant-a",
  space: "default",
  name: "search-index",
  uid: "vector-uid",
} as const;
const VECTOR_CONFIG = {
  dimension: 3,
  metric: "cosine",
  filterKeys: ["spaceId"],
} as const;
const WORKER_SOURCE = "export default { fetch() {} };";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "takoserver-selfhost-vector-bindings-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function runtime(): WorkerdRuntime {
  return {
    async inspectModule(input) {
      return { outcome: "valid", exportedHandlers: [...input.declaredHandlers] };
    },
    async write() {},
    async remove() {},
    async reload() {},
    async has() {
      return false;
    },
  };
}

function provider(
  withVectorStore = true,
  runtimeInputs?: ProviderRuntimeInputLeasePort,
): ReturnType<typeof createSelfhostProvider> {
  return createSelfhostProvider({
    offerings: [WORKER_OFFERING, VECTOR_OFFERING, WORKER_VERSION_OFFERING],
    ...(withVectorStore
      ? { vectorIndexStore: createVectorIndexStore({ sql: createEphemeralSql() }) }
      : {}),
    dataRoot: root,
    dataPlaneAddress: "127.0.0.1:43123",
    ...(runtimeInputs ? { runtimeInputs } : {}),
    runtime: runtime(),
    artifacts: {
      async manifest(_tenant, digest) {
        if (digest !== "sha256:worker") return null;
        return {
          kind: "WorkerBundle",
          mainModule: "index.js",
          modules: [{ name: "index.js", digest: "sha256:index.js" }],
        };
      },
      async blob(digest) {
        return digest === "sha256:index.js" ? new TextEncoder().encode(WORKER_SOURCE) : null;
      },
    },
  });
}

function vectorNativeId(tenantId: string, resourceUid: string): string {
  const digest = createHash("sha256")
    .update(`${tenantId}\u0000${resourceUid}`, "utf8")
    .digest("hex");
  return `selfhost-vector:tvi-${digest}`;
}

function relation(input: {
  readonly pointer: string;
  readonly relation: string;
  readonly kind: string;
  readonly name: string;
  readonly uid: string;
  readonly form: typeof VECTOR_FORM | typeof WORKER_FORM | typeof BUNDLE_FORM;
  readonly spec?: Record<string, unknown>;
  readonly bindingRef?: typeof VECTOR_BINDING_REF;
  readonly deployment?: ProviderRelation["deployment"];
}): ProviderRelation {
  return {
    pointer: input.pointer,
    relation: input.relation,
    targetUid: input.uid,
    resource: {
      apiVersion: EDGE_API,
      kind: input.kind,
      form: { formRef: input.form },
      metadata: {
        name: input.name,
        space: "default",
        uid: input.uid,
        generation: "1",
        revision: "1",
      },
      spec: (input.spec ?? {}) as never,
    },
    ...(input.bindingRef ? { bindingRef: input.bindingRef } : {}),
    ...(input.deployment ? { deployment: input.deployment } : {}),
  };
}

function deployment(input: {
  readonly resourceUid: string;
  readonly offeringId: string;
  readonly nativeId: string;
  readonly tenantId?: string;
  readonly providerPackRef?: string;
  readonly providerInstallationRef?: string;
  readonly outputs?: Record<string, unknown>;
}): NonNullable<ProviderRelation["deployment"]> {
  return {
    tenantId: input.tenantId ?? "tenant-a",
    id: `deployment-${input.resourceUid}`,
    resourceUid: input.resourceUid,
    offeringId: input.offeringId,
    providerPackRef: input.providerPackRef ?? "pack-local",
    providerInstallationRef: input.providerInstallationRef ?? "installation-local",
    nativeId: input.nativeId,
    state: "active",
    observed: {},
    outputs: (input.outputs ?? {}) as never,
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
  };
}

async function baseVersionInput() {
  const local = provider();
  const worker = await local.apply({
    operationId: "create-worker",
    operationMode: "initial",
    offering: WORKER_OFFERING,
    identity: WORKER_ID,
    spec: {},
  });
  expect(worker.phase).toBe("succeeded");
  if (worker.phase !== "succeeded") throw new Error("worker setup failed");
  const scriptName = worker.result.outputs.scriptName;
  if (typeof scriptName !== "string") throw new Error("worker script is absent");
  const workerDeployment = deployment({
    resourceUid: WORKER_ID.uid,
    offeringId: WORKER_OFFERING.id,
    nativeId: worker.result.nativeId,
    providerPackRef: "pack-local",
    providerInstallationRef: "installation-local",
    outputs: { scriptName },
  });
  const vectorDeployment = deployment({
    resourceUid: VECTOR_ID.uid,
    offeringId: VECTOR_OFFERING.id,
    nativeId: vectorNativeId(VECTOR_ID.tenantRef, VECTOR_ID.uid),
    providerPackRef: workerDeployment.providerPackRef,
    providerInstallationRef: workerDeployment.providerInstallationRef,
    outputs: {},
  });
  const input = {
    operationId: "create-version",
    operationMode: "initial" as const,
    offering: WORKER_VERSION_OFFERING,
    identity: {
      tenantRef: WORKER_ID.tenantRef,
      space: WORKER_ID.space,
      name: "search-version",
      uid: "version-uid",
    },
    spec: {
      bundle: { apiVersion: EDGE_API, kind: "WorkerBundle", name: "search-bundle" },
      handlers: ["fetch"],
      worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: WORKER_ID.name },
      vectorBindings: [
        {
          name: "VECTORS",
          resource: {
            apiVersion: EDGE_API,
            kind: "VectorIndex",
            name: VECTOR_ID.name,
          },
        },
      ],
    },
    relations: [
      relation({
        pointer: "/worker",
        relation: "/worker",
        kind: "ModuleWorker",
        name: WORKER_ID.name,
        uid: WORKER_ID.uid,
        form: WORKER_FORM,
        deployment: workerDeployment,
      }),
      relation({
        pointer: "/bundle",
        relation: "/bundle",
        kind: "WorkerBundle",
        name: "search-bundle",
        uid: "bundle-uid",
        form: BUNDLE_FORM,
        spec: { manifestDigest: "sha256:worker" },
      }),
      relation({
        pointer: "/vectorBindings/0/resource",
        relation: "/vectorBindings/*/resource",
        kind: "VectorIndex",
        name: VECTOR_ID.name,
        uid: VECTOR_ID.uid,
        form: VECTOR_FORM,
        spec: VECTOR_CONFIG,
        bindingRef: VECTOR_BINDING_REF,
        deployment: vectorDeployment,
      }),
    ],
  };
  return { local, input, scriptName };
}

function expectInvalid(ticket: ProviderTicket): void {
  expect(ticket.phase).toBe("failed");
  if (ticket.phase === "failed") expect(ticket.failure.code).toBe("invalid_spec");
}

function updateVectorRelation(
  input: Awaited<ReturnType<typeof baseVersionInput>>["input"],
  update: (relation: ProviderRelation) => ProviderRelation,
) {
  return {
    ...input,
    relations: input.relations.map((candidate) =>
      candidate.pointer === "/vectorBindings/0/resource" ? update(candidate) : candidate,
    ),
  };
}

type RelationDeployment = NonNullable<ProviderRelation["deployment"]>;

function patchDeployment(
  candidate: ProviderRelation,
  patch: Partial<RelationDeployment>,
): ProviderRelation {
  if (!candidate.deployment) throw new Error("vector deployment is absent");
  return { ...candidate, deployment: { ...candidate.deployment, ...patch } };
}

function recoveryInputs(events: string[]): ProviderRuntimeInputLeasePort {
  const preparation = {
    preparationId: "preparation-vector",
    operationKey: "runtime-key",
    workerResourceUid: WORKER_ID.uid,
    canonicalPublicOrigin: "https://host.invalid",
    commitment: `sha256:${"c".repeat(64)}` as const,
  };
  return {
    async acquire() {
      throw new Error("acquire is not part of recovery");
    },
    async recover() {
      events.push("recover");
      return {
        preparation,
        bindingNames: ["SECRET"],
        async settle() {
          events.push("settle");
        },
      };
    },
    async abandon() {
      events.push("abandon");
    },
  };
}

describe("self-host WorkerVersion Vector binding projection", () => {
  test("projects the exact scope, materializes it, grants it, and recovers without re-resolution", async () => {
    const { local, input, scriptName } = await baseVersionInput();
    const recoverApply = local.recoverApply;
    if (!recoverApply) throw new Error("self-host provider is missing apply recovery");
    const applied = await local.apply(input);
    expect(applied.phase).toBe("succeeded");
    if (applied.phase !== "succeeded") return;
    const versionId = applied.result.outputs.versionId;
    if (typeof versionId !== "string") throw new Error("version id is absent");
    const scope = { tenantId: VECTOR_ID.tenantRef, resourceUid: VECTOR_ID.uid };
    const bindingsPath = join(
      root,
      "selfhost",
      "version-bindings",
      scriptName,
      `${versionId}.json`,
    );
    const raw = JSON.parse(await readFile(bindingsPath, "utf8")) as {
      format: string;
      dataPlane: { bindings: readonly Record<string, unknown>[] };
    };
    expect(raw.format).toBe("takoserver.selfhost-version-bindings@v6");
    expect(raw.dataPlane.bindings).toEqual([{ kind: "edge.vector", name: "VECTORS", scope }]);
    expect(raw.dataPlane.bindings[0]).not.toHaveProperty("target");
    expect(raw.dataPlane.bindings[0]).not.toHaveProperty("nativeId");
    expect(existsSync(join(root, "selfhost", "versions", scriptName, versionId))).toBe(true);

    const grant = await createSelfhostDataPlaneAccess(root).grant(scriptName, versionId);
    expect(grant?.vectors).toEqual({ VECTORS: scope });

    const beforeRecovery = readFileSync(bindingsPath);
    const recovered = await recoverApply(
      updateVectorRelation(input, (candidate) => {
        const repointed = patchDeployment(candidate, {
          tenantId: "operator-tenant",
          providerInstallationRef: "operator-installation",
          nativeId: "operator-native",
          resourceUid: "operator-repointed",
        });
        return {
          ...repointed,
          targetUid: "operator-repointed",
          resource: {
            ...repointed.resource,
            form: { formRef: { ...VECTOR_FORM, schemaDigest: `sha256:${"r".repeat(64)}` } },
            metadata: { ...repointed.resource.metadata, uid: "operator-repointed" },
          },
        };
      }),
    );
    expect(recovered.phase).toBe("succeeded");
    expect(readFileSync(bindingsPath)).toEqual(beforeRecovery);

    const noStore = provider(false);
    if (!noStore.recoverApply) throw new Error("self-host provider is missing apply recovery");
    const unavailable = await noStore.recoverApply(input);
    expect(unavailable.phase).toBe("failed");
    if (unavailable.phase === "failed") {
      expect(unavailable.failure.code).toBe("unavailable");
      expect(unavailable.failure.retryable).toBe(true);
    }
  });

  test("refuses tenant, UID, installation, native, Form, and Binding mismatches before writing", async () => {
    const cases: readonly [string, (relation: ProviderRelation) => ProviderRelation][] = [
      ["tenant", (candidate) => patchDeployment(candidate, { tenantId: "tenant-other" })],
      ["uid", (candidate) => ({ ...candidate, targetUid: "vector-other" })],
      [
        "installation",
        (candidate) =>
          patchDeployment(candidate, { providerInstallationRef: "installation-other" }),
      ],
      [
        "native",
        (candidate) =>
          patchDeployment(candidate, { nativeId: `selfhost-vector:tvi-${"0".repeat(64)}` }),
      ],
      [
        "form",
        (candidate) => ({
          ...candidate,
          resource: {
            ...candidate.resource,
            form: { formRef: { ...VECTOR_FORM, schemaDigest: `sha256:${"f".repeat(64)}` } },
          },
        }),
      ],
      [
        "binding",
        (candidate) => ({
          ...candidate,
          bindingRef: {
            ...VECTOR_BINDING_REF,
            schemaDigest: `sha256:${"d".repeat(64)}`,
          },
        }),
      ],
    ];
    for (const [label, update] of cases) {
      const { local, input } = await baseVersionInput();
      expectInvalid(
        await local.apply({
          ...updateVectorRelation(input, update),
          operationId: `mismatch-${label}`,
        }),
      );
      expect(existsSync(join(root, "selfhost", "versions"))).toBe(false);
      expect(existsSync(join(root, "selfhost", "version-bindings"))).toBe(false);
    }
  });

  test("abandons a one-shot sensitive handoff when the vector record is absent", async () => {
    const { local, input, scriptName } = await baseVersionInput();
    const applied = await local.apply(input);
    expect(applied.phase).toBe("succeeded");
    if (applied.phase !== "succeeded") return;
    const versionId = applied.result.outputs.versionId;
    if (typeof versionId !== "string") throw new Error("version id is absent");
    const bindingsPath = join(
      root,
      "selfhost",
      "version-bindings",
      scriptName,
      `${versionId}.json`,
    );
    rmSync(bindingsPath);
    const events: string[] = [];
    const recoveringProvider = provider(true, recoveryInputs(events));
    const recoverApply = recoveringProvider.recoverApply;
    if (!recoverApply) throw new Error("self-host provider is missing apply recovery");
    const recovered = await recoverApply({
      ...input,
      operationId: "recover-missing-vector-record",
      operationMode: "recovery",
      operationKey: "runtime-key",
      spec: { ...input.spec, requiredSensitiveVars: ["SECRET"] },
    });
    expect(recovered.phase).toBe("failed");
    if (recovered.phase === "failed") expect(recovered.failure.code).toBe("not_found");
    expect(events).toEqual(["recover", "abandon"]);
    expect(existsSync(bindingsPath)).toBe(false);
  });

  test("does not recover a declared vector from a present non-vector record", async () => {
    const { local, input, scriptName } = await baseVersionInput();
    const applied = await local.apply(input);
    expect(applied.phase).toBe("succeeded");
    if (applied.phase !== "succeeded") return;
    const versionId = applied.result.outputs.versionId;
    if (typeof versionId !== "string") throw new Error("version id is absent");
    const bindingsPath = join(
      root,
      "selfhost",
      "version-bindings",
      scriptName,
      `${versionId}.json`,
    );
    const raw = JSON.parse(await readFile(bindingsPath, "utf8")) as Record<string, unknown>;
    raw.format = "takoserver.selfhost-version-bindings@v4";
    delete raw.externalServices;
    delete raw.dataPlane;
    delete raw.planeToken;
    await writeFile(bindingsPath, JSON.stringify(raw), "utf8");
    const recoverApply = local.recoverApply;
    if (!recoverApply) throw new Error("self-host provider is missing apply recovery");
    const recovered = await recoverApply({
      ...input,
      operationId: "recover-missing-vector-slot",
      operationMode: "recovery",
    });
    expect(recovered.phase).toBe("failed");
    if (recovered.phase === "failed") expect(recovered.failure.code).toBe("not_found");
  });

  test("validates malformed vector declarations even when recovery has no record", async () => {
    const { local, input, scriptName } = await baseVersionInput();
    const applied = await local.apply(input);
    expect(applied.phase).toBe("succeeded");
    if (applied.phase !== "succeeded") return;
    const versionId = applied.result.outputs.versionId;
    if (typeof versionId !== "string") throw new Error("version id is absent");
    rmSync(join(root, "selfhost", "version-bindings", scriptName, `${versionId}.json`));
    const recoverApply = local.recoverApply;
    if (!recoverApply) throw new Error("self-host provider is missing apply recovery");
    const malformed = await recoverApply({
      ...input,
      operationId: "recover-malformed-vector-record",
      operationMode: "recovery",
      spec: {
        ...input.spec,
        vectorBindings: [
          {
            name: "bad-name",
            resource: {
              apiVersion: EDGE_API,
              kind: "VectorIndex",
              name: VECTOR_ID.name,
            },
          },
        ],
      },
    });
    expectInvalid(malformed);
  });

  test("refuses a binding name colliding with vars before materialization", async () => {
    const { local, input } = await baseVersionInput();
    expectInvalid(
      await local.apply({
        ...input,
        operationId: "name-collision",
        spec: { ...input.spec, vars: { VECTORS: "shadow" } },
      }),
    );
    expect(existsSync(join(root, "selfhost", "versions"))).toBe(false);
    expect(existsSync(join(root, "selfhost", "version-bindings"))).toBe(false);
  });
});
