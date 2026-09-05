import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publicFormCapabilityManifest } from "../scripts/deploy/form-authority.ts";
import {
  type FormAuthorityInvokeOptions,
  formAuthorityRequestTimeoutMs,
  runFormAuthorityInvoke,
} from "../scripts/deploy/form-authority-invoke.ts";
import { formAuthorityScopeTransitionDigest } from "../scripts/deploy/form-authority-scope-transition.ts";
import type { CommandResult } from "../scripts/deploy/process.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import { createEphemeralSql } from "../src/compat.ts";
import { normalizeGeneratedEd25519PrivateJwk } from "../src/ed25519-private-jwk.ts";
import { verifyFormAuthorityOperatorAssertion } from "../src/form-authority-operator-proof.ts";
import { INTEGRATION_FORM_PACKAGES } from "../src/generated/takoform-integration-form-packages.ts";
import { canonicalJson } from "../src/json.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { derivePublicFormImplementationIdentity } from "../src/public-worker-implementation.ts";
import {
  CURRENT_PUBLISHER_COMMIT,
  CURRENT_PUBLISHER_REPOSITORY,
} from "../src/takoform/current-publisher-catalog.ts";
import { deriveFormAuthorityIdentity } from "../src/takoform/host-admission-endpoint.ts";
import { YURUCOMMU_IDENTITY_CAPABILITY_KINDS } from "../src/takoform/implementation-catalog.ts";
import { createIntegrationFormAuthorityComposition } from "../src/takoform/integration-operator-endpoint.ts";
import { cloudflareProviderExecutorTarget } from "./helpers/hosted-supply-fixtures.ts";

const COMMIT = "a".repeat(40);
const NEXT_COMMIT = "d".repeat(40);
/** Derived so a Form joining the catalog cannot silently leave a count behind. */
const PACKAGE_COUNT = INTEGRATION_FORM_PACKAGES.length;
const IMPLEMENTED_COUNT = 15;
const NOW = new Date("2026-08-29T02:00:00Z");
const ARTIFACT = `sha256:${"b".repeat(64)}` as const;
const PUBLIC_VERSION = "11111111-1111-4111-8111-111111111111";
const ORIGIN = "https://form-authority.integration.takoserver.com";
const HOST_ID = "https://api.integration.example.test";
const TRANSITION_TARGET_SCOPE = {
  tenantId: "tenant-yurucommu-transition-target",
  space: "space-yurucommu-transition-target",
} as const;

