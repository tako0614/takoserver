import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deploymentVariables } from "../scripts/deploy/realized-config.ts";
import { loadTarget } from "../scripts/deploy/target.ts";

const BASE = {
  accountId: "a10162d23653f1ad1193dabf520a5dd0",
  workerName: "takoserver-api",
  d1: {
    databaseName: "takoserver-runtime",
    databaseId: "85c5a15d-a80f-42fe-a907-7ec0d86e008e",
  },
  r2: { bucketName: "takoserver-objects" },
  publicOrigin: "https://api.takoserver.com",
  grantKeyId: "takoserver-runtime-2026-08",
};

const MODEL = {
  id: "takoserver-text",
  upstreamId: "@cf/meta/llama-3.1-8b-instruct",
  created: 1_787_054_400,
  ownedBy: "takoserver",
  maxInputTokens: 24_000,
  maxOutputTokens: 4_096,
  inputMinorPerMillionTokens: 40,
  outputMinorPerMillionTokens: 300,
};

describe("private data service deploy configuration", () => {
  test("validates private prices and realizes no secret value", () => {
    const directory = mkdtempSync(join(tmpdir(), "takoserver-target-"));
    try {
      const path = join(directory, "target.json");
      writeFileSync(
        path,
        JSON.stringify({ ...BASE, aiModels: [MODEL], r2ParentAccessKeyId: "parent-key" }),
      );
      const target = loadTarget(path);
      const realized = deploymentVariables(target) as { vars: Record<string, string> };
      expect(JSON.parse(realized.vars.TAKOSERVER_AI_MODELS ?? "null")).toEqual([MODEL]);
      expect(realized.vars.CLOUDFLARE_ACCOUNT_ID).toBe(BASE.accountId);
      expect(realized.vars.TAKOSERVER_R2_PARENT_ACCESS_KEY_ID).toBe("parent-key");
      expect(JSON.stringify(realized)).not.toContain("TOKEN");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects malformed price configuration before a deploy can start", () => {
    const directory = mkdtempSync(join(tmpdir(), "takoserver-target-"));
    try {
      const path = join(directory, "target.json");
      writeFileSync(path, JSON.stringify({ ...BASE, aiModels: [{ ...MODEL, surprise: true }] }));
      expect(() => loadTarget(path)).toThrow("deploy target `aiModels` is invalid");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
