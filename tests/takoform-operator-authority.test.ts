import { describe, expect, test } from "bun:test";
import { createEphemeralSql } from "../src/compat.ts";
import { canonicalDigest } from "../src/json.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import type { JsonObject, ObjectStore } from "../src/ports.ts";
import {
  type FormAdmissionHost,
  TAKOFORM_REVOCATION_V1,
  TAKOFORM_REVOCATION_V1_EMPTY_ENTRIES_DIGEST,
  TAKOFORM_REVOCATION_V1_GENESIS_DIGEST,
} from "../src/takoform/admission.ts";
import { createFormAdmissionStore } from "../src/takoform/admission-store.ts";
import {
  createIntegrationFixtureAdmissionAdapters,
  createUnavailableCoreAdmissionAdapter,
  createUnavailableSignedTrustEvidenceAdapter,
  type FormAuthorityTrustEvidence,
} from "../src/takoform/core-admission-adapter.ts";
import { currentTakoformCandidates } from "../src/takoform/current-candidates.ts";
import { createFormPackageStore, type FormPackageInput } from "../src/takoform/form-packages.ts";
import {
  deriveImplementationCatalog,
  yurucommuFormCandidates,
} from "../src/takoform/implementation-catalog.ts";
import {
  canonicalFormAuthorityPlanDigest,
  createFormAuthorityOperator,
  type FormAuthorityIdentity,
  type FormAuthorityPlanRequest,
} from "../src/takoform/operator-authority.ts";

const digest = (hex: string) => `sha256:${hex.repeat(64)}` as const;
const PUBLIC_VERSION_ID = "00000000-0000-4000-8000-000000000001";

async function moduleWorkerPackage(): Promise<FormPackageInput> {
  const form = yurucommuFormCandidates(currentTakoformCandidates().forms).find(
    (candidate) => candidate.identity.formRef.kind === "ModuleWorker",
  );
  if (!form?.identity.packageDigest) throw new Error("ModuleWorker package identity missing");
  const directory = new URL(
    "./fixtures/takoform-v1/forms/candidates/edge.forms.takoform.com/module-worker/",
    import.meta.url,
  );
  const manifest = (await Bun.file(new URL("package-index.json", directory)).json()) as JsonObject;
  const declarations = manifest.files as readonly {
    readonly path: string;
    readonly digest: `sha256:${string}`;
    readonly mediaType?: string;
  }[];
  return {
    formRef: form.identity.formRef,
    packageDigest: form.identity.packageDigest,
    manifest,
    files: await Promise.all(
      declarations.map(async (declaration) => ({
        path: declaration.path,
        digest: declaration.digest,
        ...(declaration.mediaType ? { mediaType: declaration.mediaType } : {}),
        bytes: new Uint8Array(await Bun.file(new URL(declaration.path, directory)).arrayBuffer()),
      })),
    ),
  };
}

function evidence(identity = "external-integration-publisher"): FormAuthorityTrustEvidence {
  return {
    publisher: {
      publisherKey: `publisher-${identity}`,
      policyDigest: digest("1"),
      policy: { apiVersion: "policy.forms.takoform.com/v1", mode: "integration-fixture" },
      oidcIssuer: "https://issuer.integration.invalid",
      sourceRepository: "https://github.com/example/forms",
      workflow: ".github/workflows/release.yml",
      ref: "refs/tags/v0.1.0",
      identity,
      trustedRootDigest: digest("2"),
      sourceCommit: "a".repeat(40),
      workflowCommit: "b".repeat(40),
      buildConfigCommit: "c".repeat(40),
      repositoryIdentifier: "repo:example/forms",
      ownerIdentifier: "owner:example",
      group: "edge.forms.takoform.com",
      namespaceGrantDigest: digest("3"),
    },
    checkpoint: {
      apiVersion: TAKOFORM_REVOCATION_V1,
      sequence: 0,
      digest: TAKOFORM_REVOCATION_V1_GENESIS_DIGEST,
      entriesDigest: TAKOFORM_REVOCATION_V1_EMPTY_ENTRIES_DIGEST,
      previousDigest: null,
      revokedPackageDigests: [],
    },
    bundleDigest: digest("4"),
  };
}

