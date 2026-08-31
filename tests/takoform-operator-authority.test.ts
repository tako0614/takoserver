import { describe, expect, test } from "bun:test";
import { createEphemeralSql } from "../src/compat.ts";
import { canonicalDigest } from "../src/json.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import type { JsonObject, ObjectStore } from "../src/ports.ts";
import {
  createAdmissionHandleIssuer,
  type FormAdmissionHost,
  TAKOFORM_REVOCATION_V1,
  TAKOFORM_REVOCATION_V1_EMPTY_ENTRIES_DIGEST,
  TAKOFORM_REVOCATION_V1_GENESIS_DIGEST,
} from "../src/takoform/admission.ts";
import { createFormAdmissionStore } from "../src/takoform/admission-store.ts";
import { currentTakoformCandidates } from "../src/takoform/current-candidates.ts";
import {
  createIntegrationFixtureEvidenceVerifier,
  createUnavailableFormAuthorityEvidenceVerifier,
  type FormAuthorityVerificationEvidence,
} from "../src/takoform/form-authority-verification.ts";
import { createFormPackageStore, type FormPackageInput } from "../src/takoform/form-packages.ts";
import {
  canonicalFormAuthorityPlanDigest,
  createHostAdmissionCoordinator,
  type FormAuthorityIdentity,
  type FormAuthorityPlanRequest,
  formAuthorityPackageProfile,
} from "../src/takoform/host-admission-coordinator.ts";
import {
  createTakoformHostAuthority,
  takoformActivationAudience,
} from "../src/takoform/host-authority.ts";
import {
  deriveImplementationCatalog,
  yurucommuFormCandidates,
} from "../src/takoform/implementation-catalog.ts";

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

