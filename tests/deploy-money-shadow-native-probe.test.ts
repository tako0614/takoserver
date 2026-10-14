import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertMoneyShadowProbeNativeRefence,
  type MoneyShadowNativeProbeDeclaration,
  readExactMoneyShadowProbeWorkerPresence,
  readMoneyShadowProbeNativeWorker,
  readMoneyShadowProbeWorkerStatus,
  runIntegrationMoneyShadowNativeProbe,
  terminalizeMoneyShadowProbeAfterNativeRefence,
} from "../scripts/deploy/integration-money-shadow-native-probe.ts";

const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const account = "1".repeat(32);
const databaseName = `takoserver-ms-${"2".repeat(32)}`;
const databaseId = "11111111-1111-4111-8111-111111111111";

function declaration(root: string): MoneyShadowNativeProbeDeclaration {
  const rehearsal = JSON.stringify({
    kind: "takoserver.integration-money-shadow-rehearsal@v1",
    environment: "integration",
    accountId: account,
    databaseName,
    databaseId,
    phase: "permit-success",
  });
  const rehearsalPath = join(root, "rehearsal.json");
  writeFileSync(rehearsalPath, rehearsal, { flag: "wx", mode: 0o600 });
  const custodyDirectory = join(root, "custody");
  mkdirSync(custodyDirectory, { mode: 0o700 });
  return {
    kind: "takoserver.integration-money-shadow-native-probe@v1",
    environment: "integration",
    accountId: account,
    databaseName,
    databaseId,
    rehearsalDeclarationPath: rehearsalPath,
    rehearsalDeclarationDigest: digest(rehearsal),
    rehearsalSourceCommit: "a".repeat(40),
    authPath: join(root, "auth.txt"),
    reviewPath: join(root, "review.json"),
    custodyDirectory,
    phase: "publish",
  };
}

function writeAuthGenesis(
  selected: MoneyShadowNativeProbeDeclaration,
  sourceCommit: string,
): string {
  const secretBytes = `${"a".repeat(64)}\n`;
  writeFileSync(selected.authPath, secretBytes, { flag: "wx", mode: 0o600 });
  const genesis = `${JSON.stringify({
    kind: "takoserver.money-shadow-native-auth-genesis@v1",
    accountId: selected.accountId,
    databaseName: selected.databaseName,
    databaseId: selected.databaseId,
    workerName: `${selected.databaseName}-probe`,
    sourceCommit,
    sourceRemoteRef: "origin/reviewed",
    rehearsalSourceCommit: selected.rehearsalSourceCommit,
    rehearsalDeclarationDigest: selected.rehearsalDeclarationDigest,
    authPath: selected.authPath,
    authDigest: digest(secretBytes),
    firstAbsence: "authenticated-exact-worker-get-404-code10007",
  })}\n`;
  writeFileSync(join(selected.custodyDirectory, "auth.genesis.json"), genesis, {
    flag: "wx",
    mode: 0o600,
  });
  return digest(genesis);
}

const oauthRun = async () => ({
  exitCode: 0,
  stdout: JSON.stringify({ type: "oauth", token: "test-oauth" }),
  stderr: "",
});

