import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult } from "../scripts/deploy/process.ts";
import {
  type RetirementProcess,
  type RetirementState,
  runRetirement,
} from "../scripts/deploy/retirement.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import {
  assertExactVersionBindingClosure,
  expectedTransitionBindingClosure,
  extractLegacyHostServiceBinding,
} from "../scripts/deploy/worker-state.ts";

const COMMIT = "a".repeat(40);
const REPAIR_COMMIT = "d".repeat(40);
const LEGACY_COMMIT = "b".repeat(40);
const DIGEST = createHash("sha256")
  .update("export default {fetch(){return new Response('ok')}};\n")
  .digest("hex");
const SCRIPT_ETAG = "provider-script-etag-v1";
const LEGACY_DIGEST = "c".repeat(64);
const VERSION_LEGACY = "00000000-0000-4000-8000-000000000001";
const VERSION_CANDIDATE = "00000000-0000-4000-8000-000000000002";
const VERSION_TOPOLOGY = "00000000-0000-4000-8000-000000000003";
const VERSION_TOKEN = "00000000-0000-4000-8000-000000000004";
const VERSION_TOKEN_RESTORED = "00000000-0000-4000-8000-000000000005";
const VERSION_ATTRIBUTION_REPAIRED = "00000000-0000-4000-8000-000000000006";
const VERSION_WRONG = "00000000-0000-4000-8000-000000000009";
const VERSION_INTERLEAVED = "00000000-0000-4000-8000-00000000000a";
const VERSION_REBOUND = "00000000-0000-4000-8000-00000000000b";
const SERVICE = "takosumi-platform";
const ENTRYPOINT = "TakosumiHostRuntimeMaterializerEntrypoint";

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
  sponsorship: true,
} satisfies DeployTarget;

const BASE_SECRETS = ["TAKOSERVER_SIGNING_KEY"];
const HOSTED_SPONSORSHIP_SECRET = "TAKOSERVER_HOSTED_SPONSORSHIP_TOKEN";
const HOSTED_SECRETS = [...BASE_SECRETS, HOSTED_SPONSORSHIP_SECRET];

