import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LEGACY_OPERATOR_PUBLIC_JWK_SECRET,
  type LegacyOperatorAuthorityProcess,
  type LegacyOperatorAuthorityState,
  runLegacyOperatorAuthorityTransition,
} from "../scripts/deploy/legacy-operator-authority-retirement.ts";
import type { CommandResult } from "../scripts/deploy/process.ts";
import { expectedWorkerSecrets } from "../scripts/deploy/realized-config.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import { runWorker } from "../scripts/deploy/worker.ts";
import { expectedExactBindingClosure } from "../scripts/deploy/worker-state.ts";

const COMMIT = "a".repeat(40);
const BUNDLE_DIGEST = "b".repeat(64);
const SCRIPT_ETAG = "provider-script-etag-operator-authority-v1";
const VERSION_LEGACY = "00000000-0000-4000-8000-000000000001";
const VERSION_RETIRED = "00000000-0000-4000-8000-000000000002";
const VERSION_RESTORED = "00000000-0000-4000-8000-000000000003";
const VERSION_WRONG = "00000000-0000-4000-8000-000000000009";
const PUBLIC_JWK = { kty: "OKP" as const, crv: "Ed25519" as const, x: "A".repeat(43) };
const PUBLIC_JWK_BYTES = JSON.stringify(PUBLIC_JWK);
const PUBLIC_JWK_DIGEST = sha256(PUBLIC_JWK_BYTES);

const target = {
  kind: "takoserver.deploy-target@v2",
  environment: "integration",
  accountId: "a".repeat(32),
  workerName: "takoserver-api-integration",
  d1: {
    databaseName: "takoserver-runtime-integration",
    databaseId: "00000000-0000-4000-8000-000000000000",
  },
  r2: { bucketName: "takoserver-objects-integration" },
  publicOrigin: "https://api.integration.example.test",
  consoleOrigin: "https://console.integration.example.test",
  stripeCheckout: true,
  operatorIdentity: { publicJwk: PUBLIC_JWK },
  signing: { currentKeyId: "key-current" },
} satisfies DeployTarget;

const BASE_SECRETS = expectedWorkerSecrets(target);
const LEGACY_SECRETS = [...BASE_SECRETS, LEGACY_OPERATOR_PUBLIC_JWK_SECRET].sort();