describe("shadow-only native Worker owner boundary", () => {
  test("only the exact selected account and fresh Worker name are sent to provider GET", async () => {
    const name = `${databaseName}-probe`;
    const expected = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${name}`;
    const requests: Request[] = [];
    const absent = async (request: Request) => {
      requests.push(request);
      return new Response(
        JSON.stringify({ success: false, result: null, errors: [{ code: 10007 }], messages: [] }),
        { status: 404 },
      );
    };
    expect(await readExactMoneyShadowProbeWorkerPresence(account, name, "test-oauth", absent)).toBe(
      false,
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(expected);
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.redirect).toBe("manual");
    for (const response of [
      new Response(JSON.stringify({ success: false, result: null, errors: [{ code: 10000 }] }), {
        status: 404,
      }),
      new Response("not found", { status: 404 }),
      new Response("error", { status: 401 }),
      new Response("", { status: 302, headers: { location: "https://elsewhere.invalid" } }),
    ]) {
      await expect(
        readExactMoneyShadowProbeWorkerPresence(account, name, "test-oauth", async () => response),
      ).rejects.toThrow();
    }
    expect(
      await readExactMoneyShadowProbeWorkerPresence(
        account,
        name,
        "test-oauth",
        async () => new Response("worker bytes", { status: 200 }),
      ),
    ).toBe(true);
  });

  test("authenticated Worker status is exact and rejects malformed or redirected readback", async () => {
    const value = {
      state: "absent" as const,
      bindingDigest: `sha256:${"a".repeat(64)}`,
      sourceCommit: "b".repeat(40),
      resultDigest: null,
      completeReadbackMatches: null,
      permitEmpty: true,
      writerEpochMatches: true,
    };
    const endpoint = "https://takoserver-ms-shadow-probe.example.workers.dev";
    const seen: Request[] = [];
    const valid = await readMoneyShadowProbeWorkerStatus(
      endpoint,
      "c".repeat(64),
      async (request) => {
        seen.push(request);
        return Response.json(value);
      },
    );
    expect(valid).toEqual(value);
    expect(seen[0]?.method).toBe("GET");
    expect(seen[0]?.url).toBe(`${endpoint}/status`);
    expect(seen[0]?.headers.get("authorization")).toBe(`Bearer ${"c".repeat(64)}`);
    await expect(
      readMoneyShadowProbeWorkerStatus(endpoint, "c".repeat(64), async () =>
        Response.json({ ...value, extra: true }),
      ),
    ).rejects.toThrow("foreign shape");
    await expect(
      readMoneyShadowProbeWorkerStatus(
        endpoint,
        "c".repeat(64),
        async () =>
          new Response("", { status: 302, headers: { location: "https://elsewhere.invalid" } }),
      ),
    ).rejects.toThrow("exact success");
    await expect(
      readMoneyShadowProbeWorkerStatus(
        endpoint,
        "c".repeat(64),
        async () => new Response("x".repeat(4097)),
      ),
    ).rejects.toThrow("exceeds bound");
  });

  test("production invocation and missing owner auth fail before any provider read", async () => {
    const root = mkdtempSync(join(tmpdir(), "money-native-owner-test-"));
    try {
      const selected = declaration(root);
      let providerReads = 0;
      const fetcher = async (_request: Request) => {
        providerReads += 1;
        throw new Error("provider read");
      };
      await expect(
        runIntegrationMoneyShadowNativeProbe(
          selected,
          {
            action: "status",
            environment: "production",
            commit: "d".repeat(40),
          } as never,
          { fetcher },
        ),
      ).rejects.toThrow("integration status/apply");
      await expect(
        runIntegrationMoneyShadowNativeProbe(
          selected,
          {
            action: "apply",
            environment: "integration",
            commit: "d".repeat(40),
          },
          { fetcher, run: oauthRun, cloudflareEnvironment: {} },
        ),
      ).rejects.toThrow("auth must originate from first publication status");
      expect(providerReads).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a retained probe dispatch cannot switch its selected owner identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "money-native-retained-test-"));
    try {
      const selected = { ...declaration(root), phase: "probe" as const };
      const authGenesisDigest = writeAuthGenesis(selected, "d".repeat(40));
      const binding = {
        kind: "takoserver.money-shadow-native-probe-binding@v1",
        phase: "probe",
        accountId: "3".repeat(32),
        databaseName,
        databaseId,
        workerName: `${databaseName}-probe`,
        sourceCommit: "d".repeat(40),
        rehearsalSourceCommit: selected.rehearsalSourceCommit,
        rehearsalDeclarationDigest: selected.rehearsalDeclarationDigest,
        rehearsalApplicationDigest: digest("application"),
        rehearsalFinancialDigest: digest("financial"),
        rehearsalShapeDigest: digest("shape"),
        writerEpoch: digest("writer"),
        revokedEpoch: digest("revoked"),
        authDigest: digest(`${"a".repeat(64)}\n`),
        authGenesisDigest,
        workerBindingDigest: digest("worker"),
        bundleDigest: digest("bundle"),
        configDigest: digest("config"),
        publicationTerminalDigest: digest("publication"),
        nativeVersionId: databaseId,
        nativeDeploymentId: databaseId,
        nativeStatusDigest: digest("status"),
      };
      writeFileSync(
        join(selected.custodyDirectory, "probe.dispatched.json"),
        JSON.stringify({
          kind: "takoserver.money-shadow-native-probe-dispatch@v1",
          binding,
          bindingDigest: digest(JSON.stringify(binding)),
          reviewDigest: digest("review"),
        }),
        { flag: "wx", mode: 0o600 },
      );
      let providerReads = 0;
      await expect(
        runIntegrationMoneyShadowNativeProbe(
          selected,
          { action: "status", environment: "integration", commit: "d".repeat(40) },
          {
            cloudflareEnvironment: {},
            run: oauthRun,
            fetcher: async () => {
              providerReads += 1;
              throw new Error("unexpected provider read");
            },
          },
        ),
      ).rejects.toThrow("changed owner authority");
      expect(providerReads).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a pre-existing shared-looking bearer without source genesis is refused", async () => {
    const root = mkdtempSync(join(tmpdir(), "money-native-shared-auth-test-"));
    try {
      const selected = declaration(root);
      writeFileSync(selected.authPath, `${"a".repeat(64)}\n`, { flag: "wx", mode: 0o600 });
      let providerReads = 0;
      await expect(
        runIntegrationMoneyShadowNativeProbe(
          selected,
          { action: "status", environment: "integration", commit: "d".repeat(40) },
          {
            run: oauthRun,
            cloudflareEnvironment: {},
            fetcher: async () => {
              providerReads += 1;
              throw new Error("unexpected provider read");
            },
          },
        ),
      ).rejects.toThrow("source-generated genesis receipt is missing");
      expect(providerReads).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("first status generates auth genesis only after exact absence and source qualification", async () => {
    const root = mkdtempSync(join(tmpdir(), "money-native-genesis-test-"));
    try {
      const selected = declaration(root);
      const commit = "d".repeat(40);
      const run = async (command: readonly string[]) => {
        const suffix = command.slice(-3).join(" ");
        const full = command.join(" ");
        const stdout =
          suffix === "auth token --json"
            ? JSON.stringify({ type: "oauth", token: "test-oauth" })
            : full === "git rev-parse HEAD"
              ? `${commit}\n`
              : full === "git branch --show-current"
                ? "probe-review\n"
                : full === "git branch -r --contains dddddddddddddddddddddddddddddddddddddddd"
                  ? "  origin/probe-review\n"
                  : "";
        return { exitCode: 0, stdout, stderr: "" };
      };
      const present = async () => new Response("worker exists", { status: 200 });
      await expect(
        runIntegrationMoneyShadowNativeProbe(
          selected,
          { action: "status", environment: "integration", commit },
          { run, cloudflareEnvironment: {}, fetcher: present },
        ),
      ).rejects.toThrow("already exists before auth genesis");
      expect(existsSync(selected.authPath)).toBe(false);
      const genesisPath = join(selected.custodyDirectory, "auth.genesis.json");
      expect(existsSync(genesisPath)).toBe(false);
      const absent = async () =>
        Response.json(
          { success: false, result: null, errors: [{ code: 10007 }], messages: [] },
          { status: 404 },
        );
      await expect(
        runIntegrationMoneyShadowNativeProbe(
          selected,
          { action: "status", environment: "integration", commit },
          { run, cloudflareEnvironment: {}, fetcher: absent },
        ),
      ).rejects.toThrow("terminal synthetic rehearsal native readback");
      expect(statSync(selected.authPath).mode & 0o777).toBe(0o600);
      expect(statSync(genesisPath).mode & 0o777).toBe(0o600);
      const genesis = JSON.parse(readFileSync(genesisPath, "utf8"));
      expect(genesis).toMatchObject({
        sourceCommit: commit,
        sourceRemoteRef: "origin/probe-review",
        accountId: account,
        databaseId,
        firstAbsence: "authenticated-exact-worker-get-404-code10007",
      });
      expect(genesis.authDigest).toBe(digest(readFileSync(selected.authPath, "utf8")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("provider and malformed binding canaries cannot escape native readback", async () => {
    const root = mkdtempSync(join(tmpdir(), "money-native-redaction-test-"));
    try {
      const selected = declaration(root);
      const canary = "SECRET_NATIVE_BINDING_CANARY";
      const versionId = "11111111-1111-4111-8111-111111111111";
      const deploymentId = "22222222-2222-4222-8222-222222222222";
      const bundle = "native-test-bundle";
      const bundleDigest = digest(bundle);
      const binding = {
        sourceCommit: "d".repeat(40),
        bundleDigest,
        writerEpoch: digest("writer"),
        revokedEpoch: digest("revoked"),
        workerBindingDigest: digest("worker"),
      };
      const history = [
        {
          id: deploymentId,
          created_on: "2026-10-14T00:00:00Z",
          versions: [{ version_id: versionId, percentage: 100 }],
        },
      ];
      const state = {
        workerDeployments: async () => history,
        workerVersion: async () => ({
          id: versionId,
          annotations: {
            "workers/message": `takoserver-worker:${binding.sourceCommit}:${bundleDigest.slice(7)}`,
          },
          resources: {
            bindings: [{ name: "MONEY_SHADOW_PROBE_AUTH", type: "plain_text", text: canary }],
          },
        }),
        workerVersionWithModules: async () => ({
          main_module: "worker.js",
          modules: [
            {
              name: "worker.js",
              content_type: "application/javascript+module",
              content_base64: Buffer.from(bundle).toString("base64"),
            },
          ],
        }),
      };
      try {
        await readMoneyShadowProbeNativeWorker(state as never, selected, binding as never);
        throw new Error("malformed binding was admitted");
      } catch (error) {
        expect(String(error)).toContain("native readback is unavailable or divergent");
        expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(canary);
      }
      await expect(
        readMoneyShadowProbeNativeWorker(
          {
            workerDeployments: async () => {
              throw new Error(canary);
            },
          } as never,
          selected,
          binding as never,
        ),
      ).rejects.toThrow("native readback is unavailable or divergent");
      await expect(
        readExactMoneyShadowProbeWorkerPresence(
          account,
          `${databaseName}-probe`,
          "test-oauth",
          async () => {
            throw new Error(canary);
          },
        ),
      ).rejects.toThrow("presence GET is unavailable");
      await expect(
        readMoneyShadowProbeWorkerStatus(
          "https://shadow.example.invalid",
          "a".repeat(64),
          async () => {
            throw new Error(canary);
          },
        ),
      ).rejects.toThrow("GET status is unavailable");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("terminal native re-fence rejects a changed Version, deployment or module", () => {
    const expected = {
      versionId: "11111111-1111-4111-8111-111111111111",
      deploymentId: "22222222-2222-4222-8222-222222222222",
      moduleDigest: digest("bundle"),
      endpoint: "https://shadow.example.invalid",
    };
    expect(() => assertMoneyShadowProbeNativeRefence(expected, expected)).not.toThrow();
    for (const changed of [
      { ...expected, versionId: "33333333-3333-4333-8333-333333333333" },
      { ...expected, deploymentId: "33333333-3333-4333-8333-333333333333" },
      { ...expected, moduleDigest: digest("other-bundle") },
      { ...expected, endpoint: "https://other.example.invalid" },
    ])
      expect(() => assertMoneyShadowProbeNativeRefence(expected, changed)).toThrow(
        "changed after probe status readback",
      );
  });

  test("probe terminal custody is never written when the post-status native re-fence drifts", async () => {
    const root = mkdtempSync(join(tmpdir(), "money-native-refence-test-"));
    try {
      const selected = declaration(root);
      const terminalPath = join(selected.custodyDirectory, "probe.terminal.json");
      const expectedNative = {
        versionId: databaseId,
        deploymentId: "22222222-2222-4222-8222-222222222222",
        moduleDigest: digest("bundle"),
        endpoint: "https://shadow.example.invalid",
      };
      const input = {
        terminalPath,
        declaration: selected,
        bindingDigest: digest("probe-binding"),
        expectedNative,
        resultDigest: digest("worker-result"),
      };
      await expect(
        terminalizeMoneyShadowProbeAfterNativeRefence({
          ...input,
          readNative: async () => ({
            ...expectedNative,
            deploymentId: "33333333-3333-4333-8333-333333333333",
          }),
        }),
      ).rejects.toThrow("changed after probe status readback");
      expect(existsSync(terminalPath)).toBe(false);
      await terminalizeMoneyShadowProbeAfterNativeRefence({
        ...input,
        readNative: async () => expectedNative,
      });
      expect(JSON.parse(readFileSync(terminalPath, "utf8"))).toMatchObject({
        phase: "probe",
        bindingDigest: input.bindingDigest,
        nativeResultDigest: input.resultDigest,
        versionId: expectedNative.versionId,
        deploymentId: expectedNative.deploymentId,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
