import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  assertBuiltAuth103ModuleClosure,
  assertExactOriginalModuleBytes,
  assertOriginalDependencyReplayUnchanged,
  isolatedAuth103OriginalBuildEnvironment,
  originalAuth103ModuleMode,
} from "../scripts/deploy/auth103-original-worker-modules.ts";
import { DeployError } from "../scripts/deploy/errors.ts";

const original = {
  worker: Buffer.from("export default { fetch() { return new Response('closed') } };\n"),
  sql: Buffer.from("INSERT INTO auth103_native_deployments VALUES ('original');\n"),
};
const digest = createHash("sha256").update(original.worker).digest("hex");
const module = (name: string, contentType: string, bytes: Uint8Array) => ({
  name,
  content_type: contentType,
  content_base64: Buffer.from(bytes).toString("base64"),
});
const version = () => ({
  main_module: "worker.js",
  modules: [
    module("auth103-source-install.sql", "text/plain", original.sql),
    module("worker.js", "application/javascript+module", original.worker),
  ],
});

describe("original Auth103 Worker module byte closure", () => {
  test("original builder child receives only the finite local build environment", () => {
    const source = {
      ...process.env,
      PATH: "/test-bin",
      CF_API_TOKEN: "test-credential-must-not-pass",
      AUTH103_TEST_WORKER_BINDING: "test-binding-must-not-pass",
    };
    const child = isolatedAuth103OriginalBuildEnvironment(source, "/private-build");
    expect(Object.keys(child).sort()).toEqual(["CI", "HOME", "NO_COLOR", "PATH", "TMPDIR"]);
    expect(child).toEqual({
      PATH: "/test-bin",
      TMPDIR: "/private-build",
      HOME: "/private-build",
      CI: "1",
      NO_COLOR: "1",
    });
    expect(source.CF_API_TOKEN).toBe("test-credential-must-not-pass");
  });

  test("original release config determines module mode before provider inventory", () => {
    expect(originalAuth103ModuleMode({ main: "worker.js" })).toBe("historical-two-module");
    expect(originalAuth103ModuleMode({ main: "worker.js", find_additional_modules: false })).toBe(
      "future-single-module",
    );
    for (const config of [
      { find_additional_modules: true },
      { find_additional_modules: undefined },
      { find_additional_modules: "false" },
    ]) {
      expect(() => originalAuth103ModuleMode(config)).toThrow(DeployError);
    }
  });

  test("original replay refuses selected or current dependency identity and content drift", () => {
    const selected = { contentDigest: "same", identityDigest: "selected", files: 2 };
    const current = { contentDigest: "same", identityDigest: "current", files: 2 };
    const before = { selected, current };
    expect(() => assertOriginalDependencyReplayUnchanged(before, before)).not.toThrow();
    for (const after of [
      { selected: { ...selected, identityDigest: "changed" }, current },
      { selected: { ...selected, contentDigest: "changed" }, current },
      { selected, current: { ...current, identityDigest: "changed" } },
      { selected, current: { ...current, contentDigest: "changed" } },
    ]) {
      expect(() => assertOriginalDependencyReplayUnchanged(before, after)).toThrow(DeployError);
    }
  });

  test("source-built module mode refuses an omitted historical SQL module and foreign future SQL", () => {
    const historicalWithoutSql = { ...version(), modules: [version().modules[1]] };
    expect(() =>
      assertBuiltAuth103ModuleClosure(
        "preflight",
        historicalWithoutSql,
        { ...original, mode: "historical-two-module" },
        digest,
      ),
    ).toThrow(DeployError);
    expect(() =>
      assertBuiltAuth103ModuleClosure(
        "preflight",
        version(),
        { ...original, mode: "future-single-module" },
        digest,
      ),
    ).toThrow(DeployError);
    expect(
      assertBuiltAuth103ModuleClosure(
        "preflight",
        historicalWithoutSql,
        { ...original, mode: "future-single-module" },
        digest,
      ),
    ).toBe(digest);
  });
  test("requires both original modules and the independent main annotation", () => {
    expect(assertExactOriginalModuleBytes("preflight", version(), original, digest)).toBe(digest);
    expect(() =>
      assertExactOriginalModuleBytes("preflight", version(), original, "a".repeat(64)),
    ).toThrow("bundle annotation");
  });

  test("refuses missing, duplicate, extra and foreign modules", () => {
    const source = version();
    for (const modules of [
      source.modules.slice(1),
      [source.modules[0], source.modules[0]],
      [...source.modules, module("other.sql", "text/plain", original.sql)],
      [module("other.sql", "text/plain", original.sql), source.modules[1]],
    ]) {
      expect(() =>
        assertExactOriginalModuleBytes("preflight", { ...source, modules }, original, digest),
      ).toThrow(DeployError);
    }
  });

  test("refuses changed SQL or Worker bytes, types, fields and noncanonical base64", () => {
    const source = version();
    for (const malformed of [
      module("auth103-source-install.sql", "text/plain", Buffer.from("changed SQL")),
      { ...source.modules[0], content_type: "application/javascript+module" },
      { ...source.modules[0], extra: true },
      { ...source.modules[0], content_base64: "YQ=" },
    ]) {
      expect(() =>
        assertExactOriginalModuleBytes(
          "preflight",
          { ...source, modules: [malformed, source.modules[1]] },
          original,
          digest,
        ),
      ).toThrow(DeployError);
    }
    expect(() =>
      assertExactOriginalModuleBytes(
        "verification",
        {
          ...source,
          modules: [
            source.modules[0],
            module("worker.js", "application/javascript+module", Buffer.from("changed Worker")),
          ],
        },
        original,
        digest,
      ),
    ).toThrow(DeployError);
  });

  test("refuses a changed main-module declaration and resources projection", () => {
    const source = version();
    for (const changed of [
      { ...source, main_module: "auth103-source-install.sql" },
      { ...source, resources: {} },
    ]) {
      expect(() => assertExactOriginalModuleBytes("preflight", changed, original, digest)).toThrow(
        DeployError,
      );
    }
  });
});
