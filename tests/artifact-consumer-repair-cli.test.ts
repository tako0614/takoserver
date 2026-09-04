import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  readOwnerSessionFile,
  runArtifactConsumerRepairCli,
} from "../scripts/artifact-consumer-repair.ts";
import {
  ARTIFACT_CONSUMER_REPAIR_APPLY_FORMAT,
  ARTIFACT_CONSUMER_REPAIR_STATUS_FORMAT,
  ARTIFACT_CONSUMER_RESOLUTION_RECEIPT_FORMAT,
} from "../src/artifact-consumer-repair.ts";

const PLAN = `sha256:${"a".repeat(64)}` as const;

describe("artifact-consumer repair operator client", () => {
  test("reads an exact owner session only from a canonical owned 0600 file", () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-artifact-repair-session-"));
    const path = join(root, "owner-session");
    try {
      writeFileSync(path, "owner-session-token", { mode: 0o600 });
      expect(readOwnerSessionFile(path)).toBe("owner-session-token");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects unsafe owner-session files without reflecting their path or bytes", () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-artifact-repair-session-"));
    const secret = "owner-session-token-do-not-reflect";
    const unsafe: string[] = [];
    try {
      const permissive = join(root, "permissive");
      writeFileSync(permissive, secret, { mode: 0o600 });
      chmodSync(permissive, 0o640);
      unsafe.push(permissive);

      const normalized = join(root, "normalized");
      writeFileSync(normalized, `${secret}\n`, { mode: 0o600 });
      unsafe.push(normalized);

      const empty = join(root, "empty");
      writeFileSync(empty, "", { mode: 0o600 });
      unsafe.push(empty);

      const oversized = join(root, "oversized");
      writeFileSync(oversized, "x".repeat(513), { mode: 0o600 });
      unsafe.push(oversized);

      const linked = join(root, "linked");
      writeFileSync(linked, secret, { mode: 0o600 });
      linkSync(linked, join(root, "hardlink"));
      unsafe.push(linked);

      const target = join(root, "target");
      writeFileSync(target, secret, { mode: 0o600 });
      const symbolic = join(root, "symbolic");
      symlinkSync(target, symbolic);
      unsafe.push(symbolic);

      const actualParent = join(root, "actual");
      mkdirSync(actualParent, { mode: 0o700 });
      const ancestorTarget = join(actualParent, "session");
      writeFileSync(ancestorTarget, secret, { mode: 0o600 });
      const linkedParent = join(root, "linked-parent");
      symlinkSync(actualParent, linkedParent, "dir");
      unsafe.push(join(linkedParent, "session"));

      const canonical = join(root, "canonical");
      writeFileSync(canonical, secret, { mode: 0o600 });
      unsafe.push(`${actualParent}/../${basename(canonical)}`);

      for (const path of unsafe) {
        let message = "";
        try {
          readOwnerSessionFile(path);
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        expect(message).toContain("TAKOSERVER_OWNER_SESSION_FILE");
        expect(message).not.toContain(root);
        expect(message).not.toContain(secret);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("apply reads status and sends only the server-derived plan digest", async () => {
    const requests: Request[] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const responses = [
      Response.json({
        repair: {
          kind: ARTIFACT_CONSUMER_REPAIR_STATUS_FORMAT,
          deploymentId: "dep_cli",
          state: "actionable",
          planDigest: PLAN,
          uncertaintyFence: 1,
          candidateManifestCount: 4,
          path: "retained-historical",
          action: "verify-artifact-consumption",
        },
      }),
      Response.json({
        receipt: {
          kind: ARTIFACT_CONSUMER_RESOLUTION_RECEIPT_FORMAT,
          receiptId: "acr_cli",
          deploymentId: "dep_cli",
          uncertaintyFence: 1,
          planDigest: PLAN,
          resolution: "terminalized_absent",
          createdAt: "2026-09-03T20:00:00.000Z",
        },
      }),
    ];
    const exitCode = await runArtifactConsumerRepairCli(
      ["apply", "https://api.takoserver.test", "org_cli", "dep_cli", "repair:cli:0001"],
      {
        async fetch(input, init) {
          requests.push(new Request(input, init));
          const response = responses.shift();
          if (!response) throw new Error("unexpected request");
          return response;
        },
        stdout: (value) => stdout.push(value),
        stderr: (value) => stderr.push(value),
        token: () => "owner-session-token",
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(requests.map((request) => request.method)).toEqual(["GET", "POST"]);
    expect(requests.map((request) => request.headers.get("authorization"))).toEqual([
      "Bearer owner-session-token",
      "Bearer owner-session-token",
    ]);
    expect(requests[1]?.headers.get("idempotency-key")).toBe("repair:cli:0001");
    expect(await requests[1]?.json()).toEqual({
      kind: ARTIFACT_CONSUMER_REPAIR_APPLY_FORMAT,
      planDigest: PLAN,
    });
    expect(stdout.join("")).toContain('"resolution": "terminalized_absent"');
  });

  test("there is no command-line slot for caller claims or a caller plan digest", async () => {
    let called = false;
    const stderr: string[] = [];
    const code = await runArtifactConsumerRepairCli(
      [
        "apply",
        "https://api.takoserver.test",
        "org_cli",
        "dep_cli",
        "repair:cli:0002",
        "--outcome=absent",
      ],
      {
        async fetch() {
          called = true;
          return new Response();
        },
        stdout() {},
        stderr: (value) => stderr.push(value),
        token: () => "owner-session-token",
      },
    );

    expect(code).toBe(2);
    expect(called).toBe(false);
    expect(stderr.join("")).toContain("usage:");
  });

  test("rejects a remote plain-HTTP origin before reading credentials or fetching", async () => {
    let tokenCalls = 0;
    let fetchCalls = 0;
    const stderr: string[] = [];
    const code = await runArtifactConsumerRepairCli(
      ["status", "http://api.takoserver.test", "org_cli", "dep_cli"],
      {
        async fetch() {
          fetchCalls += 1;
          return new Response();
        },
        stdout() {},
        stderr: (value) => stderr.push(value),
        token() {
          tokenCalls += 1;
          return "owner-session-token";
        },
      },
    );

    expect(code).toBe(2);
    expect(tokenCalls).toBe(0);
    expect(fetchCalls).toBe(0);
    expect(stderr.join("")).toContain("HTTPS");
  });

  test("allows plain HTTP only for explicit loopback origins", async () => {
    for (const origin of ["http://localhost:8787", "http://127.0.0.1:8787"]) {
      const requests: Request[] = [];
      const stderr: string[] = [];
      const code = await runArtifactConsumerRepairCli(["status", origin, "org_cli", "dep_cli"], {
        async fetch(input, init) {
          requests.push(new Request(input, init));
          return Response.json({
            repair: {
              kind: ARTIFACT_CONSUMER_REPAIR_STATUS_FORMAT,
              deploymentId: "dep_cli",
              state: "blocked",
              blocker: "provider_readback_required",
              planDigest: PLAN,
              uncertaintyFence: 1,
              candidateManifestCount: 4,
            },
          });
        },
        stdout() {},
        stderr: (value) => stderr.push(value),
        token: () => "owner-session-token",
      });

      expect(code).toBe(0);
      expect(stderr).toEqual([]);
      expect(requests.map((request) => new URL(request.url).origin)).toEqual([origin]);
    }
  });
});
