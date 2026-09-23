import { describe, expect, test } from "bun:test";
import {
  type ApplyInput,
  failed,
  failedWithoutProviderMutation,
  type Provider,
  type ProviderApplyCompensationInput,
  type ProviderApplyNoEffectConclusionInput,
  type ProviderExecutionAuthority,
  type ProviderOffering,
  type ProviderTicket,
  providerFailureProvesNoMutation,
  providerFailureProvesWholeOperationCompensated,
  providerFailureProvesWholeOperationNoMutation,
} from "../src/provider-port.ts";
import {
  CLOUDFLARE_PROVIDER_EXECUTOR_ADOPTION_ABORT_SCHEMA,
  CLOUDFLARE_PROVIDER_EXECUTOR_APPLY_ABORT_SCHEMA,
  CLOUDFLARE_PROVIDER_EXECUTOR_APPLY_COMPENSATION_SCHEMA,
  CLOUDFLARE_PROVIDER_EXECUTOR_APPLY_NO_EFFECT_SCHEMA,
  CLOUDFLARE_PROVIDER_EXECUTOR_NO_MUTATION_SCHEMA,
  type CloudflareProviderAdoptionRecoveryResult,
  type CloudflareProviderApplyCompensationResult,
  type CloudflareProviderApplyConvergenceResult,
  type CloudflareProviderApplyNoEffectConclusionResult,
  type CloudflareProviderExecutorRpc,
  type CloudflareProviderInitialMutationResult,
} from "../src/providers/cloudflare-provider-executor-port.ts";
import { CloudflareProviderProxy } from "../src/providers/cloudflare-provider-proxy.ts";

type Action = "apply" | "delete" | "adopt";
type DeleteInput = Parameters<Provider["delete"]>[0];
type AdoptInput = Parameters<NonNullable<Provider["adopt"]>>[0];
type InitialInput = ApplyInput | DeleteInput | AdoptInput;
type InitialHandler = (action: Action, input: InitialInput) => unknown | Promise<unknown>;

const installationId = "cloudflare.installation";
const authority: ProviderExecutionAuthority = {
  tenantId: "tenant-1",
  resourceUid: "resource-1",
  leaseToken: "lease-token-1",
  fingerprint: "fingerprint-1",
};
const identity = {
  tenantRef: authority.tenantId,
  space: "default",
  name: "worker",
  uid: authority.resourceUid,
};
const offering = {} as ProviderOffering;

