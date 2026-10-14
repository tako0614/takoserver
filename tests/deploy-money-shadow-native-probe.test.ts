import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type MoneyShadowNativeProbeDeclaration,
  readExactMoneyShadowProbeWorkerPresence,
  readMoneyShadowProbeWorkerStatus,
  runIntegrationMoneyShadowNativeProbe,
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
          { fetcher },
        ),
      ).rejects.toThrow("auth file must be generated");
      expect(providerReads).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a retained probe dispatch cannot switch its selected owner identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "money-native-retained-test-"));
    try {
      const selected = { ...declaration(root), phase: "probe" as const };
      writeFileSync(selected.authPath, `${"a".repeat(64)}\n`, { flag: "wx", mode: 0o600 });
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
            run: async () => ({
              exitCode: 0,
              stdout: JSON.stringify({ type: "oauth", token: "test-oauth" }),
              stderr: "",
            }),
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
});