let privateJwk: JsonWebKey;
let publicJwk: { readonly kty: "OKP"; readonly crv: "Ed25519"; readonly x: string };
const roots: string[] = [];

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  privateJwk = normalizeGeneratedEd25519PrivateJwk(
    await crypto.subtle.exportKey("jwk", pair.privateKey),
  );
  const publicPart = await crypto.subtle.exportKey("jwk", pair.publicKey);
  if (publicPart.kty !== "OKP" || publicPart.crv !== "Ed25519" || !publicPart.x) {
    throw new Error("test Ed25519 key is unavailable");
  }
  publicJwk = { kty: "OKP", crv: "Ed25519", x: publicPart.x };
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("signed Form authority operator invocation", () => {
  test("bounds reads at 30 seconds and leaves apply inside its 60-second assertion", () => {
    expect(formAuthorityRequestTimeoutMs("plan")).toBe(30_000);
    expect(formAuthorityRequestTimeoutMs("readback")).toBe(30_000);
    expect(formAuthorityRequestTimeoutMs("apply")).toBe(55_000);
  });

  test("performs exact signed plan -> one apply -> signed readback without exposing credentials", async () => {
    const fixture = await invocationFixture();
    const result = await runFormAuthorityInvoke(
      {
        surface: "takoserver-integration-form-authority",
        action: "apply",
        environment: "integration",
        commit: COMMIT,
      },
      fixture.target,
      fixture.options,
    );

    expect(fixture.calls.map(({ action }) => action)).toEqual(["plan", "apply", "readback"]);
    expect(canonicalJson(fixture.calls[1]?.body)).toBe(canonicalJson(fixture.calls[0]?.result));
    expect((result.readback as { forms: unknown[] }).forms).toHaveLength(PACKAGE_COUNT);
    expect((result.apply as { receipts: unknown[] }).receipts).toHaveLength(
      2 + PACKAGE_COUNT + IMPLEMENTED_COUNT * 2,
    );
    expect(result).toMatchObject({
      kind: "takoserver.integration-form-authority-invocation@v2",
      action: "apply",
      environment: "integration",
      activation: {
        kind: "space",
        tenantId: "tenant-yurucommu-integration",
        space: "space-yurucommu-integration",
      },
      policyAuthority: "takoserver-host",
      verificationMode: "integration-fixture",
      productionEligible: false,
      credentialsRedacted: true,
      ready: true,
      plan: {
        planDigest: expect.stringMatching(/^sha256:/),
        commandCount: 2 + PACKAGE_COUNT + IMPLEMENTED_COUNT * 2,
      },
      apply: {
        status: "converged",
        planDigest: expect.stringMatching(/^sha256:/),
        receipts: expect.any(Array),
        policyAuthority: "takoserver-host",
        verificationMode: "integration-fixture",
        productionEligible: false,
        replanRequired: false,
      },
      readback: { forms: expect.any(Array) },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(privateJwk.d as string);
    expect(serialized).not.toContain(fixture.assertions[0] ?? "missing-assertion");
  });

  test("keeps the Form publisher generation stable across Host deploy commits", async () => {
    const fixture = await invocationFixture();
    await runFormAuthorityInvoke(
      {
        surface: "takoserver-integration-form-authority",
        action: "apply",
        environment: "integration",
        commit: COMMIT,
      },
      fixture.target,
      fixture.options,
    );
    const firstRequest = fixture.calls.find(({ action }) => action === "plan")?.body as {
      evidence?: { publisher?: Record<string, unknown> };
    };
    fixture.calls.length = 0;
    fixture.assertions.length = 0;
    fixture.selectCommit(NEXT_COMMIT);

    const second = await runFormAuthorityInvoke(
      {
        surface: "takoserver-integration-form-authority",
        action: "apply",
        environment: "integration",
        commit: NEXT_COMMIT,
      },
      fixture.target,
      fixture.options,
    );
    const secondRequest = fixture.calls.find(({ action }) => action === "plan")?.body as {
      evidence?: { publisher?: Record<string, unknown> };
    };

    expect(second).toMatchObject({ ready: true, plan: { commandCount: 0 } });
    expect((second.apply as { receipts: unknown[] }).receipts).toEqual([]);
    expect(secondRequest.evidence?.publisher).toEqual(firstRequest.evidence?.publisher);
    expect(secondRequest.evidence?.publisher).toMatchObject({
      publisherKey: expect.stringMatching(/^takoform-integration-fixture:sha256:[0-9a-f]{64}$/),
      sourceRepository: CURRENT_PUBLISHER_REPOSITORY,
      sourceCommit: CURRENT_PUBLISHER_COMMIT,
      workflowCommit: CURRENT_PUBLISHER_COMMIT,
      buildConfigCommit: CURRENT_PUBLISHER_COMMIT,
      repositoryIdentifier: "repo:tako0614/takoform-forms",
    });
    expect(secondRequest.evidence?.publisher?.sourceCommit).not.toBe(NEXT_COMMIT);
  });

  test("status is one signed readback and reports the exact publisher convergence", async () => {
    const fixture = await invocationFixture();
    await runFormAuthorityInvoke(
      {
        surface: "takoserver-integration-form-authority",
        action: "apply",
        environment: "integration",
        commit: COMMIT,
      },
      fixture.target,
      fixture.options,
    );
    fixture.calls.length = 0;
    fixture.assertions.length = 0;

    const status = await runFormAuthorityInvoke(
      {
        surface: "takoserver-integration-form-authority",
        action: "status",
        environment: "integration",
        commit: COMMIT,
      },
      fixture.target,
      fixture.options,
    );
    expect(fixture.calls.map(({ action }) => action)).toEqual(["readback"]);
    expect(status).toMatchObject({ action: "status", ready: true, credentialsRedacted: true });
  });

  test("deactivation uses a distinct surface and reports all executable heads inactive", async () => {
    const fixture = await invocationFixture();
    await runFormAuthorityInvoke(
      {
        surface: "takoserver-integration-form-authority",
        action: "apply",
        environment: "integration",
        commit: COMMIT,
      },
      fixture.target,
      fixture.options,
    );
    fixture.calls.length = 0;
    fixture.assertions.length = 0;

    const deactivated = await runFormAuthorityInvoke(
      {
        surface: "takoserver-integration-form-authority-deactivation",
        action: "apply",
        environment: "integration",
        commit: COMMIT,
      },
      fixture.target,
      fixture.options,
    );
    expect(fixture.calls.map(({ action }) => action)).toEqual(["plan", "apply", "readback"]);
    const planRequest = fixture.calls.find(({ action }) => action === "plan")?.body as {
      activation?: { desiredActive?: boolean };
    };
    expect(planRequest.activation?.desiredActive).toBe(false);
    expect(deactivated).toMatchObject({
      kind: "takoserver.integration-form-authority-invocation@v2",
      surface: "takoserver-integration-form-authority-deactivation",
      activation: { desiredActive: false },
      ready: true,
      plan: { commandCount: IMPLEMENTED_COUNT },
      apply: { status: "converged", nextCommandCount: 0 },
    });
    expect(
      (deactivated.readback as { forms: readonly { activationHead: { active: boolean } }[] }).forms,
    ).toHaveLength(PACKAGE_COUNT);
    expect(
      (
        deactivated.readback as {
          forms: readonly { activationHead: { present: boolean; active: boolean } }[];
        }
      ).forms.every(({ activationHead }) => !activationHead.present || !activationHead.active),
    ).toBe(true);
  });

  test("transition deactivation signs only the exact predecessor after both Workers prove predecessor/current-public closure", async () => {
    const fixture = await invocationFixture();
    await runFormAuthorityInvoke(
      {
        surface: "takoserver-integration-form-authority",
        action: "apply",
        environment: "integration",
        commit: COMMIT,
      },
      fixture.target,
      fixture.options,
    );
    fixture.calls.length = 0;
    fixture.assertions.length = 0;

    const { transitionedTarget, transition } = transitionFixture(fixture.target);
    const deactivated = await runFormAuthorityInvoke(
      {
        surface: "takoserver-integration-form-authority-deactivation",
        action: "apply",
        environment: "integration",
        commit: COMMIT,
        scopeTransition: transition,
      },
      transitionedTarget,
      {
        ...fixture.options,
        inspectGateway: async () =>
          fixture.gatewayStatus({
            scopeBindingProfile: "exact-transition-predecessor",
            authorityScopeBindingProfile: "exact-transition-predecessor",
            scopeTransitionDigest: transition.digest,
            ready: false,
          }),
      },
    );

    expect(fixture.calls.map(({ action }) => action)).toEqual(["plan", "apply", "readback"]);
    const request = fixture.calls.find(({ action }) => action === "plan")?.body as {
      activation: {
        kind: "space";
        tenantId: string;
        space: string;
        desiredActive: boolean;
      };
    };
    expect(request.activation).toEqual({
      kind: "space",
      ...transition.value.predecessorScope,
      desiredActive: false,
    });
    expect(deactivated).toMatchObject({
      activation: {
        kind: "space",
        desiredActive: false,
        scopeRedacted: true,
      },
      readback: {
        kind: "takoserver.form-authority-readback-summary@v1",
        currentHeadDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        desiredActive: false,
        allInactive: true,
        scopeRedacted: true,
      },
      scopeBindingProfile: "exact-transition-predecessor",
      scopeTransitionDigest: transition.digest,
      ready: true,
    });
    expect(Object.keys(deactivated.activation as Record<string, unknown>).sort()).toEqual([
      "desiredActive",
      "kind",
      "scopeRedacted",
    ]);
    expect(Object.keys(deactivated.readback as Record<string, unknown>).sort()).toEqual([
      "allInactive",
      "currentHeadDigest",
      "desiredActive",
      "kind",
      "scopeRedacted",
    ]);
    const stdout = `${JSON.stringify(deactivated, null, 2)}\n`;
    for (const sensitive of [
      transition.value.predecessorScope.tenantId,
      transition.value.predecessorScope.space,
      transition.value.targetScope.tenantId,
      transition.value.targetScope.space,
      privateJwk.d as string,
    ]) {
      expect(stdout).not.toContain(sensitive);
    }
  });

  test("transition deactivation refuses mixed scope topology and stale public closure before signing", async () => {
    const fixture = await invocationFixture();
    const { transitionedTarget, transition } = transitionFixture(fixture.target);
    for (const status of [
      {
        scopeBindingProfile: "exact-transition-predecessor",
        authorityScopeBindingProfile: "exact-target",
      },
      {
        scopeBindingProfile: "exact-target",
        authorityScopeBindingProfile: "exact-transition-predecessor",
      },
      {
        scopeBindingProfile: "exact-transition-predecessor",
        authorityScopeBindingProfile: "exact-transition-predecessor",
        publicWorkerBindingProfile: "legacy-exact-pinned",
      },
    ]) {
      fixture.calls.length = 0;
      await expect(
        runFormAuthorityInvoke(
          {
            surface: "takoserver-integration-form-authority-deactivation",
            action: "status",
            environment: "integration",
            commit: COMMIT,
            scopeTransition: transition,
          },
          transitionedTarget,
          {
            ...fixture.options,
            inspectGateway: async () =>
              fixture.gatewayStatus({
                ...status,
                scopeTransitionDigest: transition.digest,
                ready: false,
              }),
          },
        ),
      ).rejects.toThrow("gateway");
      expect(fixture.calls).toEqual([]);
    }
  });

  test("normal activation never accepts a scope-transition descriptor", async () => {
    const fixture = await invocationFixture();
    const { transitionedTarget, transition } = transitionFixture(fixture.target);
    let inspected = false;
    await expect(
      runFormAuthorityInvoke(
        {
          surface: "takoserver-integration-form-authority",
          action: "status",
          environment: "integration",
          commit: COMMIT,
          scopeTransition: transition,
        },
        transitionedTarget,
        {
          ...fixture.options,
          inspectGateway: async () => {
            inspected = true;
            return fixture.gatewayStatus();
          },
        },
      ),
    ).rejects.toThrow("activation");
    expect(inspected).toBe(false);
  });

  test("status accepts the valid nonconverged initial readback and reports not ready", async () => {
    const fixture = await invocationFixture();
    const status = await runFormAuthorityInvoke(
      {
        surface: "takoserver-integration-form-authority",
        action: "status",
        environment: "integration",
        commit: COMMIT,
      },
      fixture.target,
      fixture.options,
    );

    expect(fixture.calls.map(({ action }) => action)).toEqual(["readback"]);
    expect(status).toMatchObject({ action: "status", ready: false, credentialsRedacted: true });
    expect((status.readback as { forms: unknown[] }).forms).toHaveLength(PACKAGE_COUNT);
  });

  test("classifies a malformed status readback as a preflight error", async () => {
    const fixture = await invocationFixture({ tamperReadback: "truthy" });
    const failure = await runFormAuthorityInvoke(
      {
        surface: "takoserver-integration-form-authority",
        action: "status",
        environment: "integration",
        commit: COMMIT,
      },
      fixture.target,
      fixture.options,
    ).catch((error) => error);

    expect(fixture.calls.map(({ action }) => action)).toEqual(["readback"]);
    expect(failure).toMatchObject({
      phase: "preflight",
      message: expect.stringContaining("readback is invalid"),
    });
  });

  test("rejects a tampered canonical plan digest before sending apply", async () => {
    const fixture = await invocationFixture({ tamperPlanDigest: true });
    await expect(
      runFormAuthorityInvoke(
        {
          surface: "takoserver-integration-form-authority",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        fixture.target,
        fixture.options,
      ),
    ).rejects.toThrow("plan digest");
    expect(fixture.calls.map(({ action }) => action)).toEqual(["plan"]);
  });

  test("never retries an indeterminate apply or hides it behind a readback", async () => {
    const fixture = await invocationFixture({ failApplyTransport: true });
    const failure = await runFormAuthorityInvoke(
      {
        surface: "takoserver-integration-form-authority",
        action: "apply",
        environment: "integration",
        commit: COMMIT,
      },
      fixture.target,
      fixture.options,
    ).catch((error) => error);
    expect(failure).toMatchObject({ phase: "mutation" });
    expect(fixture.calls.map(({ action }) => action)).toEqual(["plan", "apply"]);
  });

  test("an acknowledged partial apply exits nonzero with sanitized forward-repair diagnostics", async () => {
    const fixture = await invocationFixture({ partialApply: true });
    const failure = await runFormAuthorityInvoke(
      {
        surface: "takoserver-integration-form-authority",
        action: "apply",
        environment: "integration",
        commit: COMMIT,
      },
      fixture.target,
      fixture.options,
    ).catch((error) => error);
    expect(fixture.calls.map(({ action }) => action)).toEqual(["plan", "apply", "readback"]);
    expect(failure).toMatchObject({
      phase: "verification",
      message: expect.stringContaining("partial"),
    });
    const detail = String(failure.detail);
    expect(detail).toContain("nextPlanDigest");
    expect(detail).toContain("receipts");
    expect(detail).not.toContain(privateJwk.d as string);
    expect(fixture.assertions.every((assertion) => !detail.includes(assertion))).toBe(true);
  });

  test("readback rejects truthy, extra, and missing per-Form authority fields", async () => {
    for (const tamperReadback of ["truthy", "extra", "missing"] as const) {
      const fixture = await invocationFixture({ tamperReadback });
      const failure = await runFormAuthorityInvoke(
        {
          surface: "takoserver-integration-form-authority",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        fixture.target,
        fixture.options,
      ).catch((error) => error);
      expect(fixture.calls.map(({ action }) => action)).toEqual(["plan", "apply", "readback"]);
      expect(failure).toMatchObject({
        phase: "verification",
        message: expect.stringContaining("readback is invalid"),
      });
    }
  });

  test("readback rejects operations that differ from the derived Form catalog", async () => {
    for (const tamperReadback of ["operations", "implemented-operations"] as const) {
      const fixture = await invocationFixture({ tamperReadback });
      const failure = await runFormAuthorityInvoke(
        {
          surface: "takoserver-integration-form-authority",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        fixture.target,
        fixture.options,
      ).catch((error) => error);
      expect(fixture.calls.map(({ action }) => action)).toEqual(["plan", "apply", "readback"]);
      expect(failure).toMatchObject({
        phase: "verification",
        message: expect.stringContaining("readback is invalid"),
      });
    }
  });

  test("hard-refuses non-integration before gateway inspection or private-key reads", async () => {
    let inspected = false;
    const target = await integrationTarget();
    await expect(
      runFormAuthorityInvoke(
        {
          surface: "takoserver-integration-form-authority",
          action: "status",
          environment: "production",
          commit: COMMIT,
        },
        { ...target, environment: "production" },
        {
          inspectGateway: async () => {
            inspected = true;
            throw new Error("must not inspect");
          },
          privateJwkPath: "/must/not/read",
        },
      ),
    ).rejects.toThrow("integration-only");
    expect(inspected).toBe(false);
  });
});

async function invocationFixture(
  input: {
    readonly tamperPlanDigest?: boolean;
    readonly failApplyTransport?: boolean;
    readonly partialApply?: boolean;
    readonly tamperReadback?:
      | "truthy"
      | "extra"
      | "missing"
      | "operations"
      | "implemented-operations";
  } = {},
) {
  let selectedCommit = COMMIT;
  const target = await integrationTarget();
  const capabilities = publicFormCapabilityManifest();
  const implementationPayloadDigest = `sha256:${"8".repeat(64)}` as const;
  const semantic = await derivePublicFormImplementationIdentity({
    implementationPayloadDigest,
    capabilities,
  });
  const configuration = {
    environment: "integration" as const,
    hostId: HOST_ID,
    workerArtifactDigest: ARTIFACT,
    publicWorkerVersionId: PUBLIC_VERSION,
    implementationPayloadDigest,
    implementationDigest: semantic.implementationDigest,
    capabilities,
  };
  const identity = await deriveFormAuthorityIdentity({
    ...configuration,
  });
  const composition = await createIntegrationFormAuthorityComposition({
    configuration,
    bindings: {
      sql: createEphemeralSql(),
      objects: createMemoryObjectStore(),
      publicHostIdentity: {
        async identity() {
          return {
            kind: "takoserver.public-host-identity@v2",
            hostId: HOST_ID,
            workerVersionId: PUBLIC_VERSION,
            workerArtifactDigest: ARTIFACT,
            implementationPayloadDigest,
            capabilityDigest: semantic.capabilityDigest,
            implementationDigest: identity.implementationDigest,
          };
        },
      },
    },
  });
  const calls: { action: string; body: unknown; result?: unknown }[] = [];
  const assertions: string[] = [];
  const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
    const action = new URL(url).pathname.slice("/v1/".length) as "plan" | "apply" | "readback";
    const body = JSON.parse(String(init?.body)) as unknown;
    calls.push({ action, body });
    const authorization = new Headers(init?.headers).get("authorization");
    const assertion = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : "";
    assertions.push(assertion);
    await verifyFormAuthorityOperatorAssertion({
      assertion,
      action,
      path: `/v1/${action}`,
      body,
      identity: {
        environment: "integration",
        hostId: HOST_ID,
        workerArtifactDigest: ARTIFACT,
        publicWorkerVersionId: PUBLIC_VERSION,
        implementationDigest: identity.implementationDigest,
      },
      publicJwk,
      clock: () => NOW,
    });
    if (action === "apply" && input.failApplyTransport) throw new Error("lost acknowledgement");
    const result =
      action === "plan"
        ? await composition.endpoint.plan(body as Parameters<typeof composition.endpoint.plan>[0])
        : action === "apply"
          ? await composition.endpoint.apply(
              body as Parameters<typeof composition.endpoint.apply>[0],
            )
          : await composition.endpoint.readback(
              body as Parameters<typeof composition.endpoint.readback>[0],
            );
    let returned: unknown =
      action === "plan" && input.tamperPlanDigest
        ? { ...result, planDigest: `sha256:${"f".repeat(64)}` }
        : result;
    if (action === "apply" && input.partialApply) {
      returned = {
        ...(result as unknown as Record<string, unknown>),
        status: "partial",
        replanRequired: true,
      };
    }
    if (action === "readback" && input.tamperReadback) {
      const readback = result as { forms: readonly Record<string, unknown>[] };
      const first = readback.forms[0] ?? {};
      const implementedIndex = readback.forms.findIndex(
        (form) =>
          (form.formRef as { readonly kind?: unknown } | undefined)?.kind === "StaticAssetBundle",
      );
      const tamperIndex =
        input.tamperReadback === "implemented-operations" && implementedIndex >= 0
          ? implementedIndex
          : 0;
      const target = readback.forms[tamperIndex] ?? first;
      const malformed =
        input.tamperReadback === "truthy"
          ? { ...first, installed: "true" }
          : input.tamperReadback === "extra"
            ? { ...first, unexpected: true }
            : input.tamperReadback === "operations" ||
                input.tamperReadback === "implemented-operations"
              ? { ...target, operations: ["read"] }
              : (({ activationHead: _activationHead, ...missing }) => missing)(first);
      returned = {
        ...(result as unknown as Record<string, unknown>),
        forms: readback.forms.map((form, index) => (index === tamperIndex ? malformed : form)),
      };
    }
    const last = calls.at(-1);
    if (last) last.result = returned;
    return Response.json(returned);
  };
  const gatewayStatus = (overrides: Record<string, unknown> = {}) => ({
    kind: "takoserver.form-authority-worker-status@v1",
    surface: "takoserver-integration-form-authority-operator-worker",
    environment: "integration",
    workerName: target.formAuthority?.integrationOperatorWorkerName,
    hostId: HOST_ID,
    selectedCommit,
    deployedCommit: selectedCommit,
    commitMatches: true,
    versionId: "22222222-2222-4222-8222-222222222222",
    authorityArtifactDigest: `sha256:${"c".repeat(64)}`,
    publicWorkerBindingProfile: "dynamic-public-rpc",
    scopeBindingProfile: "exact-target",
    publicWorkerCommit: selectedCommit,
    publicWorkerCommitMatches: true,
    authorityDeployedCommit: selectedCommit,
    authorityCommitMatches: true,
    authorityVersionId: "33333333-3333-4333-8333-333333333333",
    authorityPublicWorkerBindingProfile: "dynamic-public-rpc",
    authorityScopeBindingProfile: "exact-target",
    operatorOrigin: ORIGIN,
    authorityWorkerName: target.formAuthority?.integrationWorkerName,
    workerArtifactDigest: ARTIFACT,
    publicWorkerVersionId: PUBLIC_VERSION,
    publicIdentityRpcReady: true,
    implementationPayloadDigest,
    capabilityDigest: identity.capabilityDigest,
    implementationDigest: identity.implementationDigest,
    routeMode: "authenticated-integration-custom-domain",
    policyAuthority: "takoserver-host",
    verificationMode: "integration-fixture",
    verificationAvailable: true,
    productionEligible: false,
    ready: true,
    ...overrides,
  });
  return {
    target,
    calls,
    assertions,
    options: {
      inspectGateway: async () => gatewayStatus(),
      privateJwkPath: privateJwkFile(),
      fetcher,
      now: () => NOW,
      run: (command) => qualificationRun(command, selectedCommit),
      review: "independent-reviewer",
    } satisfies FormAuthorityInvokeOptions,
    gatewayStatus,
    selectCommit(commit: string) {
      selectedCommit = commit;
    },
  };
}

async function integrationTarget(): Promise<DeployTarget> {
  return {
    kind: "takoserver.deploy-target@v2",
    environment: "integration",
    accountId: "a".repeat(32),
    workerName: "takoserver-api-integration",
    d1: {
      databaseName: "takoserver-runtime-integration",
      databaseId: "00000000-0000-4000-8000-000000000000",
    },
    r2: { bucketName: "takoserver-objects-integration" },
    publicOrigin: HOST_ID,
    edgeSupplies: {
      offerings: YURUCOMMU_IDENTITY_CAPABILITY_KINDS.filter(
        (formKind) => formKind !== "ObjectBucket",
      ).map((formKind) => ({ formKind })),
    } as unknown as NonNullable<DeployTarget["edgeSupplies"]>,
    objectBucketSupplies: {
      supplies: [{ provider: { kind: "cloudflare" } }],
    } as unknown as NonNullable<DeployTarget["objectBucketSupplies"]>,
    cloudflareProviderExecutor: cloudflareProviderExecutorTarget("cloudflare.primary"),
    formAuthority: {
      workerName: "takoserver-form-authority-integration",
      identityProbeWorkerName: "takoserver-form-identity-integration",
      identityProbeOrigin:
        "https://takoserver-form-identity-integration.integration.example.workers.dev",
      integrationWorkerName: "takoserver-form-fixture-integration",
      integrationOperatorWorkerName: "takoserver-form-operator-integration",
      integrationOperatorOrigin: ORIGIN,
      integrationOperatorScope: {
        tenantId: "tenant-yurucommu-integration",
        space: "space-yurucommu-integration",
      },
      operatorPublicJwk: publicJwk,
      hostId: HOST_ID,
    },
    signing: { currentKeyId: "key-current" },
  };
}

function privateJwkFile(): string {
  const root = mkdtempSync(join(tmpdir(), "takoserver-form-authority-key-"));
  roots.push(root);
  const path = join(root, "operator.jwk.json");
  writeFileSync(path, `${JSON.stringify(privateJwk)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function transitionFixture(predecessorTarget: DeployTarget): {
  readonly transitionedTarget: DeployTarget;
  readonly transition: {
    readonly value: {
      readonly kind: "takoserver.integration-form-authority-scope-transition@v1";
      readonly environment: "integration";
      readonly hostId: string;
      readonly predecessorScope: { readonly tenantId: string; readonly space: string };
      readonly targetScope: { readonly tenantId: string; readonly space: string };
    };
    readonly digest: `sha256:${string}`;
  };
} {
  const authority = predecessorTarget.formAuthority;
  if (!authority?.integrationOperatorScope) throw new Error("fixture scope missing");
  const transitionedTarget: DeployTarget = {
    ...predecessorTarget,
    formAuthority: {
      ...authority,
      integrationOperatorScope: TRANSITION_TARGET_SCOPE,
    },
  };
  const value = {
    kind: "takoserver.integration-form-authority-scope-transition@v1",
    environment: "integration",
    hostId: authority.hostId,
    predecessorScope: authority.integrationOperatorScope,
    targetScope: TRANSITION_TARGET_SCOPE,
  } as const;
  return {
    transitionedTarget,
    transition: { value, digest: formAuthorityScopeTransitionDigest(value) },
  };
}

async function qualificationRun(
  command: readonly string[],
  commit = COMMIT,
): Promise<CommandResult> {
  const key = command.join(" ");
  if (key === "git rev-parse HEAD") return ok(`${commit}\n`);
  if (key === "git branch --show-current") return ok("feature/form-authority\n");
  if (key === "git status --porcelain=v1 -z --untracked-files=all") return ok("");
  throw new Error(`unexpected command: ${key}`);
}

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}
