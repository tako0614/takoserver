import { describe, expect, test } from "bun:test";
import {
  type AdmissionProjectionActivation,
  type AdmissionProjectionCheckpoint,
  type AdmissionProjectionCurrentHeads,
  type AdmissionProjectionHistory,
  type AdmissionProjectionInput,
  type AdmissionProjectionInstall,
  type AdmissionProjectionPublisher,
  type AdmissionProjectionRetention,
  type AdmissionProjectionSupport,
  evaluateAdmissionProjection,
} from "../src/takoform/admission-projection.ts";

const FORM_REF = {
  apiVersion: "example.forms.test/v1alpha1",
  kind: "Widget",
  definitionVersion: "1.0.0",
  schemaDigest: `sha256:${"a".repeat(64)}`,
} as const;

const OTHER_FORM_REF = {
  ...FORM_REF,
  kind: "OtherWidget",
} as const;

const digest = (letter: string): `sha256:${string}` =>
  `sha256:${letter.repeat(64)}` as `sha256:${string}`;

const publisher = (publisherKey = "external.publisher"): AdmissionProjectionPublisher => ({
  publisherKey,
  eventType: "allow",
  policyDigest: digest("1"),
  eventDigest: digest("2"),
});

const checkpoint = (
  overrides: Partial<AdmissionProjectionCheckpoint> = {},
): AdmissionProjectionCheckpoint => ({
  publisherKey: "external.publisher",
  policyDigest: digest("1"),
  policyEventDigest: digest("2"),
  sequence: 1,
  checkpointDigest: digest("3"),
  eventDigest: digest("4"),
  verified: true,
  stale: false,
  revokedPackageDigests: [],
  ...overrides,
});

const install = (
  packageDigest = digest("5"),
  overrides: Partial<AdmissionProjectionInstall> = {},
): AdmissionProjectionInstall => ({
  formRef: FORM_REF,
  packageDigest,
  publisherKey: "external.publisher",
  eventType: "install",
  ...overrides,
});

const support = (
  packageDigest = digest("5"),
  implementationDigest = digest("6"),
  overrides: Partial<AdmissionProjectionSupport> = {},
): AdmissionProjectionSupport => ({
  formRef: FORM_REF,
  packageDigest,
  implementationDigest,
  supported: true,
  operations: ["create", "read", "update", "delete", "import", "observe"],
  ...overrides,
});

const activation = (
  audience: AdmissionProjectionActivation["audience"],
  overrides: Partial<AdmissionProjectionActivation> = {},
): AdmissionProjectionActivation => ({
  formRef: FORM_REF,
  packageDigest: digest("5"),
  implementationDigest: digest("6"),
  audience,
  active: true,
  ...overrides,
});

const retention = (
  packageDigest = digest("5"),
  implementationDigest = digest("6"),
  overrides: Partial<AdmissionProjectionRetention> = {},
): AdmissionProjectionRetention => ({
  formRef: FORM_REF,
  packageDigest,
  implementationDigest,
  retained: true,
  ...overrides,
});

function current(
  overrides: Partial<AdmissionProjectionCurrentHeads> = {},
): AdmissionProjectionCurrentHeads {
  return {
    publisher: publisher(),
    checkpoint: checkpoint(),
    install: install(),
    support: support(),
    activations: [
      activation({ kind: "host", hostId: "host-a" }),
      activation({ kind: "tenant", tenantId: "tenant-a" }),
      activation({ kind: "space", tenantId: "tenant-a", space: "space-a" }),
      activation({ kind: "principal", tenantId: "tenant-a", principalId: "principal-a" }),
    ],
    retentions: [retention()],
    ...overrides,
  };
}

function input(
  operation: AdmissionProjectionInput["operation"],
  overrides: Partial<AdmissionProjectionInput> = {},
): AdmissionProjectionInput {
  return {
    operation,
    formRef: FORM_REF,
    packageDigest: digest("5"),
    implementationDigest: digest("6"),
    context: {
      hostId: "host-a",
      tenantId: "tenant-a",
      space: "space-a",
      principalId: "principal-a",
    },
    current: current(),
    history: {},
    ...overrides,
  };
}