describe("Cloudflare provider executor no-mutation bridge", () => {
  test("apply-abort evidence requires exact snapshotted recovery identity and closed shape", async () => {
    const input = makeInput("apply", { operationMode: "recovery" });
    const mutations: readonly (readonly [readonly string[], unknown])[] = [
      [["phase"], "succeeded"],
      [["extra"], true],
      [["failure", "extra"], true],
      [["failure", "retryable"], true],
      [["failure", "code"], "bogus"],
      [["failure", "message"], ""],
      [["executorNoMutation"], {}],
      [["executorAdoptionAbort"], {}],
      [["executorApplyAbort", "extra"], true],
      [["executorApplyAbort", "schema"], "wrong"],
      [["executorApplyAbort", "action"], "recoverAdopt"],
      [["executorApplyAbort", "operationId"], "wrong"],
      [["executorApplyAbort", "providerInstallationRef"], "wrong"],
      ...["tenantId", "resourceUid", "leaseToken", "fingerprint", "extra"].map(
        (key) => [["executorApplyAbort", "executionAuthority", key], "wrong"] as const,
      ),
    ];
    for (const [path, value] of mutations) {
      const proof = structuredClone(applyAbortFor(input)) as unknown as Record<string, unknown>;
      let parent = proof;
      for (const key of path.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
      const key = path.at(-1);
      if (key === undefined) throw new Error("missing mutation path");
      parent[key] = value;
      const ticket = await createProxy(
        createBinding(() => proof, proof as unknown as ProviderTicket),
      ).convergeApply(input);
      expect(ticket).toMatchObject({
        phase: "failed",
        failure: { code: "unavailable", retryable: true },
      });
      expect(providerFailureProvesWholeOperationNoMutation(ticket, input.operationId)).toBe(false);
    }
    const proof = applyAbortFor(input);
    const { operationMode: _mode, ...withoutMode } = input;
    const { executionAuthority: _authority, ...withoutAuthority } = input;
    for (const altered of [
      { ...input, operationMode: "initial" as const },
      withoutMode,
      withoutAuthority,
      { ...input, providerHandle: "handle" },
      { ...input, previous: { nativeId: "existing", spec: {} } },
      { ...input, identity: { ...input.identity, uid: "wrong" } },
      { ...input, identity: { ...input.identity, tenantRef: "wrong" } },
    ]) {
      const ticket = await createProxy(createBinding(() => proof, proof)).convergeApply(altered);
      expect(ticket).toMatchObject({
        phase: "failed",
        failure: { code: "unavailable", retryable: true },
      });
    }
    let resolve!: (value: unknown) => void;
    const response = new Promise<unknown>((done) => {
      resolve = done;
    });
    const binding = createBinding(() => failed("unavailable", "unused", true));
    binding.convergeApply = async () =>
      (await response) as CloudflareProviderApplyConvergenceResult;
    const pending = createProxy(binding).convergeApply(input);
    Object.assign(input, { operationId: "changed", previous: { nativeId: "changed" } });
    Object.assign(input.identity, { uid: "changed" });
    if (!input.executionAuthority) throw new Error("missing execution authority");
    Object.assign(input.executionAuthority, { leaseToken: "changed" });
    resolve(structuredClone(proof));
    expect(providerFailureProvesWholeOperationNoMutation(await pending, "operation-1")).toBe(true);
  });
  test("restores exact whole-operation apply abort only from convergence", async () => {
    const input = makeInput("apply", { operationMode: "recovery" }) as ApplyInput;
    const remote = {
      phase: "failed",
      failure: {
        code: "conflict",
        message: "the exact apply was durably fenced",
        retryable: false,
      },
      executorApplyAbort: {
        schema: "takoserver.cloudflare-provider-executor-apply-abort@v1",
        action: "convergeApply",
        operationId: input.operationId,
        providerInstallationRef: installationId,
        executionAuthority: structuredClone(input.executionAuthority),
      },
    };
    const proxy = createProxy(createBinding(() => remote, remote as unknown as ProviderTicket));
    const ticket = await proxy.convergeApply(input);
    expect(providerFailureProvesWholeOperationNoMutation(ticket, input.operationId)).toBe(true);
    expect(providerFailureProvesNoMutation(ticket, input.operationId)).toBe(false);
    expect(Object.hasOwn(ticket, "executorApplyAbort")).toBe(false);
    for (const wrong of [
      await proxy.apply(input),
      await proxy.recoverApply(input),
      await proxy.poll({
        operationId: input.operationId,
        handle: "handle",
        executionAuthority: authority,
      }),
    ]) {
      expect(wrong).toMatchObject({
        phase: "failed",
        failure: { code: "unavailable", retryable: true },
      });
      expect(providerFailureProvesWholeOperationNoMutation(wrong, input.operationId)).toBe(false);
    }
  });
  test("restores cloned no-mutation evidence for initial apply, delete, and adopt", async () => {
    for (const action of ["apply", "delete", "adopt"] as const) {
      const input = makeInput(action);
      const proxy = createProxy(createBinding(() => proofFor(action, input)));

      const ticket = await invoke(proxy, action, input);

      expect(providerFailureProvesNoMutation(ticket, "operation-1")).toBe(true);
      expect(ticket).toEqual({
        phase: "failed",
        failure: {
          code: "conflict",
          message: "native identity is already present",
          retryable: false,
        },
      });
      expect(Object.hasOwn(ticket, "executorNoMutation")).toBe(false);
    }
  });

  test("refuses evidence with mismatched action, operation, installation, or authority", async () => {
    const mismatches: readonly [string, (proof: MutableProof) => void][] = [
      ["schema", (proof) => (proof.executorNoMutation.schema = "other-schema")],
      ["action", (proof) => (proof.executorNoMutation.action = "delete")],
      ["operation id", (proof) => (proof.executorNoMutation.operationId = "other-operation")],
      [
        "installation",
        (proof) => (proof.executorNoMutation.providerInstallationRef = "other-installation"),
      ],
      [
        "tenant",
        (proof) => (proof.executorNoMutation.executionAuthority.tenantId = "other-tenant"),
      ],
      [
        "resource uid",
        (proof) => (proof.executorNoMutation.executionAuthority.resourceUid = "other-resource"),
      ],
      [
        "lease token",
        (proof) => (proof.executorNoMutation.executionAuthority.leaseToken = "other-lease"),
      ],
      [
        "fingerprint",
        (proof) => (proof.executorNoMutation.executionAuthority.fingerprint = "other-fingerprint"),
      ],
    ];

    for (const [name, mutate] of mismatches) {
      const input = makeInput("apply");
      const malformed = mutateProof(proofFor("apply", input), mutate);
      const ticket = await createProxy(createBinding(() => malformed)).apply(input);
      expectUnavailable(ticket, name);
    }
  });

  test("requires the snapshotted identity and initial execution authority", async () => {
    const original = makeInput("apply");
    const proof = proofFor("apply", original);
    const { executionAuthority: _authority, ...withoutAuthority } = original;
    const { operationMode: _mode, ...withoutMode } = original;
    const cases = [
      ["tenant mismatch", makeInput("apply", { identity: { ...identity, tenantRef: "tenant-2" } })],
      [
        "resource uid mismatch",
        makeInput("apply", { identity: { ...identity, uid: "resource-2" } }),
      ],
      ["missing authority", withoutAuthority],
      ["recovery mode", makeInput("apply", { operationMode: "recovery" })],
      ["missing mode", withoutMode],
    ] as const;

    for (const [name, input] of cases) {
      const ticket = await createProxy(createBinding(() => proof)).apply(input);
      expectUnavailable(ticket, name);
    }
  });

  test("rejects extra keys and malformed failure data at every proof level", async () => {
    const input = makeInput("apply");
    const malformed: readonly [string, (proof: MutableProof) => void][] = [
      ["ticket key", (proof) => (proof.debug = true)],
      ["failure key", (proof) => (proof.failure.debug = true)],
      ["evidence key", (proof) => (proof.executorNoMutation.debug = true)],
      ["authority key", (proof) => (proof.executorNoMutation.executionAuthority.debug = true)],
      ["retryable failure", (proof) => (proof.failure.retryable = true)],
      ["unknown failure code", (proof) => (proof.failure.code = "other")],
      ["empty message", (proof) => (proof.failure.message = "")],
      ["oversized message", (proof) => (proof.failure.message = "x".repeat(1_025))],
    ];

    for (const [name, mutate] of malformed) {
      const result = mutateProof(proofFor("apply", input), mutate);
      const ticket = await createProxy(createBinding(() => result)).apply(input);
      expectUnavailable(ticket, name);
    }
  });

  test("keeps ordinary RPC failures ordinary and does not trust a cloned local proof", async () => {
    const ordinary = failed("conflict", "ordinary provider refusal", false);
    const ordinaryResult = await createProxy(createBinding(() => ordinary)).apply(
      makeInput("apply"),
    );
    expect(ordinaryResult).toEqual(ordinary);
    expect(providerFailureProvesNoMutation(ordinaryResult, "operation-1")).toBe(false);

    const localProof = failedWithoutProviderMutation(
      "operation-1",
      "conflict",
      "local proof cannot cross RPC",
    );
    const clonedLegacyTicket = structuredClone(localProof);
    const clonedResult = await createProxy(createBinding(() => clonedLegacyTicket)).apply(
      makeInput("apply"),
    );
    expect(clonedResult).toEqual(clonedLegacyTicket);
    expect(providerFailureProvesNoMutation(clonedResult, "operation-1")).toBe(false);
  });

  test("uses context captured before the RPC promise resolves", async () => {
    const input = makeInput("apply");
    const proof = proofFor("apply", input);
    let resolveResult: ((value: unknown) => void) | undefined;
    const pendingResult = new Promise<unknown>((resolve) => {
      resolveResult = resolve;
    });
    const proxy = createProxy(createBinding(() => pendingResult));
    const pendingTicket = proxy.apply(input);

    Object.assign(input, { operationId: "changed-operation" });
    Object.assign(input.identity, { tenantRef: "changed-tenant", uid: "changed-resource" });
    Object.assign(input.executionAuthority as object, { leaseToken: "changed-lease" });
    resolveResult?.(structuredClone(proof));

    const ticket = await pendingTicket;
    expect(providerFailureProvesNoMutation(ticket, "operation-1")).toBe(true);
  });

  test("recovery and polling RPCs do not restore cloned no-mutation tickets", async () => {
    const legacy = failedWithoutProviderMutation("operation-1", "conflict", "recovery ticket");
    const proxy = createProxy(createBinding(() => failed("unavailable", "unused", true), legacy));
    const apply = makeInput("apply");
    const deletion = makeInput("delete");
    const adoption = makeInput("adopt");
    const recovered = await Promise.all([
      proxy.recoverApply(apply as ApplyInput),
      proxy.convergeApply(apply as ApplyInput),
      proxy.recoverDelete(deletion as DeleteInput),
      proxy.recoverAdopt(adoption as AdoptInput),
      proxy.poll({ operationId: "operation-1", handle: "handle-1", executionAuthority: authority }),
    ]);

    for (const ticket of recovered) {
      expect(ticket).toEqual(legacy);
      expect(providerFailureProvesNoMutation(ticket, "operation-1")).toBe(false);
    }
  });

  test("restores a cloned whole-operation abort only from recoverAdopt", async () => {
    const input = makeAdoptionRecoveryInput();
    const remoteAbort = adoptionAbortFor(input);
    const ticket = await createProxy(
      createBinding(() => failed("unavailable", "unused", true), remoteAbort),
    ).recoverAdopt(input);

    expect(ticket).toEqual({
      phase: "failed",
      failure: {
        code: "conflict",
        message: "the adoption was durably aborted before provider effects",
        retryable: false,
      },
    });
    expect(Object.hasOwn(ticket, "executorAdoptionAbort")).toBe(false);
    expect(providerFailureProvesWholeOperationNoMutation(ticket, "operation-1")).toBe(true);
    expect(providerFailureProvesNoMutation(ticket, "operation-1")).toBe(false);
  });

  test("refuses adoption-abort evidence with mismatched recovery context", async () => {
    const baseInput = makeAdoptionRecoveryInput();
    const mismatches: readonly [string, (abort: MutableAdoptionAbort) => void][] = [
      ["schema", (abort) => (abort.executorAdoptionAbort.schema = "other-schema")],
      ["action", (abort) => (abort.executorAdoptionAbort.action = "adopt")],
      ["operation id", (abort) => (abort.executorAdoptionAbort.operationId = "other-operation")],
      [
        "installation",
        (abort) => (abort.executorAdoptionAbort.providerInstallationRef = "other-installation"),
      ],
      [
        "tenant",
        (abort) => (abort.executorAdoptionAbort.executionAuthority.tenantId = "other-tenant"),
      ],
      [
        "resource uid",
        (abort) => (abort.executorAdoptionAbort.executionAuthority.resourceUid = "other-resource"),
      ],
      [
        "lease token",
        (abort) => (abort.executorAdoptionAbort.executionAuthority.leaseToken = "other-lease"),
      ],
      [
        "fingerprint",
        (abort) =>
          (abort.executorAdoptionAbort.executionAuthority.fingerprint = "other-fingerprint"),
      ],
      [
        "evidence handle",
        (abort) => (abort.executorAdoptionAbort.providerHandle = "unexpected-handle"),
      ],
      ["ticket key", (abort) => (abort.debug = true)],
      ["failure key", (abort) => (abort.failure.debug = true)],
      ["authority key", (abort) => (abort.executorAdoptionAbort.executionAuthority.debug = true)],
      ["retryable failure", (abort) => (abort.failure.retryable = true)],
    ];

    for (const [name, mutate] of mismatches) {
      const malformed = mutateAdoptionAbort(adoptionAbortFor(baseInput), mutate);
      const ticket = await createProxy(
        createBinding(() => failed("unavailable", "unused", true), malformed),
      ).recoverAdopt(baseInput);
      expectUnavailable(ticket, name, "Provider executor returned invalid adoption-abort evidence");
    }
  });

  test("requires recovery mode, no provider handle, and authority matching the identity", async () => {
    const baseInput = makeAdoptionRecoveryInput();
    const proof = adoptionAbortFor(baseInput);
    const { operationMode: _mode, ...withoutMode } = baseInput;
    const { executionAuthority: _authority, ...withoutAuthority } = baseInput;
    const cases = [
      ["initial mode", makeAdoptionRecoveryInput({ operationMode: "initial" })],
      ["missing mode", withoutMode],
      ["provider handle", makeAdoptionRecoveryInput({ providerHandle: "prior-handle" })],
      [
        "tenant mismatch",
        makeAdoptionRecoveryInput({ identity: { ...identity, tenantRef: "tenant-2" } }),
      ],
      [
        "resource uid mismatch",
        makeAdoptionRecoveryInput({ identity: { ...identity, uid: "resource-2" } }),
      ],
      ["missing authority", withoutAuthority],
    ] as const;

    for (const [name, input] of cases) {
      const ticket = await createProxy(
        createBinding(() => failed("unavailable", "unused", true), proof),
      ).recoverAdopt(input);
      expectUnavailable(ticket, name, "Provider executor returned invalid adoption-abort evidence");
    }
  });

  test("captures adoption recovery context before the RPC promise resolves", async () => {
    const input = makeAdoptionRecoveryInput();
    const proof = adoptionAbortFor(input);
    let resolveResult: ((value: unknown) => void) | undefined;
    const pendingResult = new Promise<unknown>((resolve) => {
      resolveResult = resolve;
    });
    const proxy = createProxy(
      createBinding(() => failed("unavailable", "unused", true), pendingResult),
    );
    const pendingTicket = proxy.recoverAdopt(input);

    Object.assign(input, {
      operationId: "changed-operation",
      operationMode: "initial",
      providerHandle: "late-handle",
    });
    Object.assign(input.identity, { tenantRef: "changed-tenant", uid: "changed-resource" });
    Object.assign(input.executionAuthority as object, { leaseToken: "changed-lease" });
    resolveResult?.(structuredClone(proof));

    const ticket = await pendingTicket;
    expect(ticket).toEqual({
      phase: "failed",
      failure: {
        code: "conflict",
        message: "the adoption was durably aborted before provider effects",
        retryable: false,
      },
    });
    expect(providerFailureProvesWholeOperationNoMutation(ticket, "operation-1")).toBe(true);
  });

  test("does not cross-accept invocation-only and whole-operation proof envelopes", async () => {
    const initialInput = makeInput("adopt");
    const wholeOperationAbort = adoptionAbortFor(makeAdoptionRecoveryInput());
    const initialTicket = await createProxy(
      createBinding(
        () => wholeOperationAbort as unknown as CloudflareProviderInitialMutationResult,
      ),
    ).adopt(initialInput);
    expectUnavailable(initialTicket, "adoption abort on initial adopt");

    const recoveryInput = makeAdoptionRecoveryInput();
    const invocationProof = proofFor("adopt", initialInput);
    const recoveryTicket = await createProxy(
      createBinding(
        () => failed("unavailable", "unused", true),
        invocationProof as unknown as ProviderTicket,
      ),
    ).recoverAdopt(recoveryInput);
    expectUnavailable(
      recoveryTicket,
      "initial proof on adoption recovery",
      "Provider executor returned invalid adoption-abort evidence",
    );

    const compensationInput = applyCompensationInput();
    const compensationProof = applyCompensationFor(compensationInput);
    const compensationUnsupported = applyCompensationUnsupportedFor(compensationInput);
    for (const [name, evidence] of [
      ["proof", compensationProof],
      ["unsupported", compensationUnsupported],
    ] as const) {
      const initialCompensation = await createProxy(
        createBinding(() => evidence as unknown as CloudflareProviderInitialMutationResult),
      ).apply(makeInput("apply"));
      expectUnavailable(initialCompensation, `compensation ${name} on initial apply`);

      const adoptionCompensation = await createProxy(
        createBinding(
          () => failed("unavailable", "unused", true),
          evidence as unknown as ProviderTicket,
        ),
      ).recoverAdopt(makeAdoptionRecoveryInput());
      expectUnavailable(
        adoptionCompensation,
        `compensation ${name} on adoption recovery`,
        "Provider executor returned invalid adoption-abort evidence",
      );
    }
  });

  test("leaves ordinary recoverAdopt tickets conservative", async () => {
    const ordinary = failed("conflict", "ordinary adoption recovery result", false);
    const ticket = await createProxy(
      createBinding(() => failed("unavailable", "unused", true), ordinary),
    ).recoverAdopt(makeAdoptionRecoveryInput());

    expect(ticket).toEqual(ordinary);
    expect(Object.hasOwn(ticket, "executorAdoptionAbort")).toBe(false);
    expect(providerFailureProvesWholeOperationNoMutation(ticket, "operation-1")).toBe(false);
  });

  test("restores apply no-effect proof only for the exact dedicated lease-bound call", async () => {
    const input = applyNoEffectInput();
    const exact = applyNoEffectFor(input);
    const binding = createBinding(() => failed("unavailable", "unused", true));
    binding.concludeApplyNoEffect = async () => structuredClone(exact);
    const ticket = await createProxy(binding).concludeApplyNoEffect(input);
    expect(ticket).toEqual({
      phase: "failed",
      failure: {
        code: "conflict",
        message: "the exact accepted create was fenced before effects",
        retryable: false,
      },
    });
    expect(ticket.phase).toBe("failed");
    if (ticket.phase !== "failed") throw new Error("expected failed ticket");
    expect(providerFailureProvesWholeOperationNoMutation(ticket, input.operationId)).toBe(true);

    for (const mutate of [
      (value: MutableApplyNoEffect) => (value.executorApplyNoEffect.operationId = "wrong"),
      (value: MutableApplyNoEffect) =>
        (value.executorApplyNoEffect.executionAuthority.leaseToken = "wrong"),
      (value: MutableApplyNoEffect) => (value.executorApplyNoEffect.action = "convergeApply"),
      (value: MutableApplyNoEffect) => (value.extra = true),
    ]) {
      const malformed = structuredClone(exact) as unknown as MutableApplyNoEffect;
      mutate(malformed);
      binding.concludeApplyNoEffect = async () =>
        malformed as unknown as CloudflareProviderApplyNoEffectConclusionResult;
      const rejected = await createProxy(binding).concludeApplyNoEffect(input);
      expect(rejected).toMatchObject({
        phase: "failed",
        failure: { code: "unavailable", retryable: true },
      });
      expect(rejected.phase).not.toBe("unsupported");
    }
  });

  test("accepts unsupported only as an exact pre-attempt conclusion envelope", async () => {
    const input = applyNoEffectInput();
    const unsupported = applyNoEffectUnsupportedFor(input);
    const binding = createBinding(() => failed("unavailable", "unused", true));
    binding.concludeApplyNoEffect = async () => structuredClone(unsupported);
    expect(await createProxy(binding).concludeApplyNoEffect(input)).toEqual({
      phase: "unsupported",
    });

    const spoofed = structuredClone(unsupported);
    spoofed.executorApplyNoEffectUnsupported.executionAuthority.fingerprint = "wrong";
    binding.concludeApplyNoEffect = async () => spoofed;
    expect(await createProxy(binding).concludeApplyNoEffect(input)).toMatchObject({
      phase: "failed",
      failure: { code: "unavailable", retryable: true },
    });
    binding.concludeApplyNoEffect = async () =>
      ({ phase: "unsupported" }) as CloudflareProviderApplyNoEffectConclusionResult;
    expect(await createProxy(binding).concludeApplyNoEffect(input)).toMatchObject({
      phase: "failed",
      failure: { code: "unavailable", retryable: true },
    });
  });

  test("restores RPC disposer metadata and disposes its transport root once", async () => {
    const input = applyNoEffectInput();
    let disposals = 0;
    const binding = createBinding(() => failed("unavailable", "unused", true));
    binding.concludeApplyNoEffect = async () =>
      withRpcDisposer(applyNoEffectUnsupportedFor(input), () => {
        disposals += 1;
      }) as CloudflareProviderApplyNoEffectConclusionResult;

    expect(await createProxy(binding).concludeApplyNoEffect(input)).toEqual({
      phase: "unsupported",
    });
    expect(disposals).toBe(1);
  });

  test("normalizes every exact proof seam without weakening identity checks", async () => {
    for (const action of ["apply", "delete", "adopt"] as const) {
      const input = makeInput(action);
      let disposals = 0;
      const proof = withRpcDisposer(proofFor(action, input), () => {
        disposals += 1;
      });
      const binding = createBinding(() => failed("unavailable", "unused", true));
      if (action === "apply") binding.apply = async () => proof;
      if (action === "delete") binding.delete = async () => proof;
      if (action === "adopt") binding.adopt = async () => proof;
      expect(
        providerFailureProvesNoMutation(
          await invoke(createProxy(binding), action, input),
          input.operationId,
        ),
      ).toBe(true);
      expect(disposals).toBe(1);
    }

    const adoptionInput = makeAdoptionRecoveryInput();
    let adoptionDisposals = 0;
    const adoptionBinding = createBinding(() => failed("unavailable", "unused", true));
    adoptionBinding.recoverAdopt = async () =>
      withRpcDisposer(adoptionAbortFor(adoptionInput), () => {
        adoptionDisposals += 1;
      });
    expect(
      providerFailureProvesWholeOperationNoMutation(
        await createProxy(adoptionBinding).recoverAdopt(adoptionInput),
        adoptionInput.operationId,
      ),
    ).toBe(true);
    expect(adoptionDisposals).toBe(1);

    const convergeInput = makeInput("apply", { operationMode: "recovery" }) as ApplyInput;
    let convergeDisposals = 0;
    const convergeBinding = createBinding(() => failed("unavailable", "unused", true));
    convergeBinding.convergeApply = async () =>
      withRpcDisposer(applyAbortFor(convergeInput), () => {
        convergeDisposals += 1;
      });
    expect(
      providerFailureProvesWholeOperationNoMutation(
        await createProxy(convergeBinding).convergeApply(convergeInput),
        convergeInput.operationId,
      ),
    ).toBe(true);
    expect(convergeDisposals).toBe(1);

    const noEffectInput = applyNoEffectInput();
    let noEffectDisposals = 0;
    const noEffectBinding = createBinding(() => failed("unavailable", "unused", true));
    noEffectBinding.concludeApplyNoEffect = async () =>
      withRpcDisposer(applyNoEffectFor(noEffectInput), () => {
        noEffectDisposals += 1;
      });
    const noEffectResult = await createProxy(noEffectBinding).concludeApplyNoEffect(noEffectInput);
    expect(noEffectResult.phase).toBe("failed");
    if (noEffectResult.phase !== "failed") throw new Error("missing no-effect proof");
    expect(
      providerFailureProvesWholeOperationNoMutation(noEffectResult, noEffectInput.operationId),
    ).toBe(true);
    expect(noEffectDisposals).toBe(1);

    const compensationInput = applyCompensationInput();
    let compensationDisposals = 0;
    const compensationBinding = createBinding(() => failed("unavailable", "unused", true));
    compensationBinding.compensateApply = async () =>
      withRpcDisposer(applyCompensationFor(compensationInput), () => {
        compensationDisposals += 1;
      });
    const compensationResult =
      await createProxy(compensationBinding).compensateApply(compensationInput);
    expect(compensationResult.phase).toBe("failed");
    if (compensationResult.phase !== "failed") throw new Error("missing compensated proof");
    expect(
      providerFailureProvesWholeOperationCompensated(
        compensationResult,
        compensationInput.operationId,
      ),
    ).toBe(true);
    expect(compensationDisposals).toBe(1);

    let artifactDisposals = 0;
    const artifactBinding = createBinding(() => failed("unavailable", "unused", true));
    artifactBinding.verifyArtifactConsumption = async () =>
      withRpcDisposer({ outcome: "unknown", reason: "unsupported", retryable: false }, () => {
        artifactDisposals += 1;
      });
    expect(
      await createProxy(artifactBinding).verifyArtifactConsumption(
        {} as Parameters<NonNullable<Provider["verifyArtifactConsumption"]>>[0],
      ),
    ).toEqual({ outcome: "unknown", reason: "unsupported", retryable: false });
    expect(artifactDisposals).toBe(1);
  });

  test("rejects unknown root metadata, accessors, nested disposers, and mismatches", async () => {
    const input = makeInput("apply");
    const unknownSymbolProof = proofFor("apply", input) as Record<PropertyKey, unknown>;
    Object.defineProperty(unknownSymbolProof, Symbol("unknown-rpc-metadata"), {
      configurable: true,
      enumerable: false,
      value: true,
    });
    let binding = createBinding(() => failed("unavailable", "unused", true));
    binding.apply = async () =>
      unknownSymbolProof as unknown as CloudflareProviderInitialMutationResult;
    expectUnavailableCode(await createProxy(binding).apply(input), "unknown root symbol");

    const unknownStringProof = proofFor("apply", input) as MutableProof;
    Object.defineProperty(unknownStringProof, "debug", {
      configurable: true,
      enumerable: false,
      value: true,
      writable: true,
    });
    binding = createBinding(() => failed("unavailable", "unused", true));
    binding.apply = async () =>
      unknownStringProof as unknown as CloudflareProviderInitialMutationResult;
    expectUnavailableCode(await createProxy(binding).apply(input), "unknown root string");

    const accessorProof = proofFor("apply", input) as Record<string, unknown>;
    let getterCalls = 0;
    Object.defineProperty(accessorProof, "phase", {
      configurable: true,
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "failed";
      },
    });
    binding = createBinding(() => failed("unavailable", "unused", true));
    binding.apply = async () => accessorProof as unknown as CloudflareProviderInitialMutationResult;
    expectUnavailableCode(await createProxy(binding).apply(input), "root accessor");
    expect(getterCalls).toBe(0);

    const nestedProof = proofFor("apply", input) as unknown as MutableProof;
    Object.defineProperty(nestedProof.executorNoMutation, Symbol.dispose, {
      configurable: true,
      enumerable: false,
      value: () => undefined,
    });
    binding = createBinding(() => failed("unavailable", "unused", true));
    binding.apply = async () => nestedProof as unknown as CloudflareProviderInitialMutationResult;
    expectUnavailableCode(await createProxy(binding).apply(input), "nested disposer");

    let disposals = 0;
    const mismatched = withRpcDisposer(proofFor("apply", input), () => {
      disposals += 1;
    }) as MutableProof;
    mismatched.executorNoMutation.executionAuthority.leaseToken = "wrong-lease";
    binding = createBinding(() => failed("unavailable", "unused", true));
    binding.apply = async () => mismatched as unknown as CloudflareProviderInitialMutationResult;
    expectUnavailableCode(await createProxy(binding).apply(input), "mismatched authority");
    expect(disposals).toBe(1);
  });

  test("returns ordinary passthrough tickets as fresh roots without a disposer", async () => {
    const ordinary = failed("conflict", "ordinary provider refusal", false);
    let disposals = 0;
    const binding = createBinding(() => failed("unavailable", "unused", true));
    binding.poll = async () =>
      withRpcDisposer(ordinary, () => {
        disposals += 1;
      });
    const result = await createProxy(binding).poll({
      operationId: "operation-1",
      handle: "handle-1",
      executionAuthority: authority,
    });
    expect(result).toEqual(ordinary);
    expect(result).not.toBe(ordinary);
    expect(Reflect.ownKeys(result)).not.toContain(Symbol.dispose);
    expect(disposals).toBe(1);
  });

  test("keeps ordinary tickets unchanged when root disposal fails", async () => {
    const ordinary = failed("conflict", "ordinary provider refusal", false);
    for (const dispose of [
      () => {
        throw new Error("sync disposer failure");
      },
      async () => {
        throw new Error("async disposer failure");
      },
    ]) {
      const binding = createBinding(() => failed("unavailable", "unused", true));
      binding.poll = async () => withRpcDisposer(ordinary, dispose);
      const result = await createProxy(binding).poll({
        operationId: "operation-1",
        handle: "handle-1",
        executionAuthority: authority,
      });
      expect(result).toEqual(ordinary);
      expect(result).not.toBe(ordinary);
      expect(Reflect.ownKeys(result)).not.toContain(Symbol.dispose);
    }
  });

  test("restores compensated proof only for the exact dedicated lease-bound call", async () => {
    const input = applyCompensationInput();
    const exact = applyCompensationFor(input);
    const binding = createBinding(() => failed("unavailable", "unused", true));
    binding.compensateApply = async () => structuredClone(exact);
    const ticket = await createProxy(binding).compensateApply(input);
    expect(ticket).toEqual({
      phase: "failed",
      failure: {
        code: "conflict",
        message: "the exact accepted create was durably compensated",
        retryable: false,
      },
    });
    expect(ticket.phase).toBe("failed");
    if (ticket.phase !== "failed") throw new Error("expected failed ticket");
    expect(providerFailureProvesWholeOperationCompensated(ticket, input.operationId)).toBe(true);
    expect(providerFailureProvesWholeOperationNoMutation(ticket, input.operationId)).toBe(false);

    for (const mutate of [
      (value: MutableApplyCompensation) => (value.executorApplyCompensation.operationId = "wrong"),
      (value: MutableApplyCompensation) =>
        (value.executorApplyCompensation.executionAuthority.leaseToken = "wrong"),
      (value: MutableApplyCompensation) =>
        (value.executorApplyCompensation.action = "concludeApplyNoEffect"),
      (value: MutableApplyCompensation) => (value.extra = true),
    ]) {
      const malformed = structuredClone(exact) as unknown as MutableApplyCompensation;
      mutate(malformed);
      binding.compensateApply = async () =>
        malformed as unknown as CloudflareProviderApplyCompensationResult;
      const rejected = await createProxy(binding).compensateApply(input);
      expect(rejected).toMatchObject({
        phase: "failed",
        failure: { code: "unavailable", retryable: true },
      });
      if (rejected.phase === "unsupported") throw new Error("malformed proof was accepted");
      expect(providerFailureProvesWholeOperationCompensated(rejected, input.operationId)).toBe(
        false,
      );
    }
  });

  test("accepts compensation unsupported only on its dedicated seam", async () => {
    const input = applyCompensationInput();
    const unsupported = applyCompensationUnsupportedFor(input);
    const binding = createBinding(() => failed("unavailable", "unused", true));
    binding.compensateApply = async () => structuredClone(unsupported);
    expect(await createProxy(binding).compensateApply(input)).toEqual({ phase: "unsupported" });

    const spoofed = structuredClone(unsupported);
    spoofed.executorApplyCompensationUnsupported.executionAuthority.fingerprint = "wrong";
    binding.compensateApply = async () => spoofed;
    expect(await createProxy(binding).compensateApply(input)).toMatchObject({
      phase: "failed",
      failure: { code: "unavailable", retryable: true },
    });

    binding.concludeApplyNoEffect = async () =>
      structuredClone(unsupported) as unknown as CloudflareProviderApplyNoEffectConclusionResult;
    const wrongSeam = await createProxy(binding).concludeApplyNoEffect(applyNoEffectInput());
    expect(wrongSeam).toMatchObject({
      phase: "failed",
      failure: { code: "unavailable", retryable: true },
    });
  });
});

