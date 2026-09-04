import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

describe("exact artifact recovery owner storage boundary", () => {
  test("does not expose a REST adapter that claims atomic D1 batch semantics", () => {
    expect(
      existsSync(new URL("../scripts/deploy/exact-artifact-recovery-owner.ts", import.meta.url)),
    ).toBe(false);
    const deploySource = readFileSync(
      new URL("../scripts/deploy/exact-artifact-recovery.ts", import.meta.url),
      "utf8",
    );
    expect(deploySource).not.toContain("createCloudflareExactArtifactRecoverySql");
    expect(deploySource).not.toContain("purgeExactArtifactRecoveryDetails(");

    const schemaSource = readFileSync(
      new URL("../scripts/deploy/schema.ts", import.meta.url),
      "utf8",
    );
    expect(schemaSource).not.toContain("RUNTIME_INPUT_QUIESCENCE_BATCH_SQL");
    expect(schemaSource).not.toContain("takoserver_0037_runtime_input_zero_guard");
    expect(schemaSource).toContain("CREATE TRIGGER IF NOT EXISTS");

    const deployDocs = readFileSync(new URL("../docs/deploy.md", import.meta.url), "utf8");
    expect(deployDocs).not.toContain("semicolon-joined statements execute as a");
    expect(deployDocs).toContain(
      "does not claim that the REST query\n  endpoint provides `D1Database.batch()` rollback semantics",
    );
  });
});
