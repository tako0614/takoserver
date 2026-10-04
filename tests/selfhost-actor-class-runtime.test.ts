import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ACTOR_ABI_INTERFACE_REFS } from "../src/actor-abi-ref.ts";
import {
  type PreparedSelfhostVersionMaterialization,
  SELFHOST_VERSION_MATERIALIZATION_FORMAT,
} from "../src/providers/selfhost-version-materialization.ts";
import {
  createSelfhostActorClassRuntime,
  selfhostActorExpectedGraph,
} from "../src/selfhost-actor-class-runtime.ts";
import type {
  WorkerClassInspectionInput,
  WorkerClassRuntimeContract,
} from "../src/worker-class-runtime-port.ts";

const contract: WorkerClassRuntimeContract = {
  formRef: {
    apiVersion: "edge.forms.takoform.com",
    kind: "ActorNamespace",
    definitionVersion: "0.2.0",
    schemaDigest: `sha256:${"a".repeat(64)}`,
  },
  packageDigest: `sha256:${"b".repeat(64)}`,
  runtimeClassRef: ACTOR_ABI_INTERFACE_REFS.v2,
};

const inspection: WorkerClassInspectionInput = {
  contract,
  tenantId: "tenant-a",
  space: "default",
  className: "Counter",
  holder: {
    uid: "actor-uid",
    generation: "1",
    revision: "1",
    formRef: contract.formRef,
  },
  worker: {
    uid: "worker-uid",
    generation: "1",
    revision: "1",
    formRef: { ...contract.formRef, kind: "ModuleWorker" },
  },
  deployment: {
    uid: "deployment-uid",
    generation: "1",
    revision: "1",
    formRef: { ...contract.formRef, kind: "WorkerDeployment" },
  },
  version: {
    uid: "version-uid",
    generation: "1",
    revision: "1",
    formRef: { ...contract.formRef, kind: "WorkerVersion" },
  },
  weight: 10_000,
  bundle: {
    uid: "bundle-uid",
    generation: "1",
    revision: "1",
    formRef: { ...contract.formRef, kind: "WorkerBundle" },
    manifestDigest: `sha256:${"c".repeat(64)}`,
  },
};

test("runs only the exact selected forward contract in its self-host installation", async () => {
  const calls: unknown[] = [];
  const configuredContract = structuredClone(contract);
  const mutableConfiguredContract = configuredContract as unknown as { packageDigest: string };
  const runtime = createSelfhostActorClassRuntime({
    providerInstallationRef: "local.primary",
    contracts: [configuredContract],
    async inspect(input) {
      calls.push(input);
      return "valid";
    },
  });

  expect(
    await runtime.inspect({
      ...inspection,
      providerInstallationRef: "local.primary",
      holderNativeId: "selfhost-actor:actor-uid",
      versionNativeId: "selfhost-version:worker_script:version_1:proof",
    }),
  ).toBe("valid");
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    contract,
    holder: inspection.holder,
    version: inspection.version,
  });

  mutableConfiguredContract.packageDigest = `sha256:${"d".repeat(64)}`;
  const exposed = runtime.contracts as unknown as Array<{
    packageDigest: string;
    formRef: { schemaDigest: string };
  }>;
  const exposedContract = exposed[0];
  if (!exposedContract) throw new Error("registered contract missing");
  expect(() => {
    exposedContract.formRef.schemaDigest = `sha256:${"e".repeat(64)}`;
  }).toThrow();
  const trustedInput = {
    ...inspection,
    providerInstallationRef: "local.primary",
    holderNativeId: "selfhost-actor:actor-uid",
    versionNativeId: "selfhost-version:worker_script:version_1:proof",
  };
  expect(await runtime.inspect(trustedInput)).toBe("valid");
  expect(
    await runtime.inspect({
      ...trustedInput,
      contract: {
        ...contract,
        packageDigest: mutableConfiguredContract.packageDigest as `sha256:${string}`,
      },
    }),
  ).toBe("unavailable");
});

test("refuses unknown contract, installation, and native identities before inspection", async () => {
  let calls = 0;
  const runtime = createSelfhostActorClassRuntime({
    providerInstallationRef: "local.primary",
    contracts: [contract],
    async inspect() {
      calls += 1;
      return "valid";
    },
  });
  const base = {
    ...inspection,
    providerInstallationRef: "local.primary",
    holderNativeId: "selfhost-actor:actor-uid",
    versionNativeId: "selfhost-version:worker_script:version_1:proof",
  };

  expect(await runtime.inspect({ ...base, providerInstallationRef: "other.installation" })).toBe(
    "unavailable",
  );
  expect(await runtime.inspect({ ...base, holderNativeId: "selfhost-actor:other-uid" })).toBe(
    "unavailable",
  );
  expect(
    await runtime.inspect({
      ...base,
      versionNativeId: "selfhost-version:bad/script:version_1:proof",
    }),
  ).toBe("unavailable");
  expect(
    await runtime.inspect({
      ...base,
      contract: { ...contract, packageDigest: `sha256:${"d".repeat(64)}` },
    }),
  ).toBe("unavailable");
  expect(calls).toBe(0);
});

test("preserves an authenticated invalid-class refusal and maps faults to unavailable", async () => {
  const invalid = createSelfhostActorClassRuntime({
    providerInstallationRef: "local.primary",
    contracts: [contract],
    async inspect() {
      return "invalid";
    },
  });
  const unavailable = createSelfhostActorClassRuntime({
    providerInstallationRef: "local.primary",
    contracts: [contract],
    async inspect() {
      throw new Error("private inspection detail");
    },
  });
  const input = {
    ...inspection,
    providerInstallationRef: "local.primary",
    holderNativeId: "selfhost-actor:actor-uid",
    versionNativeId: "selfhost-version:worker_script:version_1:proof",
  };
  expect(await invalid.inspect(input)).toBe("invalid");
  expect(await unavailable.inspect(input)).toBe("unavailable");
});

test("binds expected module bytes to the exact canonical WorkerBundle manifest", async () => {
  const bytes = new TextEncoder().encode("export class Actor {};");
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;
  const manifestDigest = `sha256:${"c".repeat(64)}` as const;
  const prepared: PreparedSelfhostVersionMaterialization = {
    materializationDigest: `sha256:${"d".repeat(64)}`,
    meta: {
      format: SELFHOST_VERSION_MATERIALIZATION_FORMAT,
      materializationDigest: `sha256:${"d".repeat(64)}`,
      manifestDigest,
      mainModule: "worker.mjs",
      modules: [{ path: "worker.mjs", digest, size: bytes.byteLength }],
    },
    modules: new Map([["worker.mjs", bytes]]),
  };

  expect(await selfhostActorExpectedGraph(prepared, `sha256:${"e".repeat(64)}`)).toBeNull();
  expect(await selfhostActorExpectedGraph(prepared, manifestDigest)).toEqual({
    mainModule: "worker.mjs",
    modules: [
      {
        name: "worker.mjs",
        digest,
        mediaType: "application/javascript+module",
        bytes,
      },
    ],
  });
  expect(
    await selfhostActorExpectedGraph(
      { ...prepared, modules: new Map([["worker.mjs", new Uint8Array([1, 2, 3])]]) },
      manifestDigest,
    ),
  ).toBeNull();
});