interface MutableApplyNoEffect {
  executorApplyNoEffect: {
    operationId: unknown;
    action: unknown;
    executionAuthority: { leaseToken: unknown };
  };
  extra?: unknown;
}

interface MutableApplyCompensation {
  executorApplyCompensation: {
    operationId: unknown;
    action: unknown;
    executionAuthority: { leaseToken: unknown };
  };
  extra?: unknown;
}

function applyNoEffectInput(): ProviderApplyNoEffectConclusionInput {
  return {
    operationId: "operation-no-effect-1",
    providerInstallationRef: installationId,
    executionAuthority: { ...authority },
    offering,
    identity: { ...identity, uid: authority.resourceUid },
  };
}

function applyNoEffectFor(
  input: ProviderApplyNoEffectConclusionInput,
): CloudflareProviderApplyNoEffectConclusionResult {
  return {
    phase: "failed",
    failure: {
      code: "conflict",
      message: "the exact accepted create was fenced before effects",
      retryable: false,
    },
    executorApplyNoEffect: {
      schema: CLOUDFLARE_PROVIDER_EXECUTOR_APPLY_NO_EFFECT_SCHEMA,
      action: "concludeApplyNoEffect",
      operationId: input.operationId,
      providerInstallationRef: input.providerInstallationRef,
      executionAuthority: { ...input.executionAuthority },
    },
  };
}

