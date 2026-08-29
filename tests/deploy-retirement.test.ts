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
const DIGEST = createHash("sha256")
  .update("export default {fetch(){return new Response('ok')}};\n")
  .digest("hex");
const VERSION_LEGACY = "00000000-0000-4000-8000-000000000001";
const VERSION_CANDIDATE = "00000000-0000-4000-8000-000000000002";
const VERSION_TOPOLOGY = "00000000-0000-4000-8000-000000000003";
const VERSION_TOKEN = "00000000-0000-4000-8000-000000000004";
const VERSION_TOKEN_RESTORED = "00000000-0000-4000-8000-000000000005";
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
const HOSTED_SECRETS = [...BASE_SECRETS, "TAKOSERVER_HOSTED_SPONSORSHIP_TOKEN"];

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

  test("token retirement deletes last and reverse re-puts the owned token", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-retirement-token-"));
    try {
      const tokenPath = join(root, "token");
      writeFileSync(tokenPath, "hosted-token-exact", { mode: 0o600 });
      const fixture = stateFixture("topology");
      const result = await runRetirement(
        {
          surface: "takoserver-hosted-token-retirement",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        target,
        {
          run: fixture.run,
          state: fixture.state,
          tokenPath,
          outputDirectory: root,
          review: "reviewer@example.test",
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      );
      expect(result).toMatchObject({
        state: "token-retired",
        versionId: VERSION_TOKEN,
        previousVersionId: VERSION_TOPOLOGY,
      });
      const mutations = fixture.mutations.filter(
        ({ command }) => command.includes("secret") && command.includes("delete"),
      );
      expect(mutations).toHaveLength(1);
      expect(mutations[0]?.command.join(" ")).toContain("secret delete");

      const reverseFixture = stateFixture("token");
      const reversed = await runRetirement(
        {
          surface: "takoserver-hosted-token-retirement",
          action: "apply",
          reverse: true,
          environment: "integration",
          commit: COMMIT,
        },
        target,
        {
          run: reverseFixture.run,
          state: reverseFixture.state,
          tokenPath,
          outputDirectory: join(root, "reverse"),
          review: "reviewer@example.test",
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      );
      expect(reversed).toMatchObject({
        state: "token-restored",
        versionId: VERSION_TOKEN_RESTORED,
        previousVersionId: VERSION_TOKEN,
      });
      const reverseMutations = reverseFixture.mutations.filter(
        ({ command }) => command.includes("secret") && command.includes("put"),
      );
      expect(reverseMutations).toHaveLength(1);
      expect(reverseMutations[0]?.command.join(" ")).toContain("secret put");
      expect(reverseMutations[0]?.input).toBe("hosted-token-exact");
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
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
  stage: "legacy" | "candidate" | "topology" | "token" | "tokenRestored",
  failure?: "upload-ack-loss" | "secret-delete-ack-loss",
) {
  let current = stage;
  const mutations: { command: string[]; input?: string }[] = [];
  let buildConfig: string | undefined;
  const run: RetirementProcess = async (command, options): Promise<CommandResult> => {
    mutations.push({
      command: [...command],
      ...(options?.input === undefined ? {} : { input: options.input }),
    });
    const key = command.join(" ");
    if (key === "git rev-parse HEAD") return ok(`${COMMIT}\n`);
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
      if (failure === "upload-ack-loss") return { exitCode: 1, stdout: "", stderr: "closed" };
      current = stage === "legacy" ? "candidate" : "topology";
      return ok("uploaded\n");
    }
    if (command.includes("secret") && command.includes("delete")) {
      if (failure === "secret-delete-ack-loss")
        return { exitCode: 1, stdout: "", stderr: "closed" };
      current = "token";
      return ok("deleted\n");
    }
    if (command.includes("versions") && command.includes("deploy")) {
      current = stage === "topology" || stage === "tokenRestored" ? "candidate" : "legacy";
      return ok("restored\n");
    }
    if (command.includes("secret") && command.includes("put")) {
      current = "tokenRestored";
      return ok("put\n");
    }
    throw new Error(`unexpected command: ${key}`);
  };
  const state: RetirementState = {
    async workerDomains() {
      return [{ hostname: "api.integration.example.test", service: target.workerName }];
    },
    async workerDeployments() {
      const chain =
        current === "legacy"
          ? [VERSION_LEGACY]
          : current === "candidate"
            ? [VERSION_CANDIDATE, VERSION_LEGACY]
            : current === "topology"
              ? [VERSION_TOPOLOGY, VERSION_CANDIDATE, VERSION_LEGACY]
              : current === "token"
                ? [VERSION_TOKEN, VERSION_TOPOLOGY, VERSION_CANDIDATE, VERSION_LEGACY]
                : [
                    VERSION_TOKEN_RESTORED,
                    VERSION_TOKEN,
                    VERSION_TOPOLOGY,
                    VERSION_CANDIDATE,
                    VERSION_LEGACY,
                  ];
      return chain.map((id, index) =>
        deployment(`deployment-${index}`, id, `2026-08-29T0${5 - index}:00:00Z`),
      );
    },
    async workerVersion(_worker, versionId) {
      const serviceBinding =
        versionId === VERSION_LEGACY || versionId === VERSION_CANDIDATE
          ? { service: SERVICE, entrypoint: ENTRYPOINT }
          : undefined;
      const includesHostedSecret = versionId !== VERSION_TOKEN;
      return versionShape({
        ...(serviceBinding === undefined ? {} : { serviceBinding }),
        includeHostedSecret: includesHostedSecret,
        message: versionId === VERSION_LEGACY ? null : `takoserver-worker:${COMMIT}:${DIGEST}`,
      });
    },
    async workerSecrets() {
      return (current === "token" ? BASE_SECRETS : HOSTED_SECRETS).map((name) => ({
        name,
        type: "secret_text",
      }));
    },
  };
  return { run, state, mutations, buildConfig };
}

function versionShape(input: {
  readonly serviceBinding?: { readonly service: string; readonly entrypoint: string };
  readonly includeHostedSecret?: boolean;
  readonly message?: string | null;
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
    resources: { bindings },
  };
}

function deployment(id: string, versionId: string, created: string) {
  return { id, created_on: created, versions: [{ version_id: versionId, percentage: 100 }] };
}

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}
