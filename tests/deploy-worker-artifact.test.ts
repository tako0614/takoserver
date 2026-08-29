import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../scripts/deploy/process.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import {
  canonicalizeWorkerBundleSource,
  prepareWorkerArtifact,
} from "../scripts/deploy/worker-artifact.ts";

const COMMIT = "a".repeat(40);
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
} satisfies DeployTarget;

async function build(root: string) {
  const prepared = await prepareWorkerArtifact({
    root,
    target,
    commit: COMMIT,
    run: runCommand,
  });
  const bytes = readFileSync(prepared.bundlePath);
  const source = bytes.toString("utf8");
  return {
    bytes,
    digest: createHash("sha256").update(bytes).digest("hex"),
    sourceLabels: source.split("\n").filter((line) => line.startsWith("// ")),
  };
}

describe("hermetic Worker bundle identity", () => {
  test("uses identical bytes and digest across shallow and nested real Wrangler builds", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-worker-artifact-"));
    try {
      const shallow = await build(join(root, "shallow"));
      const nested = await build(join(root, "nested", "public-worker-proof"));

      expect({
        shallowDigest: shallow.digest,
        nestedDigest: nested.digest,
        shallowSourceLabels: shallow.sourceLabels,
        nestedSourceLabels: nested.sourceLabels,
      }).toEqual({
        shallowDigest: nested.digest,
        nestedDigest: nested.digest,
        shallowSourceLabels: nested.sourceLabels,
        nestedSourceLabels: nested.sourceLabels,
      });
      expect(shallow.bytes).toEqual(nested.bytes);
      expect(shallow.sourceLabels[0]).toBe("// src/entry-cloudflare-worker.ts");
      expect(shallow.sourceLabels.every((label) => !label.includes(root))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("preserves comments that are not repository source labels", () => {
    const source = ["// external explanatory comment", "export default {};", ""].join("\n");
    expect(canonicalizeWorkerBundleSource(source, "/tmp/build/index.js")).toBe(source);
  });
});