function applyNoEffectUnsupportedFor(input: ProviderApplyNoEffectConclusionInput) {
  return {
    phase: "unsupported" as const,
    executorApplyNoEffectUnsupported: {
      schema: CLOUDFLARE_PROVIDER_EXECUTOR_APPLY_NO_EFFECT_SCHEMA,
      action: "unsupported" as const,
      operationId: input.operationId,
      providerInstallationRef: input.providerInstallationRef,
      executionAuthority: { ...input.executionAuthority },
    },
  };
}

function applyCompensationInput(): ProviderApplyCompensationInput {
  return {
    operationId: "operation-compensation-1",
    providerInstallationRef: installationId,
    executionAuthority: { ...authority },
    offering,
    identity: { ...identity, uid: authority.resourceUid },
  };
}

function applyCompensationFor(
  input: ProviderApplyCompensationInput,
): CloudflareProviderApplyCompensationResult {
  return {
    phase: "failed",
    failure: {
      code: "conflict",
      message: "the exact accepted create was durably compensated",
      retryable: false,
    },
    executorApplyCompensation: {
      schema: CLOUDFLARE_PROVIDER_EXECUTOR_APPLY_COMPENSATION_SCHEMA,
      action: "compensateApply",
      operationId: input.operationId,
      providerInstallationRef: input.providerInstallationRef,
      executionAuthority: { ...input.executionAuthority },
    },
  };
}