async function fixture(
  input: {
    readonly environment?: FormAuthorityIdentity["environment"];
    readonly objects?: ObjectStore;
    readonly admissionWrapper?: (host: FormAdmissionHost) => FormAdmissionHost;
    readonly unavailable?: boolean;
    readonly publisherIdentity?: string;
    readonly assertMutationAuthority?: () => Promise<void>;
  } = {},
) {
  const pkg = await moduleWorkerPackage();
  const form = yurucommuFormCandidates(currentTakoformCandidates().forms).find(
    (candidate) => candidate.identity.formRef.kind === "ModuleWorker",
  );
  if (!form) throw new Error("ModuleWorker candidate missing");
  const catalog = await deriveImplementationCatalog({
    forms: [form],
    capabilities: {
      apiVersion: "takoserver.form-lifecycle-capabilities@v1",
      implementation: "cloudflare-provider-v1",
      forms: { ModuleWorker: form.operations },
    },
    handlers: {
      apiVersion: "takoserver.form-handlers@v1",
      artifact: "worker-artifact-v1",
      forms: { ModuleWorker: form.operations },
    },
  });
  const environment = input.environment ?? "integration";
  const identity: FormAuthorityIdentity = {
    environment,
    hostId: `takoserver-${environment}`,
    workerArtifactDigest: digest("5"),
    publicWorkerVersionId: PUBLIC_VERSION_ID,
    capabilityDigest: catalog.capabilityDigest,
    implementationDigest: catalog.implementationDigest,
  };
  const adapters = input.unavailable
    ? {
        core: createUnavailableCoreAdmissionAdapter(),
        trust: createUnavailableSignedTrustEvidenceAdapter(),
      }
    : createIntegrationFixtureAdmissionAdapters({
        packages: [{ formRef: pkg.formRef, packageDigest: pkg.packageDigest }],
      });
  const adapterCalls = { corePrepare: 0, trustVerify: 0 };
  const core = {
    ...adapters.core,
    async prepare(request: Parameters<typeof adapters.core.prepare>[0]) {
      adapterCalls.corePrepare += 1;
      return await adapters.core.prepare(request);
    },
  };
  const trust = {
    ...adapters.trust,
    async verify(request: Parameters<typeof adapters.trust.verify>[0]) {
      adapterCalls.trustVerify += 1;
      return await adapters.trust.verify(request);
    },
  };
  const sql = createEphemeralSql();
  const objects = input.objects ?? createMemoryObjectStore();
  const storedPackages = createFormPackageStore(objects);
  const durable = createFormAdmissionStore({
    sql,
    packages: storedPackages,
    handles: core.handles,
  });
  const admission = input.admissionWrapper?.(durable) ?? durable;
  const operator = createFormAuthorityOperator({
    identity,
    catalog,
    packages: {
      async load(expected) {
        if (
          expected.packageDigest !== pkg.packageDigest ||
          JSON.stringify(expected.formRef) !== JSON.stringify(pkg.formRef)
        ) {
          throw new Error("unexpected package request");
        }
        return structuredClone(pkg);
      },
    },
    storedPackages,
    admission,
    core,
    trust,
    assertMutationAuthority: input.assertMutationAuthority ?? (async () => {}),
  });
  const request: FormAuthorityPlanRequest = {
    kind: "takoserver.form-authority-plan-request@v1",
    ...identity,
    activation: { kind: "space", tenantId: "tenant-yuru", space: "capsule-yuru" },
    evidence: evidence(input.publisherIdentity),
    actor: "integration-operator",
    reason: "install the exact Yurucommu Form package set",
  };
  return { operator, request, sql, objects, durable, pkg, identity, adapterCalls };
}