describe("reviewed Hosted legacy-edge retirement", () => {
  test("requires the exact observed service and entrypoint closure", () => {
    const closure = expectedTransitionBindingClosure(target, {
      serviceBinding: { service: SERVICE, entrypoint: ENTRYPOINT },
      expectedSecrets: HOSTED_SECRETS,
    });
    const version = versionShape({ serviceBinding: { service: SERVICE, entrypoint: ENTRYPOINT } });
    expect(() =>
      assertExactVersionBindingClosure("preflight", VERSION_LEGACY, version, closure),
    ).not.toThrow();
    const wrong = versionShape({
      serviceBinding: { service: "other-service", entrypoint: ENTRYPOINT },
    });
    expect(() =>
      assertExactVersionBindingClosure("preflight", VERSION_LEGACY, wrong, closure),
    ).toThrow("unexpected service");
    expect(extractLegacyHostServiceBinding("preflight", VERSION_LEGACY, wrong)).toEqual({
      service: "other-service",
      entrypoint: ENTRYPOINT,
    });
  });

  test("authority transition preserves legacy edge and secret in one candidate upload", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-retirement-authority-"));
    try {
      const fixture = stateFixture("legacy");
      const result = await runRetirement(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
          legacyHostRuntimePredecessorVersionId: VERSION_LEGACY,
        },
        target,
        {
          run: fixture.run,
          state: fixture.state,
          outputDirectory: root,
          review: "reviewer@example.test",
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      );
      expect(result).toMatchObject({
        state: "candidate",
        previousVersionId: VERSION_LEGACY,
        versionId: VERSION_CANDIDATE,
        service: SERVICE,
        entrypoint: ENTRYPOINT,
      });
      const mutations = fixture.mutations.filter(({ command }) => command.includes("--no-bundle"));
      expect(mutations).toHaveLength(1);
      expect(mutations[0]?.command).toContain("--no-bundle");
      expect(mutations[0]?.command.join(" ")).not.toContain("secret delete");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("authority upload acknowledgement loss is status-only and never retried", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-retirement-authority-ack-loss-"));
    try {
      const fixture = stateFixture("legacy", "upload-ack-loss");
      await expect(
        runRetirement(
          {
            surface: "takoserver-worker-authority-cutover",
            action: "apply",
            environment: "integration",
            commit: COMMIT,
            legacyHostRuntimePredecessorVersionId: VERSION_LEGACY,
          },
          target,
          {
            run: fixture.run,
            state: fixture.state,
            outputDirectory: root,
            review: "reviewer@example.test",
            cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          },
        ),
      ).rejects.toThrow("indeterminate");
      expect(
        fixture.mutations.filter(({ command }) => command.includes("--no-bundle")),
      ).toHaveLength(1);
      const status = await runRetirement(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "status",
          environment: "integration",
          commit: COMMIT,
          legacyHostRuntimePredecessorVersionId: VERSION_LEGACY,
        },
        target,
        { run: fixture.run, state: fixture.state },
      );
      expect(status).toMatchObject({
        state: "candidate",
        versionId: VERSION_CANDIDATE,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("authority reverse restores exactly the pinned legacy predecessor", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-retirement-authority-reverse-"));
    try {
      const fixture = stateFixture("candidate");
      const result = await runRetirement(
        {
          surface: "takoserver-worker-authority-cutover",
          action: "apply",
          reverse: true,
          environment: "integration",
          commit: COMMIT,
          legacyHostRuntimePredecessorVersionId: VERSION_LEGACY,
        },
        target,
        {
          run: fixture.run,
          state: fixture.state,
          outputDirectory: root,
          review: "reviewer@example.test",
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      );
      expect(result).toMatchObject({
        state: "legacy-restored",
        versionId: VERSION_LEGACY,
        reverse: { exactVersionId: VERSION_LEGACY },
      });
      const mutations = fixture.mutations.filter(
        ({ command }) => command.includes("versions") && command.includes("deploy"),
      );
      expect(mutations).toHaveLength(1);
      expect(mutations[0]?.command.join(" ")).toContain(`${VERSION_LEGACY}@100%`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("topology retirement uploads byte-identical code while removing only the service", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-retirement-topology-"));
    try {
      const fixture = stateFixture("candidate");
      const result = await runRetirement(
        {
          surface: "takoserver-host-runtime-topology-retirement",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
          legacyHostRuntimePredecessorVersionId: VERSION_LEGACY,
        },
        target,
        {
          run: fixture.run,
          state: fixture.state,
          outputDirectory: root,
          review: "reviewer@example.test",
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      );
      expect(result).toMatchObject({
        state: "topology-retired",
        previousVersionId: VERSION_CANDIDATE,
        versionId: VERSION_TOPOLOGY,
        bundleDigest: `sha256:${DIGEST}`,
      });
      const mutations = fixture.mutations.filter(({ command }) => command.includes("--no-bundle"));
      expect(mutations).toHaveLength(1);
      expect(mutations[0]?.command.join(" ")).toContain("--no-bundle");
      expect(mutations[0]?.command.join(" ")).not.toContain("secret");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("topology status accepts a direct candidate with changed canonical identity", async () => {
    const fixture = stateFixture("candidate");
    const state: RetirementState = {
      ...fixture.state,
      async workerVersion(_worker, versionId) {
        if (versionId === VERSION_LEGACY) {
          return versionShape({
            serviceBinding: { service: SERVICE, entrypoint: ENTRYPOINT },
            includeHostedSecret: true,
            message: `takoserver-worker:${LEGACY_COMMIT}:${LEGACY_DIGEST}`,
          });
        }
        if (versionId === VERSION_CANDIDATE) {
          return versionShape({
            serviceBinding: { service: SERVICE, entrypoint: ENTRYPOINT },
            includeHostedSecret: true,
            message: `takoserver-worker:${COMMIT}:${DIGEST}`,
          });
        }
        return await fixture.state.workerVersion(_worker, versionId);
      },
    };
    const status = await runRetirement(
      {
        surface: "takoserver-host-runtime-topology-retirement",
        action: "status",
        environment: "integration",
        commit: COMMIT,
        legacyHostRuntimePredecessorVersionId: VERSION_LEGACY,
      },
      target,
      { run: fixture.run, state },
    );
    expect(status).toMatchObject({
      state: "candidate",
      versionId: VERSION_CANDIDATE,
      deployedCommit: COMMIT,
      artifactDigest: `sha256:${DIGEST}`,
      service: SERVICE,
      entrypoint: ENTRYPOINT,
    });
    expect(fixture.mutations).toHaveLength(0);
  });

  test("topology retirement rechecks authoritative state after sealing the artifact", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-retirement-topology-race-"));
    try {
      const fixture = stateFixture("candidate");
      let raced = false;
      const run: RetirementProcess = async (command, options) => {
        const result = await fixture.run(command, options);
        if (command.join(" ") === "bun run check") raced = true;
        return result;
      };
      const state: RetirementState = {
        ...fixture.state,
        async workerDeployments(workerName) {
          const history = await fixture.state.workerDeployments(workerName);
          if (!raced) return history;
          return [
            deployment("deployment-topology", VERSION_TOPOLOGY, "2026-08-29T06:00:00Z"),
            deployment("deployment-candidate", VERSION_CANDIDATE, "2026-08-29T05:00:00Z"),
            deployment("deployment-legacy", VERSION_LEGACY, "2026-08-29T04:00:00Z"),
          ];
        },
      };
      await expect(
        runRetirement(
          {
            surface: "takoserver-host-runtime-topology-retirement",
            action: "apply",
            environment: "integration",
            commit: COMMIT,
            legacyHostRuntimePredecessorVersionId: VERSION_LEGACY,
          },
          target,
          {
            run,
            state,
            outputDirectory: root,
            review: "reviewer@example.test",
            cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          },
        ),
      ).rejects.toThrow("changed before mutation");
      expect(
        fixture.mutations.filter(({ command }) => command.includes("--no-bundle")),
      ).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("topology upload acknowledgement loss stops without a second mutation", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-retirement-topology-ack-loss-"));
    try {
      const fixture = stateFixture("candidate", "upload-ack-loss");
      await expect(
        runRetirement(
          {
            surface: "takoserver-host-runtime-topology-retirement",
            action: "apply",
            environment: "integration",
            commit: COMMIT,
            legacyHostRuntimePredecessorVersionId: VERSION_LEGACY,
          },
          target,
          {
            run: fixture.run,
            state: fixture.state,
            outputDirectory: root,
            review: "reviewer@example.test",
            cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          },
        ),
      ).rejects.toThrow("indeterminate");
      expect(
        fixture.mutations.filter(({ command }) => command.includes("--no-bundle")),
      ).toHaveLength(1);
      const status = await runRetirement(
        {
          surface: "takoserver-host-runtime-topology-retirement",
          action: "status",
          environment: "integration",
          commit: COMMIT,
          legacyHostRuntimePredecessorVersionId: VERSION_LEGACY,
        },
        target,
        { run: fixture.run, state: fixture.state },
      );
      expect(status).toMatchObject({
        state: "topology-retired",
        versionId: VERSION_TOPOLOGY,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("topology retirement reverse uses exactly the direct provider-history predecessor", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-retirement-topology-reverse-"));
    try {
      const fixture = stateFixture("topology");
      const result = await runRetirement(
        {
          surface: "takoserver-host-runtime-topology-retirement",
          action: "apply",
          reverse: true,
          environment: "integration",
          commit: COMMIT,
          legacyHostRuntimePredecessorVersionId: VERSION_LEGACY,
        },
        target,
        {
          run: fixture.run,
          state: fixture.state,
          outputDirectory: root,
          review: "reviewer@example.test",
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      );
      expect(result).toMatchObject({
        state: "candidate-restored",
        versionId: VERSION_CANDIDATE,
        reverse: { exactVersionId: VERSION_CANDIDATE },
      });
      const mutations = fixture.mutations.filter(
        ({ command }) => command.includes("versions") && command.includes("deploy"),
      );
      expect(mutations).toHaveLength(1);
      expect(mutations[0]?.command.join(" ")).toContain(`${VERSION_CANDIDATE}@100%`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("topology reverse acknowledgement loss is reconciled on the direct retained history", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "takoserver-retirement-topology-reverse-direct-ack-loss-"),
    );
    try {
      const fixture = stateFixture("topology", "topology-reverse-ack-loss");
      await expect(
        runRetirement(
          {
            surface: "takoserver-host-runtime-topology-retirement",
            action: "apply",
            reverse: true,
            environment: "integration",
            commit: COMMIT,
            legacyHostRuntimePredecessorVersionId: VERSION_LEGACY,
          },
          target,
          {
            run: fixture.run,
            state: fixture.state,
            outputDirectory: root,
            review: "reviewer@example.test",
            cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          },
        ),
      ).rejects.toThrow("indeterminate");
      const status = await runRetirement(
        {
          surface: "takoserver-host-runtime-topology-retirement",
          action: "status",
          environment: "integration",
          commit: COMMIT,
          legacyHostRuntimePredecessorVersionId: VERSION_LEGACY,
        },
        target,
        { run: fixture.run, state: fixture.state },
      );
      expect(status).toMatchObject({
        state: "candidate-restored",
        versionId: VERSION_CANDIDATE,
        previousVersionId: VERSION_CANDIDATE,
      });
      expect(
        fixture.mutations.filter(
          ({ command }) => command.includes("versions") && command.includes("deploy"),
        ),
      ).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("topology reverse rechecks authoritative state immediately before redeploy", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-retirement-topology-reverse-race-"));
    try {
      const fixture = stateFixture("topology");
      let deploymentReads = 0;
      const state: RetirementState = {
        ...fixture.state,
        async workerDeployments(workerName) {
          deploymentReads += 1;
          const history = await fixture.state.workerDeployments(workerName);
          if (deploymentReads < 5) return history;
          return [
            deployment("deployment-candidate-race", VERSION_CANDIDATE, "2026-08-29T06:00:00Z"),
            deployment("deployment-topology", VERSION_TOPOLOGY, "2026-08-29T05:00:00Z"),
            deployment("deployment-candidate", VERSION_CANDIDATE, "2026-08-29T04:00:00Z"),
            deployment("deployment-legacy", VERSION_LEGACY, "2026-08-29T03:00:00Z"),
          ];
        },
      };
      await expect(
        runRetirement(
          {
            surface: "takoserver-host-runtime-topology-retirement",
            action: "apply",
            reverse: true,
            environment: "integration",
            commit: COMMIT,
            legacyHostRuntimePredecessorVersionId: VERSION_LEGACY,
          },
          target,
          {
            run: fixture.run,
            state,
            outputDirectory: root,
            review: "reviewer@example.test",
            cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          },
        ),
      ).rejects.toThrow("changed before mutation");
      expect(
        fixture.mutations.filter(
          ({ command }) => command.includes("versions") && command.includes("deploy"),
        ),
      ).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("topology reverse refuses an unattributed externally restored Version", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-retirement-topology-reverse-token-"));
    try {
      const fixture = stateFixture("tokenRestored");
      await expect(
        runRetirement(
          {
            surface: "takoserver-host-runtime-topology-retirement",
            action: "apply",
            reverse: true,
            environment: "integration",
            commit: COMMIT,
            legacyHostRuntimePredecessorVersionId: VERSION_LEGACY,
          },
          target,
          {
            run: fixture.run,
            state: fixture.state,
            outputDirectory: root,
            review: "reviewer@example.test",
            cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          },
        ),
      ).rejects.toThrow("byte-identical");
      expect(
        fixture.mutations.filter(
          ({ command }) => command.includes("versions") && command.includes("deploy"),
        ),
      ).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("topology reverse refuses an unattributed externally restored acknowledgement state", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-retirement-topology-reverse-ack-loss-"));
    try {
      const fixture = stateFixture("tokenRestored", "topology-reverse-ack-loss");
      await expect(
        runRetirement(
          {
            surface: "takoserver-host-runtime-topology-retirement",
            action: "apply",
            reverse: true,
            environment: "integration",
            commit: COMMIT,
            legacyHostRuntimePredecessorVersionId: VERSION_LEGACY,
          },
          target,
          {
            run: fixture.run,
            state: fixture.state,
            outputDirectory: root,
            review: "reviewer@example.test",
            cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          },
        ),
      ).rejects.toThrow("byte-identical");
      expect(
        fixture.mutations.filter(
          ({ command }) => command.includes("versions") && command.includes("deploy"),
        ),
      ).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("token retirement cannot attribute secret-created Versions and refuses reverse preflight", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-retirement-token-"));
    try {
      const fixture = stateFixture("topology");
      await expect(
        runRetirement(
          {
            surface: "takoserver-hosted-token-retirement",
            action: "apply",
            environment: "integration",
            commit: COMMIT,
            legacyHostRuntimePredecessorVersionId: VERSION_LEGACY,
          },
          target,
          {
            run: fixture.run,
            state: fixture.state,
            outputDirectory: root,
            review: "reviewer@example.test",
            cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          },
        ),
      ).rejects.toThrow("changed the served code identity");
      const mutations = fixture.mutations.filter(
        ({ command }) => command.includes("secret") && command.includes("delete"),
      );
      expect(mutations).toHaveLength(1);
      expect(mutations[0]?.command.join(" ")).toContain("secret delete");

      const status = await runRetirement(
        {
          surface: "takoserver-hosted-token-retirement",
          action: "status",
          environment: "integration",
          commit: COMMIT,
          legacyHostRuntimePredecessorVersionId: VERSION_LEGACY,
        },
        target,
        { run: fixture.run, state: fixture.state },
      );
      expect(status).toMatchObject({
        state: "token-retired-unattributed-successor",
        ready: false,
        repairRequired: true,
        versionId: VERSION_TOKEN,
        secretPresent: false,
      });

      await expect(
        runRetirement(
          {
            surface: "takoserver-hosted-token-retirement",
            action: "apply",
            reverse: true,
            environment: "integration",
            commit: COMMIT,
            legacyHostRuntimePredecessorVersionId: VERSION_LEGACY,
          },
          target,
          {
            run: fixture.run,
            state: fixture.state,
            outputDirectory: join(root, "reverse"),
            review: "reviewer@example.test",
            cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          },
        ),
      ).rejects.toThrow("forward-only");
      const reverseMutations = fixture.mutations.filter(
        ({ command }) => command.includes("secret") && command.includes("put"),
      );
      expect(reverseMutations).toHaveLength(0);
      expect(
        fixture.mutations.some(
          ({ command }) => command.includes("secret") && command.includes("put"),
        ),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("token deletion acknowledgement loss is status-only and never retried", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-retirement-token-ack-loss-"));
    try {
      const fixture = stateFixture("topology", "secret-delete-ack-loss");
      await expect(
        runRetirement(
          {
            surface: "takoserver-hosted-token-retirement",
            action: "apply",
            environment: "integration",
            commit: COMMIT,
            legacyHostRuntimePredecessorVersionId: VERSION_LEGACY,
          },
          target,
          {
            run: fixture.run,
            state: fixture.state,
            outputDirectory: root,
            review: "reviewer@example.test",
            cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          },
        ),
      ).rejects.toThrow("indeterminate");
      expect(
        fixture.mutations.filter(
          ({ command }) => command.includes("secret") && command.includes("delete"),
        ),
      ).toHaveLength(1);
      const status = await runRetirement(
        {
          surface: "takoserver-hosted-token-retirement",
          action: "status",
          environment: "integration",
          commit: COMMIT,
          legacyHostRuntimePredecessorVersionId: VERSION_LEGACY,
        },
        target,
        { run: fixture.run, state: fixture.state },
      );
      expect(status).toMatchObject({
        state: "token-retired-unattributed-successor",
        ready: false,
        versionId: VERSION_TOKEN,
        secretPresent: false,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("token deletion's direct successor can be unattributed without being complete", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-retirement-token-unattributed-"));
    try {
      const fixture = stateFixture("topology");
      await expect(
        runRetirement(
          {
            surface: "takoserver-hosted-token-retirement",
            action: "apply",
            environment: "integration",
            commit: COMMIT,
            legacyHostRuntimePredecessorVersionId: VERSION_LEGACY,
          },
          target,
          {
            run: fixture.run,
            state: fixture.state,
            outputDirectory: root,
            review: "reviewer@example.test",
            cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          },
        ),
      ).rejects.toThrow("changed the served code identity");

      const status = await runRetirement(
        {
          surface: "takoserver-hosted-token-retirement",
          action: "status",
          environment: "integration",
          commit: COMMIT,
          legacyHostRuntimePredecessorVersionId: VERSION_LEGACY,
        },
        target,
        { run: fixture.run, state: fixture.state },
      );
      expect(status).toMatchObject({
        state: "token-retired-unattributed-successor",
        ready: false,
        versionId: VERSION_TOKEN,
        secretPresent: false,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("attribution repair status proves the selected R against the trusted T script identity", async () => {
    const fixture = stateFixture("token");
    const status = await runRetirement(
      {
        surface: "takoserver-worker-retirement-attribution-repair",
        action: "status",
        environment: "integration",
        commit: COMMIT,
        legacyHostRuntimePredecessorVersionId: VERSION_LEGACY,
        unattributedSuccessorVersionId: VERSION_TOKEN,
      },
      target,
      { run: fixture.run, state: fixture.state, fetcher: probeFetcher },
    );
    expect(status).toMatchObject({
      state: "token-retired-unattributed-successor",
      ready: false,
      repairRequired: true,
      versionId: VERSION_TOKEN,
      previousVersionId: VERSION_TOPOLOGY,
      unattributedVersionId: VERSION_TOKEN,
      trustedTopologyVersionId: VERSION_TOPOLOGY,
      trustedCommit: COMMIT,
      trustedArtifactDigest: `sha256:${DIGEST}`,
      scriptContentIdentity: SCRIPT_ETAG,
      probe: { status: 200, openapi: { status: 200 } },
    });
    expect(fixture.mutations).toHaveLength(0);
  });

  test("attribution repair refuses a mismatched or missing provider script identity", async () => {
    for (const mode of ["mismatch", "missing"] as const) {
      const fixture = stateFixture("token");
      const state: RetirementState = {
        ...fixture.state,
        async workerVersion(workerName, versionId) {
          if (versionId !== VERSION_TOKEN) {
            return await fixture.state.workerVersion(workerName, versionId);
          }
          const version = versionShape({ includeHostedSecret: false, message: null });
          if (mode === "mismatch") {
            return versionShape({
              includeHostedSecret: false,
              message: null,
              scriptEtag: "provider-script-etag-r-mismatch",
            });
          }
          const resources = version.resources as Record<string, unknown>;
          return { ...version, resources: { bindings: resources.bindings } };
        },
      };
      await expect(
        runRetirement(
          {
            surface: "takoserver-worker-retirement-attribution-repair",
            action: "status",
            environment: "integration",
            commit: COMMIT,
            legacyHostRuntimePredecessorVersionId: VERSION_LEGACY,
            unattributedSuccessorVersionId: VERSION_TOKEN,
          },
          target,
          { run: fixture.run, state, fetcher: probeFetcher },
        ),
      ).rejects.toThrow(
        mode === "mismatch" ? "R script content differs" : "script content identity",
      );
      expect(fixture.mutations).toHaveLength(0);
    }
  });

  test("attribution repair uploads one sealed canonical successor without retired fields", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-attribution-repair-"));
    try {
      const fixture = stateFixture("token", undefined, REPAIR_COMMIT);
      const result = await runRetirement(
        {
          surface: "takoserver-worker-retirement-attribution-repair",
          action: "apply",
          environment: "integration",
          commit: REPAIR_COMMIT,
          legacyHostRuntimePredecessorVersionId: VERSION_LEGACY,
          unattributedSuccessorVersionId: VERSION_TOKEN,
        },
        target,
        {
          run: fixture.run,
          state: fixture.state,
          outputDirectory: root,
          fetcher: probeFetcher,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      );
      expect(result).toMatchObject({
        state: "token-retirement-attribution-repaired",
        previousVersionId: VERSION_TOKEN,
        versionId: VERSION_ATTRIBUTION_REPAIRED,
        commit: REPAIR_COMMIT,
        bundleDigest: `sha256:${DIGEST}`,
        scriptContentIdentity: SCRIPT_ETAG,
        probe: { status: 200, openapi: { status: 200 } },
      });
      const uploads = fixture.mutations.filter(({ command }) => command.includes("--no-bundle"));
      expect(uploads).toHaveLength(1);
      expect(uploads[0]?.command.join(" ")).toContain(
        `--message takoserver-worker:${REPAIR_COMMIT}:${DIGEST}`,
      );
      const realized = JSON.parse(
        await Bun.file(join(root, "release/wrangler.jsonc")).text(),
      ) as Record<string, unknown>;
      expect(JSON.stringify(realized)).not.toContain("HOST_RUNTIME_MATERIALIZER");
      expect(JSON.stringify(realized)).not.toContain(HOSTED_SPONSORSHIP_SECRET);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("attribution repair acknowledgement loss is settled by the exact A successor status", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-attribution-repair-ack-loss-"));
    try {
      const fixture = stateFixture("token", "repair-upload-ack-loss");
      await expect(
        runRetirement(
          {
            surface: "takoserver-worker-retirement-attribution-repair",
            action: "apply",
            environment: "integration",
            commit: COMMIT,
            legacyHostRuntimePredecessorVersionId: VERSION_LEGACY,
            unattributedSuccessorVersionId: VERSION_TOKEN,
          },
          target,
          {
            run: fixture.run,
            state: fixture.state,
            outputDirectory: root,
            fetcher: probeFetcher,
            cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          },
        ),
      ).rejects.toThrow("indeterminate");
      expect(
        fixture.mutations.filter(({ command }) => command.includes("--no-bundle")),
      ).toHaveLength(1);
      const status = await runRetirement(
        {
          surface: "takoserver-worker-retirement-attribution-repair",
          action: "status",
          environment: "integration",
          commit: COMMIT,
          legacyHostRuntimePredecessorVersionId: VERSION_LEGACY,
          unattributedSuccessorVersionId: VERSION_TOKEN,
        },
        target,
        { run: fixture.run, state: fixture.state, fetcher: probeFetcher },
      );
      expect(status).toMatchObject({
        state: "token-retirement-attribution-repaired",
        ready: true,
        repairRequired: false,
        versionId: VERSION_ATTRIBUTION_REPAIRED,
        previousVersionId: VERSION_TOKEN,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("attribution repair refuses status and apply when either public probe advances history", async () => {
    for (const action of ["status", "apply"] as const) {
      for (const probePhase of ["root", "openapi"] as const) {
        const root = mkdtempSync(join(tmpdir(), "takoserver-attribution-repair-probe-race-"));
        try {
          const fixture = stateFixture(action === "status" ? "repaired" : "token");
          const fetcher = async (input: string): Promise<Response> => {
            const isRootProbe = input.endsWith("/.well-known/takoserver");
            const isOpenApiProbe = input.endsWith("/openapi.json");
            if (
              (probePhase === "root" && isRootProbe) ||
              (probePhase === "openapi" && isOpenApiProbe)
            ) {
              fixture.advanceToWrong();
            }
            return await probeFetcher(input);
          };
          await expect(
            runRetirement(
              {
                surface: "takoserver-worker-retirement-attribution-repair",
                action,
                environment: "integration",
                commit: COMMIT,
                legacyHostRuntimePredecessorVersionId: VERSION_LEGACY,
                unattributedSuccessorVersionId: VERSION_TOKEN,
              },
              target,
              {
                run: fixture.run,
                state: fixture.state,
                fetcher,
                ...(action === "apply"
                  ? {
                      outputDirectory: root,
                      cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
                    }
                  : {}),
              },
            ),
          ).rejects.toThrow("attribution repair");
          expect(
            fixture.mutations.filter(({ command }) => command.includes("--no-bundle")),
          ).toHaveLength(action === "apply" ? 1 : 0);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    }
  });

  test("token retirement rechecks authoritative state immediately before deleting", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-retirement-token-race-"));
    try {
      const fixture = stateFixture("topology");
      let deploymentReads = 0;
      const state: RetirementState = {
        ...fixture.state,
        async workerDeployments(workerName) {
          deploymentReads += 1;
          const history = await fixture.state.workerDeployments(workerName);
          if (deploymentReads < 5) return history;
          return [
            deployment("deployment-token-race", VERSION_TOKEN, "2026-08-29T06:00:00Z"),
            deployment("deployment-topology", VERSION_TOPOLOGY, "2026-08-29T05:00:00Z"),
            deployment("deployment-candidate", VERSION_CANDIDATE, "2026-08-29T04:00:00Z"),
            deployment("deployment-legacy", VERSION_LEGACY, "2026-08-29T03:00:00Z"),
          ];
        },
      };
      await expect(
        runRetirement(
          {
            surface: "takoserver-hosted-token-retirement",
            action: "apply",
            environment: "integration",
            commit: COMMIT,
            legacyHostRuntimePredecessorVersionId: VERSION_LEGACY,
          },
          target,
          {
            run: fixture.run,
            state,
            outputDirectory: root,
            review: "reviewer@example.test",
            cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          },
        ),
      ).rejects.toThrow("changed before mutation");
      expect(fixture.mutations.filter(({ command }) => command.includes("secret"))).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("retirement rejects a valid selector that does not pin the L-to-C-to-T-to-R chain", async () => {
    const cases = [
      {
        surface: "takoserver-host-runtime-topology-retirement",
        stage: "candidate",
      },
      {
        surface: "takoserver-host-runtime-topology-retirement",
        stage: "topology",
      },
      {
        surface: "takoserver-hosted-token-retirement",
        stage: "topology",
      },
      {
        surface: "takoserver-hosted-token-retirement",
        stage: "token",
      },
      {
        surface: "takoserver-host-runtime-topology-retirement",
        stage: "tokenRestored",
      },
    ] as const;

    for (const { surface, stage } of cases) {
      const fixture = stateFixture(stage);
      await expect(
        runRetirement(
          {
            surface,
            action: "status",
            environment: "integration",
            commit: COMMIT,
            legacyHostRuntimePredecessorVersionId: VERSION_WRONG,
          },
          target,
          { run: fixture.run, state: fixture.state },
        ),
      ).rejects.toThrow("pinned legacy predecessor");
      expect(
        fixture.mutations.filter(
          ({ command }) =>
            command.includes("--no-bundle") ||
            (command.includes("secret") && (command.includes("delete") || command.includes("put"))),
        ),
      ).toHaveLength(0);
    }
  });

  test("retirement rejects an interleaved lookalike Version before mutation", async () => {
    const fixture = stateFixture("topology");
    const state: RetirementState = {
      ...fixture.state,
      async workerDeployments() {
        return [
          deployment("deployment-topology", VERSION_TOPOLOGY, "2026-08-29T05:00:00Z"),
          deployment("deployment-interleaved", VERSION_INTERLEAVED, "2026-08-29T04:00:00Z"),
          deployment("deployment-candidate", VERSION_CANDIDATE, "2026-08-29T03:00:00Z"),
          deployment("deployment-legacy", VERSION_LEGACY, "2026-08-29T02:00:00Z"),
        ];
      },
      async workerVersion(workerName, versionId) {
        if (versionId === VERSION_INTERLEAVED) {
          return versionShape({ message: `takoserver-worker:${COMMIT}:${DIGEST}` });
        }
        return await fixture.state.workerVersion(workerName, versionId);
      },
    };
    await expect(
      runRetirement(
        {
          surface: "takoserver-host-runtime-topology-retirement",
          action: "status",
          environment: "integration",
          commit: COMMIT,
          legacyHostRuntimePredecessorVersionId: VERSION_LEGACY,
        },
        target,
        { run: fixture.run, state },
      ),
    ).rejects.toThrow("unrelated");
    expect(
      fixture.mutations.filter(
        ({ command }) => command.includes("--no-bundle") || command.includes("secret"),
      ),
    ).toHaveLength(0);
  });

  test("retirement rejects an unpermitted rebound Version or cycle before mutation", async () => {
    const cases = [
      {
        history: [
          deployment("deployment-rebound", VERSION_REBOUND, "2026-08-29T05:00:00Z"),
          deployment("deployment-topology", VERSION_TOPOLOGY, "2026-08-29T04:00:00Z"),
          deployment("deployment-candidate", VERSION_CANDIDATE, "2026-08-29T03:00:00Z"),
          deployment("deployment-legacy", VERSION_LEGACY, "2026-08-29T02:00:00Z"),
        ],
        message: "unexpected candidate Version",
      },
      {
        history: [
          deployment("deployment-rebound", VERSION_CANDIDATE, "2026-08-29T05:00:00Z"),
          deployment("deployment-token-restored", VERSION_TOPOLOGY, "2026-08-29T04:00:00Z"),
          deployment("deployment-token", VERSION_TOKEN, "2026-08-29T03:00:00Z"),
          deployment("deployment-topology", VERSION_TOPOLOGY, "2026-08-29T02:00:00Z"),
          deployment("deployment-candidate", VERSION_CANDIDATE, "2026-08-29T01:00:00Z"),
          deployment("deployment-legacy", VERSION_LEGACY, "2026-08-29T00:00:00Z"),
        ],
        message: "Version cycle",
      },
      {
        history: [
          deployment("deployment-rebound", VERSION_CANDIDATE, "2026-08-29T05:00:00Z"),
          deployment("deployment-token-restored", VERSION_TOKEN_RESTORED, "2026-08-29T04:00:00Z"),
          deployment("deployment-token", VERSION_TOKEN, "2026-08-29T03:00:00Z"),
          deployment("deployment-topology", VERSION_TOPOLOGY, "2026-08-29T02:00:00Z"),
          deployment("deployment-legacy-candidate", VERSION_LEGACY, "2026-08-29T01:00:00Z"),
          deployment("deployment-legacy", VERSION_LEGACY, "2026-08-29T00:00:00Z"),
        ],
        message: "unexpected candidate Version",
      },
    ] as const;

    for (const { history, message } of cases) {
      const fixture = stateFixture("topology");
      const state: RetirementState = {
        ...fixture.state,
        async workerDeployments() {
          return history;
        },
        async workerVersion(workerName, versionId) {
          if (versionId === VERSION_REBOUND) {
            return versionShape({
              serviceBinding: { service: SERVICE, entrypoint: ENTRYPOINT },
            });
          }
          return await fixture.state.workerVersion(workerName, versionId);
        },
      };
      await expect(
        runRetirement(
          {
            surface: "takoserver-host-runtime-topology-retirement",
            action: "status",
            environment: "integration",
            commit: COMMIT,
            legacyHostRuntimePredecessorVersionId: VERSION_LEGACY,
          },
          target,
          { run: fixture.run, state },
        ),
      ).rejects.toThrow(message);
      expect(
        fixture.mutations.filter(
          ({ command }) => command.includes("--no-bundle") || command.includes("secret"),
        ),
      ).toHaveLength(0);
    }
  });

  test("retirement rejects duplicate provider deployment identities before mutation", async () => {
    const fixture = stateFixture("topology");
    const state: RetirementState = {
      ...fixture.state,
      async workerDeployments() {
        return [
          deployment("deployment-duplicate", VERSION_TOPOLOGY, "2026-08-29T05:00:00Z"),
          deployment("deployment-duplicate", VERSION_CANDIDATE, "2026-08-29T04:00:00Z"),
          deployment("deployment-legacy", VERSION_LEGACY, "2026-08-29T03:00:00Z"),
        ];
      },
    };
    await expect(
      runRetirement(
        {
          surface: "takoserver-host-runtime-topology-retirement",
          action: "status",
          environment: "integration",
          commit: COMMIT,
          legacyHostRuntimePredecessorVersionId: VERSION_LEGACY,
        },
        target,
        { run: fixture.run, state },
      ),
    ).rejects.toThrow("duplicate deployment IDs");
    expect(
      fixture.mutations.filter(
        ({ command }) => command.includes("--no-bundle") || command.includes("secret"),
      ),
    ).toHaveLength(0);
  });

  test("retirement refuses a topology without a direct service predecessor", async () => {
    const fixture = stateFixture("topology");
    const state: RetirementState = {
      ...fixture.state,
      async workerDeployments() {
        return [deployment("deployment-current", VERSION_TOPOLOGY, "2026-08-29T02:00:00Z")];
      },
    };
    await expect(
      runRetirement(
        {
          surface: "takoserver-host-runtime-topology-retirement",
          action: "status",
          environment: "integration",
          commit: COMMIT,
          legacyHostRuntimePredecessorVersionId: VERSION_LEGACY,
        },
        target,
        {
          run: fixture.run,
          state,
          review: "reviewer@example.test",
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      ),
    ).rejects.toThrow("direct candidate predecessor");
  });
});

function stateFixture(
  stage: "legacy" | "candidate" | "topology" | "token" | "tokenRestored" | "repaired",
  failure?:
    | "upload-ack-loss"
    | "secret-delete-ack-loss"
    | "repair-upload-ack-loss"
    | "topology-reverse-ack-loss",
  headCommit = COMMIT,
) {
  let current = stage;
  let history = initialHistory(stage);
  let deploymentSequence = history.length;
  let advancedToWrong = false;
  const mutations: { command: string[]; input?: string }[] = [];
  let buildConfig: string | undefined;
  const appendDeployment = (versionId: string): void => {
    deploymentSequence += 1;
    history = [{ deploymentId: `deployment-${deploymentSequence}`, versionId }, ...history];
  };
  const advanceToWrong = (): void => {
    if (advancedToWrong) return;
    advancedToWrong = true;
    appendDeployment(VERSION_WRONG);
  };
  const run: RetirementProcess = async (command, options): Promise<CommandResult> => {
    mutations.push({
      command: [...command],
      ...(options?.input === undefined ? {} : { input: options.input }),
    });
    const key = command.join(" ");
    if (key === "git rev-parse HEAD") return ok(`${headCommit}\n`);
    if (key === "git branch --show-current") return ok("feature/retirement\n");
    if (key === "git status --porcelain=v1 -z --untracked-files=all") return ok("");
    if (key === "bun run check") return ok("green\n");
    if (command.includes("--dry-run")) {
      buildConfig = command[command.indexOf("--config") + 1];
      const out = command[command.indexOf("--outdir") + 1];
      if (!out) throw new Error("missing outdir");
      writeFileSync(
        join(out, "index.js"),
        "export default {fetch(){return new Response('ok')}};\n",
      );
      return ok("built\n");
    }
    if (command.includes("deploy") && command.includes("--no-bundle")) {
      if (stage === "token") {
        current = "repaired";
        appendDeployment(VERSION_ATTRIBUTION_REPAIRED);
      } else {
        current = stage === "legacy" ? "candidate" : "topology";
        appendDeployment(current === "candidate" ? VERSION_CANDIDATE : VERSION_TOPOLOGY);
      }
      if (
        failure === "upload-ack-loss" ||
        (stage === "token" && failure === "repair-upload-ack-loss")
      )
        return { exitCode: 1, stdout: "", stderr: "closed" };
      return ok("uploaded\n");
    }
    if (command.includes("secret") && command.includes("delete")) {
      current = "token";
      appendDeployment(VERSION_TOKEN);
      if (failure === "secret-delete-ack-loss")
        return { exitCode: 1, stdout: "", stderr: "closed" };
      return ok("deleted\n");
    }
    if (command.includes("versions") && command.includes("deploy")) {
      const selected = command.find((entry) => entry.endsWith("@100%"))?.slice(0, -5);
      if (!selected) throw new Error("missing rollback Version");
      appendDeployment(selected);
      current = selected === VERSION_LEGACY ? "legacy" : "candidate";
      if (failure === "topology-reverse-ack-loss") {
        return { exitCode: 1, stdout: "", stderr: "closed" };
      }
      return ok("restored\n");
    }
    throw new Error(`unexpected command: ${key}`);
  };
  const state: RetirementState = {
    async workerDomains() {
      return [{ hostname: "api.integration.example.test", service: target.workerName }];
    },
    async workerDeployments() {
      return history.map(({ deploymentId, versionId }, index) =>
        deployment(
          deploymentId,
          versionId,
          new Date(Date.parse("2026-08-29T12:00:00Z") - index * 60_000).toISOString(),
        ),
      );
    },
    async workerVersion(_worker, versionId) {
      const serviceBinding =
        versionId === VERSION_LEGACY || versionId === VERSION_CANDIDATE
          ? { service: SERVICE, entrypoint: ENTRYPOINT }
          : undefined;
      const includesHostedSecret =
        versionId !== VERSION_TOKEN &&
        versionId !== VERSION_ATTRIBUTION_REPAIRED &&
        versionId !== VERSION_WRONG;
      return versionShape({
        ...(serviceBinding === undefined ? {} : { serviceBinding }),
        includeHostedSecret: includesHostedSecret,
        message:
          versionId === VERSION_LEGACY ||
          versionId === VERSION_TOKEN ||
          versionId === VERSION_TOKEN_RESTORED
            ? null
            : versionId === VERSION_WRONG
              ? `takoserver-worker:${COMMIT}:${LEGACY_DIGEST}`
              : `takoserver-worker:${versionId === VERSION_ATTRIBUTION_REPAIRED ? headCommit : COMMIT}:${DIGEST}`,
      });
    },
    async workerSecrets() {
      return (current === "token" || current === "repaired" ? BASE_SECRETS : HOSTED_SECRETS).map(
        (name) => ({
          name,
          type: "secret_text",
        }),
      );
    },
  };
  return { run, state, mutations, buildConfig, advanceToWrong };
}

function initialHistory(
  stage: "legacy" | "candidate" | "topology" | "token" | "tokenRestored" | "repaired",
): { deploymentId: string; versionId: string }[] {
  const chain =
    stage === "legacy"
      ? [VERSION_LEGACY]
      : stage === "candidate"
        ? [VERSION_CANDIDATE, VERSION_LEGACY]
        : stage === "topology"
          ? [VERSION_TOPOLOGY, VERSION_CANDIDATE, VERSION_LEGACY]
          : stage === "token"
            ? [VERSION_TOKEN, VERSION_TOPOLOGY, VERSION_CANDIDATE, VERSION_LEGACY]
            : [
                VERSION_TOKEN_RESTORED,
                VERSION_TOKEN,
                VERSION_TOPOLOGY,
                VERSION_CANDIDATE,
                VERSION_LEGACY,
              ];
  const repaired = [
    VERSION_ATTRIBUTION_REPAIRED,
    VERSION_TOKEN,
    VERSION_TOPOLOGY,
    VERSION_CANDIDATE,
    VERSION_LEGACY,
  ];
  const selected = stage === "repaired" ? repaired : chain;
  return selected.map((versionId, index) => ({
    deploymentId: `deployment-${index + 1}`,
    versionId,
  }));
}

function versionShape(input: {
  readonly serviceBinding?: { readonly service: string; readonly entrypoint: string };
  readonly includeHostedSecret?: boolean;
  readonly message?: string | null;
  readonly scriptEtag?: string;
}) {
  const bindings = [
    { type: "ai", name: "AI" },
    { type: "version_metadata", name: "WORKER_VERSION" },
    { type: "d1", name: "STATE_DB", id: target.d1.databaseId },
    { type: "r2_bucket", name: "OBJECTS", bucket_name: target.r2.bucketName },
    { type: "plain_text", name: "PUBLIC_ORIGIN", text: target.publicOrigin },
    { type: "plain_text", name: "TAKOSERVER_SIGNING_KEY_ID", text: target.signing.currentKeyId },
    ...(input.includeHostedSecret === false
      ? []
      : [{ type: "secret_text", name: "TAKOSERVER_HOSTED_SPONSORSHIP_TOKEN" }]),
    { type: "secret_text", name: "TAKOSERVER_SIGNING_KEY" },
    ...(input.serviceBinding === undefined
      ? []
      : [{ type: "service", name: "HOST_RUNTIME_MATERIALIZER", ...input.serviceBinding }]),
  ];
  return {
    ...(input.message === null
      ? {}
      : {
          annotations: {
            "workers/message": input.message ?? `takoserver-worker:${COMMIT}:${DIGEST}`,
          },
        }),
    resources: { bindings, script: { etag: input.scriptEtag ?? SCRIPT_ETAG } },
  };
}

function deployment(id: string, versionId: string, created: string) {
  return { id, created_on: created, versions: [{ version_id: versionId, percentage: 100 }] };
}

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
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
      openapi: `${target.publicOrigin}/openapi.json`,
    },
  });
}