function applyCompensationUnsupportedFor(input: ProviderApplyCompensationInput) {
  return {
    phase: "unsupported" as const,
    executorApplyCompensationUnsupported: {
      schema: CLOUDFLARE_PROVIDER_EXECUTOR_APPLY_COMPENSATION_SCHEMA,
      action: "unsupported" as const,
      operationId: input.operationId,
      providerInstallationRef: input.providerInstallationRef,
      executionAuthority: { ...input.executionAuthority },
    },
  };
}

function applyAbortFor(input: ApplyInput): CloudflareProviderApplyConvergenceResult {
  if (!input.executionAuthority) throw new Error("missing execution authority");
  return {
    phase: "failed",
    failure: {
      code: "conflict",
      message: "the exact operation was durably fenced",
      retryable: false,
    },
    executorApplyAbort: {
      schema: CLOUDFLARE_PROVIDER_EXECUTOR_APPLY_ABORT_SCHEMA,
      action: "convergeApply",
      operationId: input.operationId,
      providerInstallationRef: installationId,
      executionAuthority: { ...input.executionAuthority },
    },
  };
}

function makeInput(action: "apply", overrides?: Partial<ApplyInput>): ApplyInput;
function makeInput(action: "delete", overrides?: Partial<DeleteInput>): DeleteInput;
function makeInput(action: "adopt", overrides?: Partial<AdoptInput>): AdoptInput;
function makeInput(action: Action, overrides?: Partial<InitialInput>): InitialInput;
function makeInput(action: Action, overrides: Partial<InitialInput> = {}): InitialInput {
  const common = {
    operationId: "operation-1",
    operationMode: "initial" as const,
    executionAuthority: { ...authority },
    identity: { ...identity },
    offering,
  };
  if (action === "apply") {
    return { ...common, spec: {}, ...overrides } as ApplyInput;
  }
  if (action === "delete") {
    return { ...common, nativeId: "native-1", spec: {}, ...overrides } as DeleteInput;
  }
  return { ...common, nativeId: "native-1", spec: {}, ...overrides } as AdoptInput;
}