describe("route-less Form authority operator", () => {
  test("plans and converges through real package, admission, support, and Space activation paths", async () => {
    const f = await fixture();
    const plan = await f.operator.plan(f.request);
    expect(plan.commands.map((command) => command.kind)).toEqual([
      "AllowPublisher",
      "AppendCheckpoint",
      "InstallPackage",
      "SetSupport",
      "SetActivation",
    ]);
    expect(plan.packages[0]).toMatchObject({
      formRef: f.pkg.formRef,
      schemaDigest: f.pkg.formRef.schemaDigest,
      packageDigest: f.pkg.packageDigest,
    });

    const applied = await f.operator.apply(plan);
    expect(applied.status).toBe("converged");
    expect(applied.replanRequired).toBe(false);
    expect(applied.nextPlan.commands).toEqual([]);
    expect(applied.readback.forms).toEqual([
      expect.objectContaining({ installed: true, supported: true, active: true }),
    ]);
    expect(applied.receipts).toHaveLength(5);
    expect(
      applied.receipts.every(
        (receipt) =>
          receipt.admissionMode === "integration-fixture" && receipt.productionEligible === false,
      ),
    ).toBe(true);
    const activation = await f.sql.query(
      "SELECT audience_kind, audience_value FROM tf_form_activation_events",
    );
    expect(activation).toEqual([
      {
        audience_kind: "space",
        audience_value: JSON.stringify({ space: "capsule-yuru", tenantId: "tenant-yuru" }),
      },
    ]);
  });

  test("fails production apply before any D1 or R2 mutation without released adapters", async () => {
    let creates = 0;
    const memory = createMemoryObjectStore();
    const objects: ObjectStore = {
      ...memory,
      async create(key, body, options) {
        creates += 1;
        return await memory.create(key, body, options);
      },
    };
    const f = await fixture({ environment: "production", objects, unavailable: true });
    const plan = await f.operator.plan(f.request);
    await expect(f.operator.apply(plan)).rejects.toMatchObject({ code: "production_not_ready" });
    expect(creates).toBe(0);
    expect(await f.sql.query("SELECT * FROM tf_form_publisher_events")).toEqual([]);
  });

  test("rechecks live public identity after Core/trust preparation and before durable mutation", async () => {
    let fences = 0;
    let executions = 0;
    const f = await fixture({
      assertMutationAuthority: async () => {
        fences += 1;
        const error = new Error("public Worker advanced") as Error & { code: string };
        error.code = "identity_mismatch";
        throw error;
      },
      admissionWrapper: (host) => ({
        inspect: (query) => host.inspect(query),
        async execute(command) {
          executions += 1;
          return await host.execute(command);
        },
      }),
    });
    const applied = await f.operator.apply(await f.operator.plan(f.request));
    expect(f.adapterCalls).toEqual({ corePrepare: 1, trustVerify: 1 });
    expect(applied).toMatchObject({
      status: "partial",
      receipts: [],
      failure: { index: 0, code: "identity_mismatch" },
      replanRequired: true,
    });
    expect(fences).toBe(1);
    expect(executions).toBe(0);
    expect(await f.sql.query("SELECT * FROM tf_form_publisher_events")).toEqual([]);
  });

  test("fences every durable command instead of trusting the RPC-start identity check", async () => {
    let fences = 0;
    const f = await fixture({
      assertMutationAuthority: async () => {
        fences += 1;
      },
    });
    const applied = await f.operator.apply(await f.operator.plan(f.request));
    expect(applied.status).toBe("converged");
    expect(fences).toBe(applied.receipts.length);
    expect(fences).toBe(5);
  });

  test("rejects wrong environment, host, artifact, capability, and implementation identities", async () => {
    const f = await fixture();
    for (const changed of [
      { environment: "rehearsal" as const },
      { hostId: "other-host" },
      { workerArtifactDigest: digest("6") },
      { publicWorkerVersionId: "00000000-0000-4000-8000-000000000002" },
      { capabilityDigest: digest("7") },
      { implementationDigest: digest("8") },
    ]) {
      await expect(f.operator.plan({ ...f.request, ...changed })).rejects.toMatchObject({
        code: "identity_mismatch",
      });
    }
  });

  test("rejects plan digest edits and current-head drift before applying an action", async () => {
    const f = await fixture();
    const plan = await f.operator.plan(f.request);
    await expect(
      f.operator.apply({ ...plan, currentHeadDigest: digest("9") }),
    ).rejects.toMatchObject({ code: "plan_digest_mismatch" });
    await f.durable.execute({
      kind: "AllowPublisher",
      publisher: f.request.evidence.publisher,
      actor: "other-operator",
      reason: "move the publisher head",
    });
    await expect(f.operator.apply(plan)).rejects.toMatchObject({ code: "head_drift" });
  });

  test("rejects a recomputed plan whose support operations widen code-derived authority", async () => {
    const f = await fixture();
    const plan = await f.operator.plan(f.request);
    const commands = await Promise.all(
      plan.commands.map(async (command) => {
        if (command.kind !== "SetSupport") return command;
        const descriptor = {
          ...command,
          operations: [...command.operations, "update" as const],
        };
        return {
          ...descriptor,
          commandDigest: await canonicalDigest({
            index: descriptor.index,
            kind: descriptor.kind,
            formRef: descriptor.formRef,
            packageDigest: descriptor.packageDigest,
            operations: descriptor.operations,
            predecessorDigest: descriptor.predecessorDigest,
          }),
        };
      }),
    );
    const unsigned = { ...plan, commands };
    const { planDigest: _old, ...withoutDigest } = unsigned;
    const widened = {
      ...withoutDigest,
      planDigest: await canonicalFormAuthorityPlanDigest(withoutDigest),
    };
    await expect(f.operator.apply(widened)).rejects.toMatchObject({
      code: "plan_digest_mismatch",
    });
    expect(await f.sql.query("SELECT * FROM tf_form_publisher_events")).toEqual([]);
  });

  test("returns completed action receipts and converges only after readback and replan", async () => {
    let failSupport = true;
    const f = await fixture({
      admissionWrapper: (host) => ({
        inspect: (query) => host.inspect(query),
        async execute(command) {
          if (command.kind === "SetSupport" && failSupport) {
            failSupport = false;
            const error = new Error("synthetic guarded D1 outage") as Error & { code: string };
            error.code = "guarded_write_unavailable";
            throw error;
          }
          return await host.execute(command);
        },
      }),
    });
    const first = await f.operator.apply(await f.operator.plan(f.request));
    expect(first.status).toBe("partial");
    expect(first.receipts.map((receipt) => receipt.kind)).toEqual([
      "AllowPublisher",
      "AppendCheckpoint",
      "InstallPackage",
    ]);
    expect(first.failure).toMatchObject({ code: "guarded_write_unavailable" });
    expect(first.nextPlan.commands.map((command) => command.kind)).toEqual([
      "SetSupport",
      "SetActivation",
    ]);

    f.adapterCalls.corePrepare = 0;
    f.adapterCalls.trustVerify = 0;
    const second = await f.operator.apply(first.nextPlan);
    expect(second.status).toBe("converged");
    expect(second.receipts.map((receipt) => receipt.kind)).toEqual(["SetSupport", "SetActivation"]);
    expect(f.adapterCalls).toEqual({ corePrepare: 1, trustVerify: 1 });
    expect(await canonicalDigest(second.readback.currentHeads)).toBe(
      second.readback.currentHeadDigest,
    );
  });

  test("requires a fresh Core evaluation when signed bundle evidence changes", async () => {
    const f = await fixture();
    expect((await f.operator.apply(await f.operator.plan(f.request))).status).toBe("converged");
    const changed = {
      ...f.request,
      evidence: { ...f.request.evidence, bundleDigest: digest("6") },
    };
    const replacement = await f.operator.plan(changed);
    expect(replacement.commands.map((command) => command.kind)).toEqual(["ReplacePackage"]);
    expect((await f.operator.apply(replacement)).status).toBe("converged");
  });

  test("rejects tampered durable policy, revocation, and report evidence bodies", async () => {
    for (const statement of [
      "UPDATE tf_form_publisher_events SET policy_json = '{\"tampered\":true}'",
      "UPDATE tf_form_install_events SET admission_report_json = '{\"tampered\":true}'",
    ]) {
      const f = await fixture();
      expect((await f.operator.apply(await f.operator.plan(f.request))).status).toBe("converged");
      await f.sql.run(statement);
      await expect(f.operator.plan(f.request)).rejects.toMatchObject({
        code: "authority_state_conflict",
      });
    }

    const checkpoint = await fixture();
    expect(
      (await checkpoint.operator.apply(await checkpoint.operator.plan(checkpoint.request))).status,
    ).toBe("converged");
    await expect(
      checkpoint.operator.plan({
        ...checkpoint.request,
        evidence: {
          ...checkpoint.request.evidence,
          checkpoint: {
            ...checkpoint.request.evidence.checkpoint,
            revokedPackageDigests: [digest("6")],
          },
        },
      }),
    ).rejects.toMatchObject({ code: "authority_state_conflict" });
  });

  test("does not special-case official-looking and external publisher identities", async () => {
    const external = await fixture({ publisherIdentity: "external-publisher" });
    const officialLooking = await fixture({ publisherIdentity: "takoform-official" });
    expect(
      (await external.operator.plan(external.request)).commands.map((command) => command.kind),
    ).toEqual(
      (await officialLooking.operator.plan(officialLooking.request)).commands.map(
        (command) => command.kind,
      ),
    );
  });
});