describe("legacy operator authority retirement and exact restore", () => {
  test("status accepts only the exact v2 desired closure plus the one legacy secret", async () => {
    const fixture = transitionFixture("legacy");
    const result = await runLegacyOperatorAuthorityTransition(
      retirementInvocation("status", VERSION_LEGACY),
      target,
      { state: fixture.state, fetcher: probeFetcher },
    );

    expect(result).toMatchObject({
      kind: "takoserver.legacy-operator-authority-retirement-status@v1",
      surface: "takoserver-integration-legacy-operator-authority-retirement",
      state: "legacy-operator-authority-present",
      ready: false,
      retirementApplyReady: true,
      selectedPredecessorVersionId: VERSION_LEGACY,
      versionId: VERSION_LEGACY,
      deployedCommit: COMMIT,
      bundleDigest: `sha256:${BUNDLE_DIGEST}`,
      scriptEtag: SCRIPT_ETAG,
      legacySecretPresent: true,
      replacementIdentity: {
        binding: "OPERATOR_IDENTITY_PUBLIC_JWK",
        publicJwkDigest: PUBLIC_JWK_DIGEST,
      },
      replacementSettlement: {
        provider: "stripe-checkout",
        secretBinding: "STRIPE_SECRET_KEY",
      },
      probe: { status: 200, openapi: { status: 200 } },
    });
    expect(fixture.mutations).toHaveLength(0);
  });

  test("retirement refuses a missing replacement identity or settlement/checkout authority", async () => {
    const cases: { readonly selected: DeployTarget; readonly message: string }[] = [
      {
        selected: withoutTargetField(target, "operatorIdentity"),
        message: "replacement operator identity",
      },
      {
        selected: { ...target, stripeCheckout: false },
        message: "replacement settlement/checkout",
      },
      {
        selected: withoutTargetField(target, "consoleOrigin"),
        message: "replacement settlement/checkout",
      },
    ];

    for (const { selected, message } of cases) {
      const fixture = transitionFixture("legacy", { selectedTarget: selected });
      const failure = await runLegacyOperatorAuthorityTransition(
        retirementInvocation("status", VERSION_LEGACY),
        selected,
        { state: fixture.state, fetcher: probeFetcher },
      ).catch((error) => error);
      expect(failure).toMatchObject({ phase: "preflight" });
      expect(failure.message).toContain(message);
      expect(fixture.reads()).toEqual({ deployments: 0, versions: 0, secrets: 0, domains: 0 });
      expect(fixture.mutations).toHaveLength(0);
    }
  });

  test("retirement refuses partial or foreign secret state", async () => {
    for (const inventory of [
      LEGACY_SECRETS.filter((name) => name !== "STRIPE_SECRET_KEY"),
      [...LEGACY_SECRETS, "FOREIGN_SECRET"],
    ]) {
      const fixture = transitionFixture("legacy", { inventory });
      const failure = await runLegacyOperatorAuthorityTransition(
        retirementInvocation("status", VERSION_LEGACY),
        target,
        { state: fixture.state, fetcher: probeFetcher },
      ).catch((error) => error);
      expect(failure).toMatchObject({ phase: "preflight" });
      expect(failure.message).toMatch(/secret|closure/i);
      expect(fixture.mutations).toHaveLength(0);
    }

    const fixture = transitionFixture("legacy", {
      mutateVersion(value) {
        const changed = structuredClone(value) as {
          resources: { bindings: Record<string, unknown>[] };
        };
        changed.resources.bindings.push({
          name: "FOREIGN_SECRET",
          type: "secret_text",
        });
        return changed;
      },
    });
    await expect(
      runLegacyOperatorAuthorityTransition(retirementInvocation("status", VERSION_LEGACY), target, {
        state: fixture.state,
        fetcher: probeFetcher,
      }),
    ).rejects.toThrow("exact selected target closure");
    expect(fixture.mutations).toHaveLength(0);
  });

  test("status refuses a wrong or non-direct predecessor selector", async () => {
    const wrong = transitionFixture("legacy");
    await expect(
      runLegacyOperatorAuthorityTransition(retirementInvocation("status", VERSION_WRONG), target, {
        state: wrong.state,
        fetcher: probeFetcher,
      }),
    ).rejects.toThrow(/selected predecessor|direct successor/);

    const nonDirect = transitionFixture("restored");
    await expect(
      runLegacyOperatorAuthorityTransition(retirementInvocation("status", VERSION_LEGACY), target, {
        state: nonDirect.state,
        fetcher: probeFetcher,
      }),
    ).rejects.toThrow(/selected predecessor|direct successor/);
    expect(nonDirect.mutations).toHaveLength(0);
  });

  test("retirement deletes only OPERATOR_PUBLIC_JWK and verifies the exact direct successor", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-legacy-operator-retirement-"));
    try {
      const fixture = transitionFixture("legacy");
      const result = await runLegacyOperatorAuthorityTransition(
        retirementInvocation("apply", VERSION_LEGACY),
        target,
        applyOptions(fixture, root),
      );

      expect(result).toMatchObject({
        kind: "takoserver.legacy-operator-authority-retirement-apply@v1",
        state: "legacy-operator-authority-retired",
        previousVersionId: VERSION_LEGACY,
        versionId: VERSION_RETIRED,
        commit: COMMIT,
        bundleDigest: `sha256:${BUNDLE_DIGEST}`,
        scriptEtag: SCRIPT_ETAG,
        secretRemoved: LEGACY_OPERATOR_PUBLIC_JWK_SECRET,
        reviewer: "reviewer@example.test",
        probe: { status: 200, openapi: { status: 200 } },
      });
      expect(fixture.mutations).toHaveLength(1);
      expect(fixture.mutations[0]?.command).toEqual(
        expect.arrayContaining([
          "secret",
          "delete",
          LEGACY_OPERATOR_PUBLIC_JWK_SECRET,
          "--name",
          target.workerName,
        ]),
      );
      expect(fixture.mutations[0]?.input).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("retirement re-reads the exact predecessor immediately before mutation", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-legacy-operator-race-"));
    try {
      const fixture = transitionFixture("legacy", { advanceBeforeMutation: true });
      const failure = await runLegacyOperatorAuthorityTransition(
        retirementInvocation("apply", VERSION_LEGACY),
        target,
        applyOptions(fixture, root),
      ).catch((error) => error);
      expect(failure).toMatchObject({ phase: "preflight" });
      expect(failure.message).toMatch(/changed|selected predecessor|direct successor/);
      expect(fixture.mutations).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a lost retirement acknowledgement is status-only and never blindly retried", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-legacy-operator-ack-"));
    try {
      const fixture = transitionFixture("legacy", { acknowledgementLoss: "delete" });
      const failure = await runLegacyOperatorAuthorityTransition(
        retirementInvocation("apply", VERSION_LEGACY),
        target,
        applyOptions(fixture, root),
      ).catch((error) => error);
      expect(failure).toMatchObject({ phase: "mutation" });
      expect(failure.message).toContain("indeterminate");
      expect(fixture.mutations).toHaveLength(1);

      const status = await runLegacyOperatorAuthorityTransition(
        retirementInvocation("status", VERSION_LEGACY),
        target,
        { state: fixture.state, fetcher: probeFetcher },
      );
      expect(status).toMatchObject({
        state: "legacy-operator-authority-retired",
        ready: true,
        retirementApplyReady: false,
        previousVersionId: VERSION_LEGACY,
        versionId: VERSION_RETIRED,
      });

      await expect(
        runLegacyOperatorAuthorityTransition(
          retirementInvocation("apply", VERSION_LEGACY),
          target,
          applyOptions(fixture, root),
        ),
      ).rejects.toThrow(/status|already retired/);
      expect(fixture.mutations).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("exact restore sends only the canonical owned 0600 public JWK on stdin", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-legacy-operator-restore-"));
    try {
      const publicJwkPath = join(root, "legacy-operator-public.jwk");
      writeFileSync(publicJwkPath, PUBLIC_JWK_BYTES, { mode: 0o600 });
      const fixture = transitionFixture("retired");
      const result = await runLegacyOperatorAuthorityTransition(
        restoreInvocation("apply", VERSION_RETIRED),
        target,
        {
          ...applyOptions(fixture, join(root, "work")),
          publicJwkPath,
        },
      );

      expect(result).toMatchObject({
        kind: "takoserver.legacy-operator-authority-restore-apply@v1",
        state: "legacy-operator-authority-restored",
        previousVersionId: VERSION_RETIRED,
        versionId: VERSION_RESTORED,
        commit: COMMIT,
        publicJwkDigest: PUBLIC_JWK_DIGEST,
        secretRestored: LEGACY_OPERATOR_PUBLIC_JWK_SECRET,
        probe: { status: 200, openapi: { status: 200 } },
      });
      expect(fixture.mutations).toHaveLength(1);
      const mutation = fixture.mutations[0];
      expect(mutation?.command).toEqual(
        expect.arrayContaining([
          "secret",
          "put",
          LEGACY_OPERATOR_PUBLIC_JWK_SECRET,
          "--name",
          target.workerName,
        ]),
      );
      expect(mutation?.input).toBe(PUBLIC_JWK_BYTES);
      expect(mutation?.command.join(" ")).not.toContain(PUBLIC_JWK_BYTES);
      expect(mutation?.command.join(" ")).not.toContain(publicJwkPath);
      const rendered = JSON.stringify(result);
      expect(rendered).not.toContain(PUBLIC_JWK_BYTES);
      expect(rendered).not.toContain(PUBLIC_JWK.x);
      expect(rendered).not.toContain(publicJwkPath);

      const status = await runLegacyOperatorAuthorityTransition(
        restoreInvocation("status", VERSION_RETIRED),
        target,
        { state: fixture.state, fetcher: probeFetcher },
      );
      expect(status).toMatchObject({
        state: "legacy-operator-authority-restored",
        ready: true,
        restoreApplyReady: false,
        previousVersionId: VERSION_RETIRED,
        versionId: VERSION_RESTORED,
        expectedPublicJwkDigest: PUBLIC_JWK_DIGEST,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("restore refuses unsafe or non-exact input without exposing its path or bytes", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-legacy-operator-input-"));
    try {
      const unsafePath = join(root, "unsafe-legacy-public.jwk");
      writeFileSync(unsafePath, PUBLIC_JWK_BYTES, { mode: 0o644 });
      chmodSync(unsafePath, 0o644);
      const fixture = transitionFixture("retired");
      const unsafe = await runLegacyOperatorAuthorityTransition(
        restoreInvocation("apply", VERSION_RETIRED),
        target,
        {
          ...applyOptions(fixture, join(root, "unsafe-work")),
          publicJwkPath: unsafePath,
        },
      ).catch((error) => error);
      const unsafeRendered = `${unsafe.message}\n${String(unsafe.detail)}`;
      expect(unsafe).toMatchObject({ phase: "preflight" });
      expect(unsafe.message).toContain("owned 0600 link-free");
      expect(unsafeRendered).not.toContain(unsafePath);
      expect(unsafeRendered).not.toContain(PUBLIC_JWK_BYTES);
      expect(fixture.mutations).toHaveLength(0);

      const targetPath = join(root, "target-public.jwk");
      const linkPath = join(root, "linked-public.jwk");
      writeFileSync(targetPath, PUBLIC_JWK_BYTES, { mode: 0o600 });
      symlinkSync(targetPath, linkPath);
      const linked = await runLegacyOperatorAuthorityTransition(
        restoreInvocation("apply", VERSION_RETIRED),
        target,
        {
          ...applyOptions(transitionFixture("retired"), join(root, "link-work")),
          publicJwkPath: linkPath,
        },
      ).catch((error) => error);
      expect(linked).toMatchObject({ phase: "preflight" });
      expect(linked.message).toContain("owned 0600 link-free");
      expect(`${linked.message}\n${String(linked.detail)}`).not.toContain(linkPath);

      const mismatchedPath = join(root, "mismatched-public.jwk");
      const mismatched = JSON.stringify({ ...PUBLIC_JWK, x: "B".repeat(43) });
      writeFileSync(mismatchedPath, mismatched, { mode: 0o600 });
      const mismatch = await runLegacyOperatorAuthorityTransition(
        restoreInvocation("apply", VERSION_RETIRED),
        target,
        {
          ...applyOptions(transitionFixture("retired"), join(root, "mismatch-work")),
          publicJwkPath: mismatchedPath,
        },
      ).catch((error) => error);
      expect(mismatch).toMatchObject({ phase: "preflight" });
      expect(mismatch.message).toContain("expected operator identity");
      expect(`${mismatch.message}\n${String(mismatch.detail)}`).not.toContain(mismatched);
      expect(`${mismatch.message}\n${String(mismatch.detail)}`).not.toContain(mismatchedPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("restore redacts the input path, JWK bytes, public x and provider token on lost acknowledgement", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-legacy-operator-redaction-"));
    try {
      const publicJwkPath = join(root, "operator-public-sensitive-name.jwk");
      writeFileSync(publicJwkPath, PUBLIC_JWK_BYTES, { mode: 0o600 });
      const token = "provider-token-do-not-print";
      const fixture = transitionFixture("retired", {
        acknowledgementLoss: "put",
        providerDiagnostic: `${publicJwkPath} ${PUBLIC_JWK_BYTES} ${PUBLIC_JWK.x} ${token}`,
      });
      const failure = await runLegacyOperatorAuthorityTransition(
        restoreInvocation("apply", VERSION_RETIRED),
        target,
        {
          ...applyOptions(fixture, join(root, "work"), token),
          publicJwkPath,
        },
      ).catch((error) => error);
      const rendered = `${failure.message}\n${String(failure.detail)}\n${JSON.stringify(failure)}`;
      expect(failure).toMatchObject({ phase: "mutation" });
      expect(failure.message).toContain("indeterminate");
      expect(rendered).toContain("[redacted]");
      expect(rendered).not.toContain(publicJwkPath);
      expect(rendered).not.toContain(PUBLIC_JWK_BYTES);
      expect(rendered).not.toContain(PUBLIC_JWK.x);
      expect(rendered).not.toContain(token);
      expect(fixture.mutations).toHaveLength(1);

      const status = await runLegacyOperatorAuthorityTransition(
        restoreInvocation("status", VERSION_RETIRED),
        target,
        { state: fixture.state, fetcher: probeFetcher },
      );
      expect(status).toMatchObject({
        state: "legacy-operator-authority-restored",
        ready: true,
        restoreApplyReady: false,
        previousVersionId: VERSION_RETIRED,
        versionId: VERSION_RESTORED,
      });
      await expect(
        runLegacyOperatorAuthorityTransition(restoreInvocation("apply", VERSION_RETIRED), target, {
          ...applyOptions(fixture, join(root, "retry-work"), token),
          publicJwkPath,
        }),
      ).rejects.toThrow(/status|already restored/);
      expect(fixture.mutations).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("successor code or binding drift is never accepted as the transition", async () => {
    const changedCode = transitionFixture("retired", {
      mutateVersion(value, versionId) {
        if (versionId !== VERSION_RETIRED) return value;
        const changed = structuredClone(value) as { resources: { script: { etag: string } } };
        changed.resources.script.etag = "foreign-script-etag";
        return changed;
      },
    });
    await expect(
      runLegacyOperatorAuthorityTransition(retirementInvocation("status", VERSION_LEGACY), target, {
        state: changedCode.state,
        fetcher: probeFetcher,
      }),
    ).rejects.toThrow(/script|code/i);

    const foreignBinding = transitionFixture("retired", {
      mutateVersion(value, versionId) {
        if (versionId !== VERSION_RETIRED) return value;
        const changed = structuredClone(value) as {
          resources: { bindings: Record<string, unknown>[] };
        };
        changed.resources.bindings.push({
          name: "FOREIGN_AUTHORITY",
          type: "plain_text",
          text: "unexpected",
        });
        return changed;
      },
    });
    await expect(
      runLegacyOperatorAuthorityTransition(retirementInvocation("status", VERSION_LEGACY), target, {
        state: foreignBinding.state,
        fetcher: probeFetcher,
      }),
    ).rejects.toThrow("exact selected target closure");
  });

  test("ordinary Worker and authority-cutover surfaces cannot carry the legacy secret", async () => {
    for (const surface of ["takoserver-worker", "takoserver-worker-authority-cutover"] as const) {
      const root = mkdtempSync(join(tmpdir(), "takoserver-legacy-operator-bypass-"));
      try {
        const fixture = transitionFixture("legacy");
        const failure = await runWorker(
          { surface, action: "status", environment: "integration", commit: COMMIT },
          target,
          {
            state: fixture.state,
            migrations: {
              async read() {
                return { local: [], applied: [] };
              },
            },
            outputDirectory: root,
          },
        ).catch((error) => error);
        expect(failure).toMatchObject({ phase: "preflight" });
        expect(failure.message).toContain("exact selected target closure");
        expect(fixture.mutations).toHaveLength(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});

function retirementInvocation(action: "status" | "apply", predecessor: string) {
  return {
    surface: "takoserver-integration-legacy-operator-authority-retirement" as const,
    action,
    environment: "integration" as const,
    commit: COMMIT,
    legacyOperatorAuthorityPredecessorVersionId: predecessor,
  };
}

function restoreInvocation(action: "status" | "apply", predecessor: string) {
  return {
    surface: "takoserver-integration-legacy-operator-authority-restore" as const,
    action,
    environment: "integration" as const,
    commit: COMMIT,
    legacyOperatorAuthorityPredecessorVersionId: predecessor,
  };
}

function applyOptions(
  fixture: ReturnType<typeof transitionFixture>,
  outputDirectory: string,
  token = "provider-token",
) {
  return {
    state: fixture.state,
    run: fixture.run,
    outputDirectory,
    review: "reviewer@example.test",
    cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: token },
    fetcher: probeFetcher,
  };
}

function transitionFixture(
  initial: "legacy" | "retired" | "restored",
  options: {
    readonly selectedTarget?: DeployTarget;
    readonly inventory?: readonly string[];
    readonly acknowledgementLoss?: "delete" | "put";
    readonly providerDiagnostic?: string;
    readonly advanceBeforeMutation?: boolean;
    readonly mutateVersion?: (value: unknown, versionId: string) => unknown;
  } = {},
) {
  const selected = options.selectedTarget ?? target;
  let stage = initial;
  let deploymentReads = 0;
  const reads = { deployments: 0, versions: 0, secrets: 0, domains: 0 };
  const mutations: { command: string[]; input?: string }[] = [];
  const state: LegacyOperatorAuthorityState = {
    async workerDeployments() {
      reads.deployments += 1;
      deploymentReads += 1;
      if (options.advanceBeforeMutation && deploymentReads >= 3 && stage === "legacy") {
        return history("restored");
      }
      return history(stage);
    },
    async workerVersion(_workerName, versionId) {
      reads.versions += 1;
      const value = versionFor(selected, versionId);
      return options.mutateVersion?.(value, versionId) ?? value;
    },
    async workerSecrets() {
      reads.secrets += 1;
      const names = options.inventory ?? (stage === "retired" ? BASE_SECRETS : LEGACY_SECRETS);
      return names.map((name) => ({ name, type: "secret_text" }));
    },
    async workerDomains() {
      reads.domains += 1;
      return [{ hostname: "api.integration.example.test", service: selected.workerName }];
    },
  };
  const run: LegacyOperatorAuthorityProcess = async (command, commandOptions) => {
    const key = command.join(" ");
    if (key === "git rev-parse HEAD") return ok(`${COMMIT}\n`);
    if (key === "git branch --show-current") return ok("fix/operator-authority\n");
    if (key === "git status --porcelain=v1 -z --untracked-files=all") return ok("");
    if (command.includes("secret") && command.includes("delete")) {
      mutations.push({ command: [...command] });
      stage = "retired";
      return options.acknowledgementLoss === "delete"
        ? failed(options.providerDiagnostic ?? "acknowledgement lost")
        : ok("deleted\n");
    }
    if (command.includes("secret") && command.includes("put")) {
      mutations.push({
        command: [...command],
        ...(commandOptions?.input === undefined ? {} : { input: commandOptions.input }),
      });
      stage = "restored";
      return options.acknowledgementLoss === "put"
        ? failed(options.providerDiagnostic ?? "acknowledgement lost")
        : ok("restored\n");
    }
    throw new Error(`unexpected command: ${key}`);
  };
  return { state, run, mutations, reads: () => ({ ...reads }) };
}

function versionFor(selected: DeployTarget, versionId: string): unknown {
  const legacyPresent = versionId === VERSION_LEGACY || versionId === VERSION_RESTORED;
  const expectedSecrets = legacyPresent
    ? [...expectedWorkerSecrets(selected), LEGACY_OPERATOR_PUBLIC_JWK_SECRET].sort()
    : expectedWorkerSecrets(selected);
  const closure = expectedExactBindingClosure(selected, {
    signingKeyId: selected.signing.currentKeyId,
    expectedSecrets,
    workerArtifactDigest: `sha256:${BUNDLE_DIGEST}`,
  });
  return {
    annotations:
      versionId === VERSION_LEGACY
        ? {
            "workers/message": `takoserver-worker:${COMMIT}:${BUNDLE_DIGEST}`,
            "workers/triggered_by": "version_upload",
          }
        : { "workers/triggered_by": "secret" },
    resources: {
      bindings: Object.entries(closure).flatMap(([name, requirement]) =>
        requirement === null ? [] : [{ name, type: requirement.type, ...requirement.fields }],
      ),
      script: { etag: SCRIPT_ETAG },
    },
  };
}

function history(stage: "legacy" | "retired" | "restored") {
  const versions =
    stage === "legacy"
      ? [VERSION_LEGACY]
      : stage === "retired"
        ? [VERSION_RETIRED, VERSION_LEGACY]
        : [VERSION_RESTORED, VERSION_RETIRED, VERSION_LEGACY];
  return versions.map((versionId, index) =>
    deployment(
      `deployment-${versionId}`,
      versionId,
      new Date(Date.parse("2026-08-30T12:00:00Z") - index * 60_000).toISOString(),
    ),
  );
}

function deployment(id: string, versionId: string, created: string) {
  return { id, created_on: created, versions: [{ version_id: versionId, percentage: 100 }] };
}

async function probeFetcher(input: string): Promise<Response> {
  if (input.endsWith("/openapi.json")) {
    return Response.json({ servers: [{ url: target.publicOrigin }] });
  }
  return Response.json({
    product: "takoserver",
    apiVersion: "v1",
    endpoints: {
      api: target.publicOrigin,
      console: target.consoleOrigin,
      openapi: `${target.publicOrigin}/openapi.json`,
    },
  });
}

function withoutTargetField<K extends keyof DeployTarget>(
  value: DeployTarget,
  field: K,
): DeployTarget {
  const clone = { ...value } as Record<string, unknown>;
  delete clone[field as string];
  return clone as unknown as DeployTarget;
}

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function failed(stderr: string): CommandResult {
  return { exitCode: 1, stdout: "", stderr };
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
