import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  callLoopbackArtifactRecovery,
  type ExactArtifactRecoveryDeployOptions,
  type RecoveryCallerSession,
  runExactArtifactRecovery,
} from "../scripts/deploy/artifact-recovery.ts";
import type { CommandResult } from "../scripts/deploy/process.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import type { LiveWorkerVersion } from "../scripts/deploy/worker-live.ts";
import { assertArtifactRecoveryRpcTarget } from "../src/artifact-recovery-worker.ts";
import { INTEGRATION_E2E_ORGANIZATION_ID } from "../src/integration-e2e-credential-authority.ts";
import { canonicalDigest } from "../src/json.ts";
import {
  type ArtifactRecoveryRequest,
  canonicalArtifactRecoveryRequest,
} from "../src/takoform/artifact-recovery.ts";

const COMMIT = "a".repeat(40);
const BUNDLE_DIGEST = "b".repeat(64);
const VERSION_ID = "00000000-0000-4000-8000-000000000001";
const roots: string[] = [];

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
  signing: { currentKeyId: "key-current" },
  integrationE2eCredentialAuthority: {
    organizationId: INTEGRATION_E2E_ORGANIZATION_ID,
    publicJwk: { kty: "OKP", crv: "Ed25519", x: "E".repeat(43) },
  },
} satisfies DeployTarget;