function proofFor(action: Action, input: InitialInput): CloudflareProviderInitialMutationResult {
  return {
    phase: "failed",
    failure: {
      code: "conflict",
      message: "native identity is already present",
      retryable: false,
    },
    executorNoMutation: {
      schema: CLOUDFLARE_PROVIDER_EXECUTOR_NO_MUTATION_SCHEMA,
      action,
      operationId: input.operationId,
      providerInstallationRef: installationId,
      executionAuthority: { ...(input.executionAuthority ?? authority) },
    },
  };
}

function makeAdoptionRecoveryInput(
  overrides: Partial<AdoptInput> = {},
): Parameters<NonNullable<Provider["recoverAdopt"]>>[0] {
  return {
    ...makeInput("adopt", { operationMode: "recovery" }),
    ...overrides,
  } as Parameters<NonNullable<Provider["recoverAdopt"]>>[0];
}

function adoptionAbortFor(
  input: Parameters<NonNullable<Provider["recoverAdopt"]>>[0],
): CloudflareProviderAdoptionRecoveryResult {
  return {
    phase: "failed",
    failure: {
      code: "conflict",
      message: "the adoption was durably aborted before provider effects",
      retryable: false,
    },
    executorAdoptionAbort: {
      schema: CLOUDFLARE_PROVIDER_EXECUTOR_ADOPTION_ABORT_SCHEMA,
      action: "recoverAdopt",
      operationId: input.operationId,
      providerInstallationRef: installationId,
      executionAuthority: { ...(input.executionAuthority ?? authority) },
    },
  };
}