describe("pure current-effective Takoform admission projection", () => {
  test("uses principal > tenant+space > tenant > host activation precedence", () => {
    const decision = evaluateAdmissionProjection(input("create"));
    expect(decision.allowed).toBe(true);
    expect(decision.mode).toBe("mutation");
    expect(decision.effectiveAudience).toEqual({
      kind: "principal",
      tenantId: "tenant-a",
      principalId: "principal-a",
    });

    const withoutPrincipal = evaluateAdmissionProjection(
      input("create", {
        current: current({
          activations: [
            activation({ kind: "host", hostId: "host-a" }),
            activation({ kind: "tenant", tenantId: "tenant-a" }),
            activation({ kind: "space", tenantId: "tenant-a", space: "space-a" }),
          ],
        }),
      }),
    );
    expect(withoutPrincipal.effectiveAudience).toEqual({
      kind: "space",
      tenantId: "tenant-a",
      space: "space-a",
    });

    const withoutSpace = evaluateAdmissionProjection(
      input("create", {
        current: current({
          activations: [
            activation({ kind: "host", hostId: "host-a" }),
            activation({ kind: "tenant", tenantId: "tenant-a" }),
          ],
        }),
      }),
    );
    expect(withoutSpace.effectiveAudience).toEqual({ kind: "tenant", tenantId: "tenant-a" });
  });

  test("requires tenant identity when resolving a space audience", () => {
    const decision = evaluateAdmissionProjection(
      input("create", {
        context: { hostId: "host-a", space: "space-a", principalId: "principal-a" },
        current: current({
          activations: [activation({ kind: "space", tenantId: "tenant-a", space: "space-a" })],
        }),
      }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.map((reason) => reason.code)).toContain("space_tenant_required");
  });

  test("uses current heads only; historical allow/install facts cannot bypass current deny/uninstall", () => {
    const decision = evaluateAdmissionProjection(
      input("create", {
        current: current({
          publisher: publisher(),
          install: install(digest("5"), { eventType: "uninstall" }),
        }),
        history: {
          publishers: [publisher("external.publisher")],
          installs: [install()],
        },
      }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.map((reason) => reason.code)).toEqual(
      expect.arrayContaining(["package_uninstalled"]),
    );

    const deniedPublisher = evaluateAdmissionProjection(
      input("create", {
        current: current({ publisher: { ...publisher(), eventType: "deny" } }),
        history: { publishers: [publisher()] },
      }),
    );
    expect(deniedPublisher.allowed).toBe(false);
    expect(deniedPublisher.reasons.map((reason) => reason.code)).toContain("publisher_denied");
  });

  test("requires a verified non-stale checkpoint bound to the current publisher policy", () => {
    const stale = evaluateAdmissionProjection(
      input("create", { current: current({ checkpoint: checkpoint({ stale: true }) }) }),
    );
    expect(stale.allowed).toBe(false);
    expect(stale.reasons.map((reason) => reason.code)).toContain("checkpoint_stale");

    const unbound = evaluateAdmissionProjection(
      input("create", {
        current: current({
          checkpoint: checkpoint({ policyEventDigest: digest("9") }),
        }),
      }),
    );
    expect(unbound.allowed).toBe(false);
    expect(unbound.reasons.map((reason) => reason.code)).toContain("checkpoint_policy_mismatch");
  });

  test("requires support to list the requested mutation operation", () => {
    const createWithReadSupport = evaluateAdmissionProjection(
      input("create", {
        current: current({
          support: support(digest("5"), digest("6"), { operations: ["create", "read"] }),
        }),
      }),
    );
    expect(createWithReadSupport.allowed).toBe(true);

    const unsupported = evaluateAdmissionProjection(
      input("update", {
        current: current({
          support: support(digest("5"), digest("6"), { operations: ["create"] }),
        }),
      }),
    );
    expect(unsupported.allowed).toBe(false);
    expect(unsupported.reasons.map((reason) => reason.code)).toContain(
      "support_operation_unsupported",
    );

    const missingOperations = evaluateAdmissionProjection(
      input("create", {
        current: current({
          support: { ...support(), operations: undefined as never },
        }),
      }),
    );
    expect(missingOperations.allowed).toBe(false);
    expect(missingOperations.reasons.map((reason) => reason.code)).toContain(
      "support_operations_invalid",
    );

    for (const operation of ["prepare", "activate", "evacuate"] as const) {
      const invalidFacts = evaluateAdmissionProjection(
        input("create", {
          current: current({
            support: support(digest("5"), digest("6"), {
              operations: ["create", operation] as never,
            }),
          }),
        }),
      );
      expect(invalidFacts.allowed).toBe(false);
      expect(invalidFacts.reasons.map((reason) => reason.code)).toContain("fact_invalid");
    }
  });

  test("fails closed on malformed activation, retention, and history array elements", () => {
    const malformedActivation = evaluateAdmissionProjection(
      input("create", {
        current: current({ activations: [null as never] }),
      }),
    );
    expect(malformedActivation.allowed).toBe(false);
    expect(malformedActivation.reasons.map((reason) => reason.code)).toContain("fact_invalid");

    const resource = {
      resourceUid: "resource-array-check",
      tenantId: "tenant-a",
      space: "space-a",
      formRef: FORM_REF,
      packageDigest: digest("5"),
      implementationDigest: digest("6"),
    } as const;
    const malformedRetention = evaluateAdmissionProjection(
      input("delete", {
        current: current({ retentions: [null as never] }),
        history: { installs: [install()] },
        resource,
      }),
    );
    expect(malformedRetention.allowed).toBe(false);
    expect(malformedRetention.reasons.map((reason) => reason.code)).toContain("fact_invalid");

    const malformedHistory = evaluateAdmissionProjection(
      input("delete", {
        current: current(),
        history: { installs: [null as never] },
        resource,
      }),
    );
    expect(malformedHistory.allowed).toBe(false);
    expect(malformedHistory.reasons.map((reason) => reason.code)).toContain("fact_invalid");
  });

  test("fails closed on sparse authority arrays just like explicit undefined elements", () => {
    const resource = {
      resourceUid: "resource-sparse-arrays",
      tenantId: "tenant-a",
      space: "space-a",
      formRef: FORM_REF,
      packageDigest: digest("5"),
      implementationDigest: digest("6"),
    } as const;

    const sparseOperations = new Array<AdmissionProjectionSupport["operations"][number]>(1);
    const denseUndefinedOperations = [undefined as never];
    for (const operations of [sparseOperations, denseUndefinedOperations]) {
      const decision = evaluateAdmissionProjection(
        input("create", {
          current: current({ support: support(digest("5"), digest("6"), { operations }) }),
        }),
      );
      expect(decision.allowed).toBe(false);
      expect(decision.reasons.map((reason) => reason.code)).toContain("fact_invalid");
      expect(decision.reasons.map((reason) => reason.code)).toContain("support_operations_invalid");
    }

    const sparseActivations = new Array<AdmissionProjectionActivation>(1);
    const denseUndefinedActivations = [undefined as never];
    for (const activations of [sparseActivations, denseUndefinedActivations]) {
      const decision = evaluateAdmissionProjection(
        input("create", { current: current({ activations }) }),
      );
      expect(decision.allowed).toBe(false);
      expect(decision.reasons.map((reason) => reason.code)).toContain("fact_invalid");
    }

    const sparseRetentions = new Array<AdmissionProjectionRetention>(1);
    const denseUndefinedRetentions = [undefined as never];
    for (const retentions of [sparseRetentions, denseUndefinedRetentions]) {
      const decision = evaluateAdmissionProjection(
        input("delete", {
          current: current({ retentions }),
          history: { installs: [install()] },
          resource,
        }),
      );
      expect(decision.allowed).toBe(false);
      expect(decision.reasons.map((reason) => reason.code)).toContain("fact_invalid");
    }

    const sparseInstalls = new Array<AdmissionProjectionInstall>(1);
    const denseUndefinedInstalls = [undefined as never];
    for (const installs of [sparseInstalls, denseUndefinedInstalls]) {
      const decision = evaluateAdmissionProjection(
        input("delete", {
          current: current(),
          history: { installs },
          resource,
        }),
      );
      expect(decision.allowed).toBe(false);
      expect(decision.reasons.map((reason) => reason.code)).toContain("fact_invalid");
    }

    // `install` is a singular current head, but a malformed adapter can still
    // supply an array at this boundary. It must not become an implicit set of
    // current installs or authorize a mutation.
    const sparseCurrentInstalls = new Array<AdmissionProjectionInstall>(1);
    const denseUndefinedCurrentInstalls = [undefined as never];
    for (const installHead of [sparseCurrentInstalls, denseUndefinedCurrentInstalls]) {
      const decision = evaluateAdmissionProjection(
        input("create", { current: current({ install: installHead as never }) }),
      );
      expect(decision.allowed).toBe(false);
      expect(decision.reasons.map((reason) => reason.code)).toContain("fact_invalid");
    }

    const sparseRevocations = new Array<
      AdmissionProjectionCheckpoint["revokedPackageDigests"][number]
    >(1);
    const denseUndefinedRevocations = [undefined as never];
    for (const revokedPackageDigests of [sparseRevocations, denseUndefinedRevocations]) {
      const decision = evaluateAdmissionProjection(
        input("create", {
          current: current({ checkpoint: checkpoint({ revokedPackageDigests }) }),
        }),
      );
      expect(decision.allowed).toBe(false);
      expect(decision.reasons.map((reason) => reason.code)).toContain("fact_invalid");
      expect(decision.reasons.map((reason) => reason.code)).toContain(
        "checkpoint_revocation_unknown",
      );
    }
  });

  test("rejects protocol phases that are not Resource lifecycle operations", () => {
    for (const operation of ["prepare", "activate"] as const) {
      expect(() =>
        evaluateAdmissionProjection(input("create", { operation: operation as never })),
      ).toThrow("admission projection operation is invalid");
    }
  });

  test("revocation blocks mutation but allows exact retained-resource cleanup", () => {
    const packageDigest = digest("5");
    const implementationDigest = digest("6");
    const resource = {
      resourceUid: "resource-001",
      tenantId: "tenant-a",
      space: "space-a",
      formRef: FORM_REF,
      packageDigest,
      implementationDigest,
    } as const;
    for (const operation of ["create", "import", "update"] as const) {
      const revoked = evaluateAdmissionProjection(
        input(operation, {
          current: current({ checkpoint: checkpoint({ revokedPackageDigests: [packageDigest] }) }),
        }),
      );
      expect(revoked.allowed).toBe(false);
      expect(revoked.reasons.map((reason) => reason.code)).toContain("package_revoked");
    }

    const cleanup = evaluateAdmissionProjection(
      input("delete", {
        current: current({ checkpoint: checkpoint({ revokedPackageDigests: [packageDigest] }) }),
        history: { installs: [install(packageDigest)] },
        resource,
      }),
    );
    expect(cleanup).toEqual({
      allowed: true,
      mode: "retained-cleanup",
      reasons: [
        { code: "retained_cleanup", message: "exact retained Resource identity may be cleaned up" },
      ],
    });
  });

  test("replaced packages are denied for new resources but retained for exact historical cleanup", () => {
    const oldPackage = digest("5");
    const newPackage = digest("7");
    const oldImplementation = digest("6");
    const newImplementation = digest("8");
    const resource = {
      resourceUid: "resource-old",
      tenantId: "tenant-a",
      space: "space-a",
      formRef: FORM_REF,
      packageDigest: oldPackage,
      implementationDigest: oldImplementation,
    } as const;
    const oldMutation = evaluateAdmissionProjection(
      input("create", {
        packageDigest: oldPackage,
        implementationDigest: oldImplementation,
        current: current({
          install: install(newPackage, { eventType: "replace" }),
          support: support(newPackage, newImplementation),
          activations: [
            activation(
              { kind: "host", hostId: "host-a" },
              {
                packageDigest: newPackage,
                implementationDigest: newImplementation,
              },
            ),
          ],
        }),
        history: { installs: [install(oldPackage)] },
      }),
    );
    expect(oldMutation.allowed).toBe(false);
    expect(oldMutation.reasons.map((reason) => reason.code)).toContain("package_not_current");

    const oldCleanup = evaluateAdmissionProjection(
      input("evacuate", {
        packageDigest: oldPackage,
        implementationDigest: oldImplementation,
        current: current({
          install: install(newPackage, { eventType: "replace" }),
          support: support(newPackage, newImplementation),
          activations: [],
        }),
        history: { installs: [install(oldPackage)] },
        resource,
      }),
    );
    expect(oldCleanup.allowed).toBe(true);
    expect(oldCleanup.mode).toBe("retained-cleanup");
  });

  test("requires a current retained-byte claim in addition to install history", () => {
    const resource = {
      resourceUid: "resource-retained",
      tenantId: "tenant-a",
      space: "space-a",
      formRef: FORM_REF,
      packageDigest: digest("5"),
      implementationDigest: digest("6"),
    } as const;
    const base = input("delete", { resource, history: { installs: [install()] } });

    const missing = evaluateAdmissionProjection(
      input("delete", {
        ...base,
        current: current({ retentions: [] }),
      }),
    );
    expect(missing.allowed).toBe(false);
    expect(missing.reasons.map((reason) => reason.code)).toContain("retention_missing");

    const purged = evaluateAdmissionProjection(
      input("delete", {
        ...base,
        current: current({
          retentions: [retention(digest("5"), digest("6"), { retained: false })],
        }),
      }),
    );
    expect(purged.allowed).toBe(false);
    expect(purged.reasons.map((reason) => reason.code)).toContain("package_purged");

    const implementationMismatch = evaluateAdmissionProjection(
      input("delete", {
        ...base,
        current: current({
          retentions: [retention(digest("5"), digest("9"))],
        }),
      }),
    );
    expect(implementationMismatch.allowed).toBe(false);
    expect(implementationMismatch.reasons.map((reason) => reason.code)).toContain(
      "retained_package_implementation_mismatch",
    );

    const installImplementationMismatch = evaluateAdmissionProjection(
      input("delete", {
        ...base,
        current: current({
          install: install(digest("5"), { implementationDigest: digest("9") }),
          retentions: [retention(digest("5"), digest("6"))],
        }),
        history: {},
      }),
    );
    expect(installImplementationMismatch.allowed).toBe(false);
    expect(installImplementationMismatch.reasons.map((reason) => reason.code)).toContain(
      "retained_package_implementation_mismatch",
    );
  });

  test("does not distinguish publisher labels; external identities use the same path", () => {
    const external = evaluateAdmissionProjection(input("create"));
    const otherPublisher = { ...publisher("another.publisher"), eventType: "rotate" as const };
    const other = evaluateAdmissionProjection(
      input("create", {
        current: current({
          publisher: otherPublisher,
          checkpoint: checkpoint({ publisherKey: otherPublisher.publisherKey }),
          install: install(digest("5"), { publisherKey: otherPublisher.publisherKey }),
        }),
      }),
    );
    expect(external.allowed).toBe(true);
    expect(other.allowed).toBe(true);
    expect(Object.hasOwn(external, "official")).toBe(false);
    expect(Object.hasOwn(other, "official")).toBe(false);
  });

  test("binds a present install implementation while retaining package-level compatibility when absent", () => {
    const mismatched = evaluateAdmissionProjection(
      input("create", {
        current: current({
          install: install(digest("5"), { implementationDigest: digest("9") }),
        }),
      }),
    );
    expect(mismatched.allowed).toBe(false);
    expect(mismatched.reasons.map((reason) => reason.code)).toContain(
      "install_implementation_mismatch",
    );

    const packageLevel = evaluateAdmissionProjection(
      input("create", {
        current: current({
          install: install(digest("5"), { implementationDigest: undefined as never }),
        }),
      }),
    );
    expect(packageLevel.allowed).toBe(true);
  });

  test("fails closed without throwing for malformed form, digest, sequence, or bounded identity facts", () => {
    const malformedForm = evaluateAdmissionProjection(
      input("create", {
        formRef: { ...FORM_REF, schemaDigest: "sha256:not-a-digest" as never },
      }),
    );
    expect(malformedForm.allowed).toBe(false);
    expect(malformedForm.reasons.map((reason) => reason.code)).toContain("form_ref_invalid");

    const extraFormField = evaluateAdmissionProjection(
      input("create", { formRef: { ...FORM_REF, extra: true } as never }),
    );
    expect(extraFormField.allowed).toBe(false);
    expect(extraFormField.reasons.map((reason) => reason.code)).toContain("form_ref_invalid");

    const malformedDigest = evaluateAdmissionProjection(
      input("create", { packageDigest: "sha256:not-a-digest" as never }),
    );
    expect(malformedDigest.allowed).toBe(false);
    expect(malformedDigest.reasons.map((reason) => reason.code)).toContain("digest_invalid");

    const malformedCheckpoint = evaluateAdmissionProjection(
      input("create", { current: current({ checkpoint: checkpoint({ sequence: 0 }) }) }),
    );
    expect(malformedCheckpoint.allowed).toBe(false);
    expect(malformedCheckpoint.reasons.map((reason) => reason.code)).toContain(
      "checkpoint_sequence_invalid",
    );

    const malformedIdentity = evaluateAdmissionProjection(
      input("create", { context: { ...input("create").context, hostId: "h".repeat(256) } }),
    );
    expect(malformedIdentity.allowed).toBe(false);
    expect(malformedIdentity.reasons.map((reason) => reason.code)).toContain("identity_invalid");

    const malformedCurrentFact = evaluateAdmissionProjection(
      input("create", {
        current: current({
          publisher: { ...publisher(), eventDigest: "sha256:not-a-digest" as never },
        }),
      }),
    );
    expect(malformedCurrentFact.allowed).toBe(false);
    expect(malformedCurrentFact.reasons.map((reason) => reason.code)).toContain("fact_invalid");

    const malformedResource = evaluateAdmissionProjection(
      input("delete", {
        resource: {
          resourceUid: "u".repeat(256),
          tenantId: "tenant-a",
          space: "space-a",
          formRef: FORM_REF,
          packageDigest: digest("5"),
          implementationDigest: digest("6"),
        },
        history: { installs: [install()] },
      }),
    );
    expect(malformedResource.allowed).toBe(false);
    expect(malformedResource.reasons.map((reason) => reason.code)).toContain("identity_invalid");
  });

  test("fails closed when required facts are absent or audience is unknown", () => {
    const missing = evaluateAdmissionProjection({
      operation: "create",
      formRef: FORM_REF,
      packageDigest: digest("5"),
      implementationDigest: digest("6"),
      current: {},
      history: {},
    });
    expect(missing.allowed).toBe(false);
    expect(missing.reasons.map((reason) => reason.code)).toEqual(
      expect.arrayContaining([
        "context_missing",
        "publisher_missing",
        "checkpoint_missing",
        "package_not_current",
        "support_missing",
        "activation_missing",
      ]),
    );

    const unknownAudience = evaluateAdmissionProjection(
      input("create", {
        current: current({
          activations: [
            {
              ...activation({ kind: "host", hostId: "host-a" }),
              audience: { kind: "region", value: "unknown" } as never,
            },
          ],
        }),
      }),
    );
    expect(unknownAudience.allowed).toBe(false);
    expect(unknownAudience.reasons.map((reason) => reason.code)).toContain(
      "activation_unknown_audience",
    );
  });

  test("denies cleanup without an exact retained Resource identity", () => {
    const decision = evaluateAdmissionProjection(input("delete"));
    expect(decision.allowed).toBe(false);
    expect(decision.mode).toBe("retained-cleanup");
    expect(decision.reasons.map((reason) => reason.code)).toContain("retained_resource_required");
  });

  test("does not let a lower audience bypass a higher inactive audience", () => {
    const decision = evaluateAdmissionProjection(
      input("create", {
        current: current({
          activations: [
            activation({ kind: "tenant", tenantId: "tenant-a" }),
            activation(
              { kind: "principal", tenantId: "tenant-a", principalId: "principal-a" },
              { active: false },
            ),
          ],
        }),
      }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.effectiveAudience).toEqual({
      kind: "principal",
      tenantId: "tenant-a",
      principalId: "principal-a",
    });
    expect(decision.reasons.map((reason) => reason.code)).toContain("activation_inactive");
  });

  test("does not use a historical support or activation event as current truth", () => {
    const history: AdmissionProjectionHistory = {
      supports: [support()],
      activations: [activation({ kind: "host", hostId: "host-a" })],
    };
    const decision = evaluateAdmissionProjection(
      input("create", {
        current: current({ support: null, activations: [] }),
        history,
      }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.map((reason) => reason.code)).toEqual(
      expect.arrayContaining(["support_missing", "activation_missing"]),
    );
  });

  test("allows the same audience for different Form heads but rejects an exact duplicate head", () => {
    const differentForm = {
      ...activation({ kind: "host", hostId: "host-a" }),
      formRef: OTHER_FORM_REF,
    };
    const differentFormDecision = evaluateAdmissionProjection(
      input("create", {
        current: current({
          activations: [activation({ kind: "host", hostId: "host-a" }), differentForm],
        }),
      }),
    );
    expect(differentFormDecision.allowed).toBe(true);

    expect(() =>
      evaluateAdmissionProjection(
        input("create", {
          current: current({
            activations: [
              activation({ kind: "host", hostId: "host-a" }),
              activation({ kind: "host", hostId: "host-a" }),
            ],
          }),
        }),
      ),
    ).toThrow("duplicate current activation head");
  });

  test("rejects duplicate activation chain heads even when only implementation differs, in either order", () => {
    const first = activation(
      { kind: "host", hostId: "host-a" },
      { implementationDigest: digest("6") },
    );
    const second = activation(
      { kind: "host", hostId: "host-a" },
      { implementationDigest: digest("9") },
    );
    for (const activations of [
      [first, second],
      [second, first],
    ]) {
      expect(() =>
        evaluateAdmissionProjection(input("create", { current: current({ activations }) })),
      ).toThrow("duplicate current activation head");
    }
  });

  test("ignores unknown audiences on another Form while denying unknown relevant audiences", () => {
    const unrelatedUnknown = evaluateAdmissionProjection(
      input("create", {
        current: current({
          activations: [
            activation({ kind: "host", hostId: "host-a" }),
            {
              ...activation({ kind: "host", hostId: "host-a" }),
              formRef: OTHER_FORM_REF,
              implementationDigest: "sha256:not-a-digest" as never,
              audience: { kind: "region", value: "unknown" },
            } as never,
          ],
        }),
      }),
    );
    expect(unrelatedUnknown.allowed).toBe(true);

    const relevantUnknown = evaluateAdmissionProjection(
      input("create", {
        current: current({
          activations: [
            {
              ...activation({ kind: "host", hostId: "host-a" }),
              audience: { kind: "region", value: "unknown" },
            } as never,
          ],
        }),
      }),
    );
    expect(relevantUnknown.allowed).toBe(false);
    expect(relevantUnknown.reasons.map((reason) => reason.code)).toContain(
      "activation_unknown_audience",
    );
  });

  test("rejects a retained resource whose tenant/space or identity does not match", () => {
    const decision = evaluateAdmissionProjection(
      input("observe", {
        resource: {
          resourceUid: "resource-001",
          tenantId: "other-tenant",
          space: "space-a",
          formRef: OTHER_FORM_REF,
          packageDigest: digest("5"),
          implementationDigest: digest("6"),
        },
        history: { installs: [install()] },
      }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.map((reason) => reason.code)).toContain("retained_resource_mismatch");
  });
});