const live: LiveWorkerVersion = {
  history: {
    deploymentId: "deployment-one",
    versionId: VERSION_ID,
    previousVersionId: null,
  },
  commit: COMMIT,
  bundleDigestHex: BUNDLE_DIGEST,
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("exact failed-run artifact recovery owner surface", () => {
  test("status uses one read-only RPC and exact live identity readback", async () => {
    const requestPath = await writeRequest();
    const fixture = callerFixture();
    let inspections = 0;
    const commands: string[] = [];
    const qualified = qualification();
    const result = await runExactArtifactRecovery(invocation("status"), target, {
      ...baseOptions(requestPath),
      run: async (command) => {
        commands.push(command.join(" "));
        return await qualified(command);
      },
      inspectLive: async () => {
        inspections += 1;
        return live;
      },
      openCaller: fixture.open,
    });

    expect(fixture.actions).toEqual(["status"]);
    expect(fixture.closed).toBe(true);
    expect(inspections).toBe(2);
    expect(commands).not.toContain("bun run check");
    expect(result).toMatchObject({
      kind: "takoserver.exact-failed-run-artifact-recovery-owner-result@v1",
      action: "status",
      environment: "integration",
      selectedCommit: COMMIT,
      workerVersionId: VERSION_ID,
      workerArtifactDigest: `sha256:${BUNDLE_DIGEST}`,
      requestDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      receiptId: expect.stringMatching(/^afr_[0-9a-f]{64}$/),
    });
    expect(JSON.stringify(result)).not.toContain(requestPath);
    expect(JSON.stringify(result)).not.toContain("tenant_a");
    expect(JSON.stringify(result)).not.toContain("run:failed-a");
  });

  test("apply sends exactly one mutation then one status and requires review", async () => {
    const requestPath = await writeRequest();
    const fixture = callerFixture();
    const result = await runExactArtifactRecovery(invocation("apply"), target, {
      ...baseOptions(requestPath),
      review: "reviewer@example.test",
      inspectLive: async () => live,
      openCaller: fixture.open,
    });

    expect(fixture.actions).toEqual(["apply", "status"]);
    expect(fixture.closed).toBe(true);
    expect(result.reviewer).toBe("reviewer@example.test");

    const refusedRun = qualification();
    let refusedGateCalls = 0;
    let refusedCallerOpens = 0;
    const refused = await runExactArtifactRecovery(invocation("apply"), target, {
      ...baseOptions(requestPath),
      review: "",
      run: async (command) => {
        if (command.join(" ") === "bun run check") refusedGateCalls += 1;
        return await refusedRun(command);
      },
      inspectLive: async () => live,
      openCaller: async () => {
        refusedCallerOpens += 1;
        return callerFixture().session;
      },
    }).catch((error) => error);
    expect(refused).toMatchObject({ phase: "preflight" });
    expect(refused.message).toContain("INDEPENDENT_REVIEW");
    expect(refusedGateCalls).toBe(0);
    expect(refusedCallerOpens).toBe(0);
  });

  test("apply runs the owner gate exactly once before caller startup, then re-fences immediately before mutation", async () => {
    const requestPath = await writeRequest();
    const fixture = callerFixture();
    const events: string[] = [];
    const qualified = qualification();
    let inspections = 0;
    const session: RecoveryCallerSession = {
      async call(value, timeoutMilliseconds) {
        const action = (value as { readonly action: string }).action;
        events.push(`rpc:${action}`);
        return await fixture.session.call(value, timeoutMilliseconds);
      },
      async close() {
        events.push("close");
        await fixture.session.close();
      },
    };

    await runExactArtifactRecovery(invocation("apply"), target, {
      ...baseOptions(requestPath),
      review: "reviewer@example.test",
      run: async (command) => {
        if (command.join(" ") === "bun run check") events.push("gate");
        return await qualified(command);
      },
      inspectLive: async () => {
        inspections += 1;
        events.push(`inspect:${inspections}`);
        return live;
      },
      openCaller: async () => {
        events.push("open");
        return session;
      },
    });

    expect(events).toEqual([
      "inspect:1",
      "gate",
      "open",
      "inspect:2",
      "rpc:apply",
      "rpc:status",
      "close",
      "inspect:3",
    ]);
    expect(events.filter((event) => event === "gate")).toHaveLength(1);
    expect(events.filter((event) => event === "rpc:apply")).toHaveLength(1);
  });

  test("a failing owner gate refuses apply before opening the caller", async () => {
    const requestPath = await writeRequest();
    const qualified = qualification();
    let gateCalls = 0;
    let opened = 0;
    const failure = await runExactArtifactRecovery(invocation("apply"), target, {
      ...baseOptions(requestPath),
      review: "reviewer@example.test",
      run: async (command) => {
        if (command.join(" ") !== "bun run check") return await qualified(command);
        gateCalls += 1;
        return { exitCode: 1, stdout: "", stderr: "simulated owner gate failure" };
      },
      inspectLive: async () => live,
      openCaller: async () => {
        opened += 1;
        return callerFixture().session;
      },
    }).catch((error) => error);

    expect(failure).toMatchObject({ phase: "preflight" });
    expect(failure.message).toContain("scoped owner gate");
    expect(failure.detail).toContain("simulated owner gate failure");
    expect(gateCalls).toBe(1);
    expect(opened).toBe(0);
  });

  test("refuses wrong environment, dirty source, and mismatched live identity before opening RPC", async () => {
    const requestPath = await writeRequest();
    let opened = 0;
    const open = async (): Promise<RecoveryCallerSession> => {
      opened += 1;
      return callerFixture().session;
    };
    const wrongEnvironment = await runExactArtifactRecovery(
      { ...invocation("status"), environment: "rehearsal" },
      { ...target, environment: "rehearsal" },
      { ...baseOptions(requestPath), inspectLive: async () => live, openCaller: open },
    ).catch((error) => error);
    expect(wrongEnvironment).toMatchObject({ phase: "preflight" });
    expect(wrongEnvironment.message).toContain("integration-only");

    const dirty = await runExactArtifactRecovery(invocation("status"), target, {
      ...baseOptions(requestPath),
      run: qualification(" M scripts/deploy.ts\0"),
      inspectLive: async () => live,
      openCaller: open,
    }).catch((error) => error);
    expect(dirty).toMatchObject({ phase: "preflight" });
    expect(dirty.message).toContain("clean worktree");

    const wrongCommit = await runExactArtifactRecovery(invocation("status"), target, {
      ...baseOptions(requestPath),
      inspectLive: async () => ({ ...live, commit: "c".repeat(40) }),
      openCaller: open,
    }).catch((error) => error);
    expect(wrongCommit).toMatchObject({ phase: "preflight" });
    expect(wrongCommit.message).toContain("source commit");
    expect(opened).toBe(0);
  });

  test("refuses relative, symlink, hardlink, and non-0600 request files", async () => {
    const real = await writeRequest();
    const root = roots.at(-1);
    if (!root) throw new Error("missing temporary root");
    const symlink = join(root, "request-link.json");
    const hardlink = join(root, "request-hardlink.json");
    symlinkSync(real, symlink);
    linkSync(real, hardlink);

    const relative = await runExactArtifactRecovery(invocation("status"), target, {
      ...baseOptions("request.json"),
      inspectLive: async () => live,
      openCaller: callerFixture().open,
    }).catch((error) => error);
    expect(relative).toMatchObject({ phase: "preflight" });
    expect(relative.message).toContain("must be absolute");

    for (const requestPath of [symlink, hardlink]) {
      const refused = await runExactArtifactRecovery(invocation("status"), target, {
        ...baseOptions(requestPath),
        inspectLive: async () => live,
        openCaller: callerFixture().open,
      }).catch((error) => error);
      expect(refused).toMatchObject({ phase: "preflight" });
      expect(refused.message).toContain("link-free");
    }

    rmSync(hardlink);
    for (const permissions of [0o640]) {
      chmodSync(real, permissions);
      const mode = await runExactArtifactRecovery(invocation("status"), target, {
        ...baseOptions(real),
        inspectLive: async () => live,
        openCaller: callerFixture().open,
      }).catch((error) => error);
      expect(mode).toMatchObject({ phase: "preflight" });
      expect(mode.message).toContain("0600");
    }
  });

  test("fails closed on live Version drift after caller startup but before the apply RPC", async () => {
    const requestPath = await writeRequest();
    const fixture = callerFixture();
    let inspections = 0;
    const failure = await runExactArtifactRecovery(invocation("apply"), target, {
      ...baseOptions(requestPath),
      review: "reviewer@example.test",
      inspectLive: async () => {
        inspections += 1;
        return inspections === 1
          ? live
          : {
              ...live,
              history: { ...live.history, versionId: "00000000-0000-4000-8000-000000000002" },
            };
      },
      openCaller: fixture.open,
    }).catch((error) => error);
    expect(failure).toMatchObject({ phase: "preflight" });
    expect(failure.message).toContain("before mutation");
    expect(fixture.actions).toEqual([]);
    expect(fixture.closed).toBe(true);
  });

  test("classifies post-apply live inspection failure as verification", async () => {
    const requestPath = await writeRequest();
    const fixture = callerFixture();
    let inspections = 0;
    const failure = await runExactArtifactRecovery(invocation("apply"), target, {
      ...baseOptions(requestPath),
      review: "reviewer@example.test",
      inspectLive: async () => {
        inspections += 1;
        if (inspections === 3) throw new Error("simulated live readback outage");
        return live;
      },
      openCaller: fixture.open,
    }).catch((error) => error);
    expect(failure).toMatchObject({ phase: "verification" });
    expect(fixture.actions).toEqual(["apply", "status"]);
    expect(fixture.closed).toBe(true);
  });

  test("an apply timeout or malformed acknowledgement is indeterminate and never retried", async () => {
    const requestPath = await writeRequest();
    for (const mode of ["throw", "malformed", "mismatched-readback"] as const) {
      let calls = 0;
      let closed = false;
      const openCaller = async (): Promise<RecoveryCallerSession> => ({
        async call(value) {
          calls += 1;
          if (mode === "throw") throw new Error("simulated timeout");
          if (mode === "malformed") return { kind: "wrong" };
          const input = value as {
            readonly action: string;
            readonly target: Record<string, unknown>;
          };
          return {
            kind: "takoserver.exact-failed-run-artifact-recovery-rpc-result@v1",
            action: input.action,
            target: input.target,
            result: {},
          };
        },
        async close() {
          closed = true;
        },
      });
      const failure = await runExactArtifactRecovery(invocation("apply"), target, {
        ...baseOptions(requestPath),
        review: "reviewer@example.test",
        inspectLive: async () => live,
        openCaller,
      }).catch((error) => error);
      expect(failure).toMatchObject({ phase: "mutation" });
      expect(failure.message).toContain("indeterminate");
      expect(calls).toBe(1);
      expect(closed).toBe(true);
    }
  });
});

describe("temporary artifact recovery caller transport", () => {
  test("refuses redirects without following them", async () => {
    let redirectMode: RequestRedirect | undefined;
    const failure = await callLoopbackArtifactRecovery({
      fetcher: async (_url, init) => {
        redirectMode = init?.redirect;
        return new Response(null, { status: 307, headers: { location: "https://evil.test/" } });
      },
      port: 8080,
      token: "secret",
      value: {},
      timeoutMilliseconds: 1_000,
    }).catch((error) => error);
    expect(redirectMode).toBe("manual");
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error("expected redirect failure");
    expect(failure.message).toContain("redirect");
  });

  test("aborts a bounded call instead of retrying", async () => {
    let calls = 0;
    const failure = await callLoopbackArtifactRecovery({
      fetcher: async (_url, init) => {
        calls += 1;
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      },
      port: 8080,
      token: "secret",
      value: {},
      timeoutMilliseconds: 5,
    }).catch((error) => error);
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error("expected abort failure");
    expect(failure.name).toBe("AbortError");
    expect(calls).toBe(1);
  });
});

test("the named RPC independently refuses every live target identity drift", () => {
  const rpcTarget = {
    environment: "integration" as const,
    workerVersionId: VERSION_ID,
    sourceCommit: COMMIT,
    workerArtifactDigest: `sha256:${BUNDLE_DIGEST}` as const,
  };
  const env = {
    WORKER_VERSION: { id: VERSION_ID },
    TAKOSERVER_ENVIRONMENT: "integration",
    TAKOSERVER_SOURCE_COMMIT: COMMIT,
    TAKOSERVER_WORKER_ARTIFACT_DIGEST: `sha256:${BUNDLE_DIGEST}`,
  };
  expect(() => assertArtifactRecoveryRpcTarget(env, rpcTarget)).not.toThrow();
  for (const drift of [
    { ...env, TAKOSERVER_ENVIRONMENT: "production" },
    { ...env, WORKER_VERSION: { id: "00000000-0000-4000-8000-000000000002" } },
    { ...env, TAKOSERVER_SOURCE_COMMIT: "c".repeat(40) },
    { ...env, TAKOSERVER_WORKER_ARTIFACT_DIGEST: `sha256:${"d".repeat(64)}` },
  ]) {
    expect(() => assertArtifactRecoveryRpcTarget(drift, rpcTarget)).toThrow();
  }
});

function invocation(action: "status" | "apply") {
  return {
    surface: "takoserver-integration-exact-failed-run-artifact-recovery" as const,
    action,
    environment: "integration" as const,
    commit: COMMIT,
  };
}

function baseOptions(requestPath: string): ExactArtifactRecoveryDeployOptions {
  return {
    requestPath,
    run: qualification(),
    cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "test-cloudflare-token" },
  };
}