function evidence(identity = "external-integration-publisher"): FormAuthorityVerificationEvidence {
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
  const baseVerifier = input.unavailable
    ? createUnavailableFormAuthorityEvidenceVerifier()
    : createIntegrationFixtureEvidenceVerifier({
        packages: [{ formRef: pkg.formRef, packageDigest: pkg.packageDigest }],
      });
  const adapterCalls = { verify: 0 };
  const packageLoads = { count: 0 };
  const verifier = {
    ...baseVerifier,
    async verifySet(request: Parameters<typeof baseVerifier.verifySet>[0]) {
      adapterCalls.verify += 1;
      return await baseVerifier.verifySet(request);
    },
  };
  const sql = createEphemeralSql();
  const objects = input.objects ?? createMemoryObjectStore();
  const storedPackages = createFormPackageStore(objects);
  const handles = createAdmissionHandleIssuer();
  const durable = createFormAdmissionStore({
    sql,
    packages: storedPackages,
    handles,
  });
  const admission = input.admissionWrapper?.(durable) ?? durable;
  const operator = createHostAdmissionCoordinator({
    identity,
    catalog,
    packages: {
      async load(expected) {
        packageLoads.count += 1;
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
    handles,
    verifier,
    assertMutationAuthority: input.assertMutationAuthority ?? (async () => {}),
  });
  const request: FormAuthorityPlanRequest = {
    kind: "takoserver.form-authority-plan-request@v2",
    ...identity,
    activation: {
      kind: "space",
      tenantId: "tenant-yuru",
      space: "capsule-yuru",
      desiredActive: true,
    },
    evidence: evidence(input.publisherIdentity),
    actor: "integration-operator",
    reason: "install the exact Yurucommu Form package set",
  };
  return {
    operator,
    request,
    sql,
    objects,
    durable,
    pkg,
    form,
    handles,
    identity,
    adapterCalls,
    packageLoads,
  };
}

type CoordinatorFixture = Awaited<ReturnType<typeof fixture>>;

async function expectInstallIdentityRepair(
  f: CoordinatorFixture,
  operator: CoordinatorFixture["operator"] = f.operator,
  request: FormAuthorityPlanRequest = f.request,
  identity: FormAuthorityIdentity = f.identity,
): Promise<void> {
  expect((await operator.readback(request)).forms).toEqual([
    expect.objectContaining({
      installed: false,
      supported: false,
      activationHead: expect.objectContaining({
        present: true,
        active: true,
        implementationDigest: identity.implementationDigest,
      }),
    }),
  ]);

  const repair = await operator.plan(request);
  expect(repair.commands.map((command) => command.kind)).toEqual(["ReplacePackage"]);

  const applied = await operator.apply(repair);
  expect(applied.status).toBe("converged");
  expect(applied.nextPlan.commands).toEqual([]);
  expect(applied.readback.forms).toEqual([
    expect.objectContaining({
      installed: true,
      supported: true,
      activationHead: expect.objectContaining({
        present: true,
        active: true,
        implementationDigest: identity.implementationDigest,
      }),
    }),
  ]);

  const heads = await f.durable.inspect({
    kind: "Package",
    formRef: f.pkg.formRef,
    packageDigest: f.pkg.packageDigest,
  });
  expect(heads.install?.implementation_digest).toBe(identity.implementationDigest);
  expect(heads.support?.implementation_digest).toBe(identity.implementationDigest);
  expect(heads.activations?.at(-1)?.implementation_digest).toBe(identity.implementationDigest);

  const authority = createTakoformHostAuthority({
    sql: f.sql,
    objects: f.objects,
    hostId: identity.hostId,
    publicWorkerVersionId: identity.publicWorkerVersionId,
    implementationDigest: identity.implementationDigest,
    candidates: [f.form],
    bindings: [],
    technicalAvailability: {
      async resolve() {
        return { executable: true, activated: true, availableToPrincipal: true };
      },
    },
  });
  expect(
    (
      await authority.catalog({
        tenantId: request.activation.tenantId,
        space: request.activation.space,
        principalId: "principal-yuru",
      })
    ).forms,
  ).toEqual([
    expect.objectContaining({
      supported: true,
      availability: {
        executable: true,
        activated: true,
        availableToPrincipal: true,
      },
    }),
  ]);
}

describe("route-less Takoserver Host admission coordinator", () => {
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
      expect.objectContaining({
        installed: true,
        supported: true,
        activationHead: expect.objectContaining({
          present: true,
          active: true,
          implementationDigest: f.identity.implementationDigest,
          eventDigest: expect.stringMatching(/^sha256:/),
        }),
      }),
    ]);
    expect(applied.receipts).toHaveLength(5);
    expect(applied).toMatchObject({
      policyAuthority: "takoserver-host",
      verificationMode: "integration-fixture",
      productionEligible: false,
    });
    expect(applied).not.toHaveProperty("admissionMode");
    expect(
      applied.receipts.every(
        (receipt) =>
          receipt.policyAuthority === "takoserver-host" &&
          receipt.verificationMode === "integration-fixture" &&
          receipt.productionEligible === false,
      ),
    ).toBe(true);
    const reports = await f.sql.query(
      "SELECT admission_report_json FROM tf_form_install_events LIMIT 1",
    );
    const report = JSON.parse(String(reports[0]?.admission_report_json)) as {
      checks?: readonly { readonly code?: string }[];
    };
    expect(report.checks?.map(({ code }) => code)).toContain(
      "host-policy-verification-evidence-accepted",
    );
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

  test("fails production apply before any D1 or R2 mutation without released verification", async () => {
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

  test("never accepts serialized verification evidence as Host policy", async () => {
    const f = await fixture();
    const forgedEvidence = {
      ...f.request.evidence,
      policyAuthority: "takoserver-host",
      status: "admitted",
    } as FormAuthorityVerificationEvidence;
    const forgedRequest = { ...f.request, evidence: forgedEvidence };
    const plan = await f.operator.plan(forgedRequest);
    await expect(f.operator.apply(plan)).rejects.toMatchObject({
      code: "verification_evidence_refused",
    });
    expect(await f.sql.query("SELECT * FROM tf_form_publisher_events")).toEqual([]);
  });

  test("rechecks live public identity after verification and Host policy before durable mutation", async () => {
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
    expect(f.adapterCalls).toEqual({ verify: 1 });
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

    f.adapterCalls.verify = 0;
    const second = await f.operator.apply(first.nextPlan);
    expect(second.status).toBe("converged");
    expect(second.receipts.map((receipt) => receipt.kind)).toEqual(["SetSupport", "SetActivation"]);
    expect(f.adapterCalls).toEqual({ verify: 1 });
    expect(await canonicalDigest(second.readback.currentHeads)).toBe(
      second.readback.currentHeadDigest,
    );
  });

  test("requires fresh verification and a new Host decision when bundle evidence changes", async () => {
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

  test("repairs a same-package install head left on a predecessor implementation before reporting readiness", async () => {
    const f = await fixture();
    expect((await f.operator.apply(await f.operator.plan(f.request))).status).toBe("converged");

    const catalog = await deriveImplementationCatalog({
      forms: [f.form],
      capabilities: {
        apiVersion: "takoserver.form-lifecycle-capabilities@v1",
        implementation: "cloudflare-provider-v1",
        forms: { ModuleWorker: f.form.operations },
      },
      handlers: {
        apiVersion: "takoserver.form-handlers@v1",
        artifact: "worker-artifact-v2",
        forms: { ModuleWorker: f.form.operations },
      },
    });
    const identity: FormAuthorityIdentity = {
      ...f.identity,
      workerArtifactDigest: digest("6"),
      publicWorkerVersionId: "00000000-0000-4000-8000-000000000002",
      capabilityDigest: catalog.capabilityDigest,
      implementationDigest: catalog.implementationDigest,
    };
    expect(identity.implementationDigest).not.toBe(f.identity.implementationDigest);

    // This is the exact live split-brain shape: a prior projection advanced
    // support and Space activation to the current semantic identity while the
    // same-package install head remained on its predecessor identity.
    await f.durable.execute({
      kind: "SetSupport",
      formRef: f.pkg.formRef,
      packageDigest: f.pkg.packageDigest,
      supported: true,
      profile: formAuthorityPackageProfile(identity),
      operations: f.form.operations,
      implementationDigest: identity.implementationDigest,
      actor: "integration-operator",
      reason: "reproduce predecessor install identity drift",
    });
    await f.durable.execute({
      kind: "SetActivation",
      formRef: f.pkg.formRef,
      packageDigest: f.pkg.packageDigest,
      active: true,
      audience: takoformActivationAudience("space", {
        tenantId: f.request.activation.tenantId,
        space: f.request.activation.space,
      }),
      implementationDigest: identity.implementationDigest,
      actor: "integration-operator",
      reason: "reproduce predecessor install identity drift",
    });

    const storedPackages = createFormPackageStore(f.objects);
    const operator = createHostAdmissionCoordinator({
      identity,
      catalog,
      packages: {
        async load(expected) {
          if (
            expected.packageDigest !== f.pkg.packageDigest ||
            JSON.stringify(expected.formRef) !== JSON.stringify(f.pkg.formRef)
          ) {
            throw new Error("unexpected package request");
          }
          return structuredClone(f.pkg);
        },
      },
      storedPackages,
      admission: f.durable,
      handles: f.handles,
      verifier: createIntegrationFixtureEvidenceVerifier({
        packages: [{ formRef: f.pkg.formRef, packageDigest: f.pkg.packageDigest }],
      }),
      assertMutationAuthority: async () => {},
    });
    const request: FormAuthorityPlanRequest = { ...f.request, ...identity };
    await expectInstallIdentityRepair(f, operator, request, identity);
  });

  test("repairs a persisted null implementation identity before reporting readiness", async () => {
    let wroteLegacyInstall = false;
    const f = await fixture({
      admissionWrapper: (host) => ({
        inspect: (query) => host.inspect(query),
        async execute(command) {
          if (!wroteLegacyInstall && command.kind === "InstallPackage") {
            wroteLegacyInstall = true;
            const { implementationDigest: _implementationDigest, ...legacyCommand } = command;
            return await host.execute(legacyCommand);
          }
          return await host.execute(command);
        },
      }),
    });
    await f.operator.apply(await f.operator.plan(f.request));
    expect(wroteLegacyInstall).toBe(true);
    expect(
      (
        await f.durable.inspect({
          kind: "Package",
          formRef: f.pkg.formRef,
          packageDigest: f.pkg.packageDigest,
        })
      ).install,
    ).toHaveProperty("implementation_digest", null);

    await expectInstallIdentityRepair(f);
  });

  test("repairs a historical install row whose implementation identity property is missing", async () => {
    let exposedHistoricalShape = false;
    const f = await fixture({
      admissionWrapper: (host) => ({
        async inspect(query) {
          const view = await host.inspect(query);
          if (query.kind !== "History" || query.chain !== "install" || !view.events) {
            return view;
          }
          return {
            ...view,
            events: view.events.map((row) => {
              if (row.event_type !== "install") return row;
              const { implementation_digest: _implementationDigest, ...historicalRow } = row;
              exposedHistoricalShape = true;
              return historicalRow;
            }),
          };
        },
        execute: (command) => host.execute(command),
      }),
    });
    await f.operator.apply(await f.operator.plan(f.request));
    expect(exposedHistoricalShape).toBe(true);
    expect(
      (
        await f.durable.inspect({
          kind: "Package",
          formRef: f.pkg.formRef,
          packageDigest: f.pkg.packageDigest,
        })
      ).install?.implementation_digest,
    ).toBe(f.identity.implementationDigest);

    await expectInstallIdentityRepair(f);
  });

  test("moves an installed package to a new publisher generation without rotating old history", async () => {
    const f = await fixture({ publisherIdentity: "retired-host-coupled-fixture" });
    expect((await f.operator.apply(await f.operator.plan(f.request))).status).toBe("converged");
    const nextRequest: FormAuthorityPlanRequest = {
      ...f.request,
      evidence: evidence("stable-corpus-generation"),
    };

    const migration = await f.operator.plan(nextRequest);
    expect(migration.commands.map((command) => command.kind)).toEqual([
      "AllowPublisher",
      "AppendCheckpoint",
      "ReplacePackage",
    ]);
    const applied = await f.operator.apply(migration);
    expect(applied.status).toBe("converged");
    expect(applied.nextPlan.commands).toEqual([]);
    expect(applied.readback.forms).toEqual([
      expect.objectContaining({
        installed: true,
        supported: true,
        activationHead: expect.objectContaining({ present: true, active: true }),
      }),
    ]);
    expect(
      await f.sql.query("SELECT event_type FROM tf_form_publisher_events ORDER BY event_at, id"),
    ).toEqual([{ event_type: "allow" }, { event_type: "allow" }]);
    expect(
      await f.sql.query("SELECT event_type FROM tf_form_install_events ORDER BY event_at, id"),
    ).toEqual([{ event_type: "install" }, { event_type: "replace" }]);
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

  test("deactivates an active head with its durable implementation and no package verification", async () => {
    const f = await fixture();
    expect((await f.operator.apply(await f.operator.plan(f.request))).status).toBe("converged");
    const loadsAfterActivation = f.packageLoads.count;
    const verifiesAfterActivation = f.adapterCalls.verify;
    const deactivationRequest: FormAuthorityPlanRequest = {
      ...f.request,
      activation: { ...f.request.activation, desiredActive: false },
    };
    const plan = await f.operator.plan(deactivationRequest);
    expect(plan.commands).toHaveLength(1);
    expect(plan.commands[0]).toMatchObject({
      kind: "SetActivation",
      active: false,
      implementationDigest: f.identity.implementationDigest,
    });
    expect(plan.commands[0]?.predecessorDigest).toMatch(/^sha256:/);
    expect(plan.commands.map((command) => command.kind)).toEqual(["SetActivation"]);
    expect(f.packageLoads.count).toBe(loadsAfterActivation);
    expect(f.adapterCalls.verify).toBe(verifiesAfterActivation);

    const applied = await f.operator.apply(plan);
    expect(applied.status).toBe("converged");
    expect(applied.receipts).toHaveLength(1);
    expect(applied.receipts[0]).toMatchObject({ kind: "SetActivation", state: "inactive" });
    expect(applied.readback.forms[0]).toMatchObject({
      activationHead: {
        present: true,
        active: false,
        implementationDigest: f.identity.implementationDigest,
        eventDigest: expect.stringMatching(/^sha256:/),
      },
    });
    expect(f.packageLoads.count).toBe(loadsAfterActivation);
    expect(f.adapterCalls.verify).toBe(verifiesAfterActivation);
  });

  test("treats an already inactive activation as a converged no-op", async () => {
    const f = await fixture();
    const active = await f.operator.apply(await f.operator.plan(f.request));
    expect(active.status).toBe("converged");
    const deactivationRequest: FormAuthorityPlanRequest = {
      ...f.request,
      activation: { ...f.request.activation, desiredActive: false },
    };
    expect((await f.operator.apply(await f.operator.plan(deactivationRequest))).status).toBe(
      "converged",
    );
    const noOp = await f.operator.plan(deactivationRequest);
    expect(noOp.commands).toEqual([]);
    const applied = await f.operator.apply(noOp);
    expect(applied.status).toBe("converged");
    expect(applied.receipts).toEqual([]);
    expect(applied.readback.forms[0]?.activationHead).toMatchObject({
      present: true,
      active: false,
    });
  });

  test("rejects a durable activation head whose implementation body was tampered", async () => {
    const f = await fixture();
    expect((await f.operator.apply(await f.operator.plan(f.request))).status).toBe("converged");
    const tamperedDigest = digest("9");
    await f.sql.run("UPDATE tf_form_activation_events SET implementation_digest = ?", [
      tamperedDigest,
    ]);
    const deactivationRequest: FormAuthorityPlanRequest = {
      ...f.request,
      activation: { ...f.request.activation, desiredActive: false },
    };
    await expect(f.operator.plan(deactivationRequest)).rejects.toMatchObject({
      code: "authority_state_conflict",
    });
  });

  test("deactivates a valid activation head left by a predecessor worker", async () => {
    const f = await fixture();
    expect((await f.operator.apply(await f.operator.plan(f.request))).status).toBe("converged");
    const rows = await f.sql.query("SELECT * FROM tf_form_activation_events LIMIT 1");
    const row = rows[0];
    if (!row) throw new Error("activation head missing");
    const predecessorImplementationDigest = digest("9");
    const predecessorEventDigest = await canonicalDigest({
      chain: "activation",
      id: row.id,
      activationKey: row.activation_key,
      formRef: JSON.parse(String(row.form_ref_json)),
      packageDigest: row.package_digest,
      audience: {
        kind: row.audience_kind,
        value: row.audience_value,
      },
      active: row.active === 1,
      implementationDigest: predecessorImplementationDigest,
      actor: row.actor,
      reason: row.reason,
      eventAt: Number(row.event_at),
      predecessorDigest: row.predecessor_digest,
    });
    await f.sql.run(
      "UPDATE tf_form_activation_events SET implementation_digest = ?, event_digest = ?",
      [predecessorImplementationDigest, predecessorEventDigest],
    );
    const deactivationRequest: FormAuthorityPlanRequest = {
      ...f.request,
      activation: { ...f.request.activation, desiredActive: false },
    };
    const plan = await f.operator.plan(deactivationRequest);
    expect(plan.commands[0]).toMatchObject({
      kind: "SetActivation",
      active: false,
      implementationDigest: predecessorImplementationDigest,
      predecessorDigest: predecessorEventDigest,
    });
    const applied = await f.operator.apply(plan);
    expect(applied.status).toBe("converged");
    expect(applied.readback.forms[0]?.activationHead).toMatchObject({
      present: true,
      active: false,
      implementationDigest: predecessorImplementationDigest,
    });
  });

  test("rejects desired-state and SetActivation command tampering", async () => {
    const f = await fixture();
    const plan = await f.operator.plan(f.request);
    const activationCommand = plan.commands.find((command) => command.kind === "SetActivation");
    if (activationCommand?.kind !== "SetActivation") {
      throw new Error("activation command missing");
    }
    const tamperedCommand = {
      ...activationCommand,
      active: false,
    };
    const tampered = {
      ...plan,
      commands: plan.commands.map((command) =>
        command.kind === "SetActivation" ? tamperedCommand : command,
      ),
    };
    const { planDigest: _planDigest, ...withoutDigest } = tampered;
    await expect(
      f.operator.apply({
        ...withoutDigest,
        planDigest: await canonicalFormAuthorityPlanDigest(withoutDigest),
      }),
    ).rejects.toMatchObject({ code: "plan_digest_mismatch" });

    const deactivation = {
      ...f.request,
      activation: { ...f.request.activation, desiredActive: false },
    };
    const falsePlan = await f.operator.plan(deactivation);
    const { planDigest: _falseDigest, ...falseUnsigned } = falsePlan;
    await expect(
      f.operator.apply({
        ...falseUnsigned,
        request: f.request,
        planDigest: await canonicalFormAuthorityPlanDigest({
          ...falseUnsigned,
          request: f.request,
        }),
      }),
    ).rejects.toMatchObject({ code: "plan_digest_mismatch" });
  });
});