interface MutableAdoptionAbort {
  phase: unknown;
  failure: { code: unknown; message: unknown; retryable: unknown; [key: string]: unknown };
  executorAdoptionAbort: {
    schema: unknown;
    action: unknown;
    operationId: unknown;
    providerInstallationRef: unknown;
    executionAuthority: {
      tenantId: unknown;
      resourceUid: unknown;
      leaseToken: unknown;
      fingerprint: unknown;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

function mutateAdoptionAbort(
  abort: unknown,
  mutate: (value: MutableAdoptionAbort) => void,
): unknown {
  const clone = structuredClone(abort) as MutableAdoptionAbort;
  mutate(clone);
  return clone;
}

function invoke(proxy: CloudflareProviderProxy, action: Action, input: InitialInput) {
  if (action === "apply") return proxy.apply(input as ApplyInput);
  if (action === "delete") return proxy.delete(input as DeleteInput);
  return proxy.adopt(input as AdoptInput);
}

function createProxy(binding: CloudflareProviderExecutorRpc): CloudflareProviderProxy {
  return new CloudflareProviderProxy({
    providerInstallationId: installationId,
    offerings: [offering],
    managedBaseDomain: "workers.example.test",
    binding,
  });
}

function createBinding(
  handler: InitialHandler,
  recoveryResult: unknown | Promise<unknown> = failed("unavailable", "unused", true),
): CloudflareProviderExecutorRpc {
  const initial = async (action: Action, input: InitialInput) =>
    structuredClone(await handler(action, input)) as CloudflareProviderInitialMutationResult;
  const recovery = async () => structuredClone(await recoveryResult) as ProviderTicket;
  const adoptionRecovery = async () =>
    structuredClone(await recoveryResult) as CloudflareProviderAdoptionRecoveryResult;
  const unused = async (): Promise<never> => {
    throw new Error("unused executor RPC");
  };
  return {
    apply: (input) => initial("apply", input),
    recoverApply: recovery,
    convergeApply: recovery,
    concludeApplyNoEffect: recovery,
    compensateApply: recovery,
    poll: recovery,
    observe: recovery,
    delete: (input) => initial("delete", input),
    recoverDelete: recovery,
    adopt: (input) => initial("adopt", input),
    recoverAdopt: adoptionRecovery,
    verifyNativeAbsence: unused,
    verifyArtifactConsumption: unused,
    readSqliteMigrationLedger: unused,
    applySqliteMigrationSuffix: unused,
    readMeterUsage: unused,
  } satisfies CloudflareProviderExecutorRpc;
}

function withRpcDisposer<T extends object>(value: T, dispose: () => void): T {
  Object.defineProperty(value, Symbol.dispose, {
    configurable: true,
    enumerable: false,
    value: dispose,
    writable: true,
  });
  return value;
}

interface MutableProof {
  phase: unknown;
  failure: { code: unknown; message: unknown; retryable: unknown; [key: string]: unknown };
  executorNoMutation: {
    schema: unknown;
    action: unknown;
    operationId: unknown;
    providerInstallationRef: unknown;
    executionAuthority: {
      tenantId: unknown;
      resourceUid: unknown;
      leaseToken: unknown;
      fingerprint: unknown;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

function mutateProof(
  proof: CloudflareProviderInitialMutationResult,
  mutate: (value: MutableProof) => void,
): unknown {
  const clone = structuredClone(proof) as unknown as MutableProof;
  mutate(clone);
  return clone;
}

function expectUnavailable(
  ticket: ProviderTicket,
  caseName: string,
  message = "Provider executor returned invalid no-mutation evidence",
): void {
  expect(ticket, caseName).toMatchObject({
    phase: "failed",
    failure: {
      code: "unavailable",
      message,
      retryable: true,
    },
  });
  expect(providerFailureProvesNoMutation(ticket, "operation-1"), caseName).toBe(false);
  expect(providerFailureProvesWholeOperationNoMutation(ticket, "operation-1"), caseName).toBe(
    false,
  );
}

function expectUnavailableCode(ticket: ProviderTicket, caseName: string): void {
  expect(ticket, caseName).toMatchObject({
    phase: "failed",
    failure: { code: "unavailable", retryable: true },
  });
  expect(providerFailureProvesNoMutation(ticket, "operation-1"), caseName).toBe(false);
  expect(providerFailureProvesWholeOperationNoMutation(ticket, "operation-1"), caseName).toBe(
    false,
  );
}