function qualification(dirty = "") {
  return async (command: readonly string[]): Promise<CommandResult> => {
    const key = command.join(" ");
    if (key === "git rev-parse HEAD") return ok(`${COMMIT}\n`);
    if (key === "git branch --show-current") return ok("feature/exact-recovery\n");
    if (key === "git status --porcelain=v1 -z --untracked-files=all") return ok(dirty);
    if (key === "bun run check") return ok("owner gate passed\n");
    throw new Error(`unexpected command: ${key}`);
  };
}

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function callerFixture() {
  const actions: string[] = [];
  let closed = false;
  let applied = false;
  const session: RecoveryCallerSession = {
    async call(value) {
      const input = value as {
        readonly action: "status" | "apply";
        readonly target: Record<string, unknown>;
        readonly request: unknown;
      };
      actions.push(input.action);
      const canonical = await canonicalArtifactRecoveryRequest(input.request);
      const readback = (phase: "eligible" | "quarantined") => ({
        kind: "takoserver.exact-failed-run-artifact-recovery-readback@v1",
        requestDigest: canonical.requestDigest,
        receiptId: canonical.receiptId,
        phase,
        upload: {
          lifecycle: "committed",
          fence: canonical.request.uploadFence + (phase === "eligible" ? 0 : 1),
        },
        candidates:
          phase === "eligible"
            ? { pending: 0, deleting: 0, retry: 0, deleted: 0 }
            : { pending: 29, deleting: 0, retry: 0, deleted: 0 },
        quarantineNotBefore: phase === "eligible" ? null : canonical.request.closedAt + 60 * 60_000,
        metadataPresent: true,
        presentBlobs: 28,
        absentBlobs: 0,
      });
      let result: unknown;
      if (input.action === "apply") {
        const planBody = {
          kind: "takoserver.exact-failed-run-artifact-recovery-plan@v1" as const,
          requestDigest: canonical.requestDigest,
          receiptId: canonical.receiptId,
          observedPhase: "eligible" as const,
          action: "issue-receipt" as const,
        };
        applied = true;
        result = {
          kind: "takoserver.exact-failed-run-artifact-recovery-apply@v1",
          plan: { ...planBody, planDigest: await canonicalDigest(planBody) },
          readback: readback("quarantined"),
        };
      } else {
        result = readback(applied ? "quarantined" : "eligible");
      }
      return {
        kind: "takoserver.exact-failed-run-artifact-recovery-rpc-result@v1",
        action: input.action,
        target: input.target,
        result,
      };
    },
    async close() {
      closed = true;
    },
  };
  return {
    actions,
    session,
    get closed() {
      return closed;
    },
    open: async () => session,
  };
}

async function writeRequest(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "takoserver-artifact-recovery-request-"));
  roots.push(root);
  const request = await exactRequest();
  const path = join(root, "request.json");
  writeFileSync(path, `${JSON.stringify(request)}\n`, { mode: 0o600, flag: "wx" });
  return path;
}

async function exactRequest(): Promise<ArtifactRecoveryRequest> {
  const memberDigests = Array.from(
    { length: 28 },
    (_, index) => `sha256:${index.toString(16).padStart(64, "0")}` as `sha256:${string}`,
  );
  const manifestDigest = `sha256:${"f".repeat(64)}` as const;
  const holds = [
    { kind: "manifest" as const, digest: manifestDigest },
    ...memberDigests.map((memberDigest) => ({ kind: "blob" as const, digest: memberDigest })),
  ];
  const replayKeys = ["tenant_a\0run:failed-a\0commit", "tenant_a\0run:failed-a\0start"];
  return {
    kind: "takoserver.exact-failed-run-artifact-recovery-request@v1",
    tenantId: "tenant_a",
    principalId: "run:failed-a",
    uploadId: "up_failed_a",
    manifestDigest,
    uploadFence: 2,
    rootFence: 2,
    memberDigests,
    memberSetDigest: await canonicalDigest(memberDigests),
    expectedHolds: {
      entries: holds,
      count: holds.length,
      setDigest: await canonicalDigest(holds),
    },
    expectedReplays: {
      keys: replayKeys,
      count: replayKeys.length,
      setDigest: await canonicalDigest(replayKeys),
    },
    failedRunEvidence: {
      kind: "takosumi.apply-run-failure@v1",
      sha256: `sha256:${"e".repeat(64)}`,
    },
    closedAt: Date.parse("2026-09-08T00:00:00.000Z"),
  };
}
