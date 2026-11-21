import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSelfhostBunHost } from "../src/entry-bun.ts";
import type { SelfhostLinuxContainerNodeSelectionSource } from "../src/selfhost-linux-container-node-selection.ts";

const acceptsProgrammaticSelection = (
  selection: SelfhostLinuxContainerNodeSelectionSource,
): ReturnType<typeof startSelfhostBunHost> =>
  startSelfhostBunHost({ linuxContainerSelection: selection });
const startsWithDisabledDefault = (): ReturnType<typeof startSelfhostBunHost> =>
  startSelfhostBunHost();

async function runIsolated(code: string) {
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", code], {
    cwd: join(import.meta.dir, ".."),
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/root",
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 10_000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timeout);
  }
}

test("Bun Host entry import is inert and accepts typed operator selection", async () => {
  expect(typeof startSelfhostBunHost).toBe("function");
  expect(typeof acceptsProgrammaticSelection).toBe("function");
  expect(typeof startsWithDisabledDefault).toBe("function");
  const source = await Bun.file(new URL("../src/entry-bun.ts", import.meta.url)).text();
  expect(source).toContain("if (import.meta.main) {\n  await startSelfhostBunHost();\n}");
});

test("explicit selection without seal keys rejects before state and consumes the one-shot start", async () => {
  const dataRoot = join(tmpdir(), `selfhost-preflight-${crypto.randomUUID()}`);
  const entryUrl = new URL("../src/entry-bun.ts", import.meta.url).href;
  const result = await runIsolated(`
    import { existsSync, rmSync } from "node:fs";
    const entryUrl = new URL(${JSON.stringify(entryUrl)});
    const original = await import(entryUrl.href);
    const source = await Bun.file(entryUrl).text();
    const rebased = source.replace(
      /((?:from|import)\\s*["'])(\\.\\.?\\/[^"']+)(["'])/gu,
      (_, prefix, specifier, suffix) => prefix + new URL(specifier, entryUrl).href + suffix,
    );
    const transpiled = new Bun.Transpiler({ loader: "ts" }).transformSync(rebased);
    const duplicate = await import(
      "data:text/javascript;base64," + Buffer.from(transpiled).toString("base64")
    );
    if (original.startSelfhostBunHost === duplicate.startSelfhostBunHost) {
      throw new Error("entry alias did not produce a second module copy");
    }
    process.env.TAKOSERVER_PUBLIC_ORIGIN = "https://operator.invalid";
    process.env.TAKOSERVER_DATA_ROOT = ${JSON.stringify(dataRoot)};
    process.env.TAKOSERVER_DB = ${JSON.stringify(join(dataRoot, "control.sqlite"))};
    process.env.TAKOSERVER_TAKOFORM_V2_CONFIG = JSON.stringify({
      documentation: "https://docs.example.invalid/takoform-v2",
      authenticationDocumentation: "https://docs.example.invalid/takoform-v2/authentication",
    });
    process.env.TAKOSERVER_TAKOFORM_V2_CURSOR_KEY = "A".repeat(43);
    delete process.env.TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING;
    const selection = { kind: "oci", selection: {} };
    const failure = async (entry, options) => {
      try { await entry.startSelfhostBunHost(options); return "unexpected-success"; }
      catch (cause) { return cause instanceof Error ? cause.message : "unknown"; }
    };
    const first = await failure(original, { linuxContainerSelection: selection });
    const second = await failure(duplicate, { linuxContainerSelection: selection });
    const stateCreated = existsSync(${JSON.stringify(dataRoot)});
    if (stateCreated) rmSync(${JSON.stringify(dataRoot)}, { recursive: true, force: true });
    if (stateCreated) throw new Error("preflight created the data root");
    console.log(JSON.stringify({ first, second }));
  `);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain(
    JSON.stringify({
      first: "Linux Container operator selection requires runtime input seal keys",
      second: "selfhost_bun_host_already_started",
    }),
  );
  expect(result.stderr).toBe("");
});

test("failure after process resources begin is process-fatal", async () => {
  const entryUrl = new URL("../src/entry-bun.ts", import.meta.url).href;
  const dataRoot = `/proc/selfhost-startup-${crypto.randomUUID()}`;
  const result = await runIsolated(`
    import { startSelfhostBunHost } from ${JSON.stringify(entryUrl)};
    process.env.TAKOSERVER_PUBLIC_ORIGIN = "https://operator.invalid";
    process.env.TAKOSERVER_DATA_ROOT = ${JSON.stringify(dataRoot)};
    process.env.TAKOSERVER_DB = ${JSON.stringify(join(dataRoot, "control.sqlite"))};
    process.env.TAKOSERVER_TAKOFORM_V2_CONFIG = JSON.stringify({
      documentation: "https://docs.example.invalid/takoform-v2",
      authenticationDocumentation: "https://docs.example.invalid/takoform-v2/authentication",
    });
    process.env.TAKOSERVER_TAKOFORM_V2_CURSOR_KEY = "A".repeat(43);
    try {
      await startSelfhostBunHost();
      console.log("unexpected-success");
    } catch {
      console.log("startup-rejection-was-catchable");
    }
  `);
  expect(result.exitCode).toBe(1);
  expect(result.stdout).not.toContain("unexpected-success");
  expect(result.stdout).not.toContain("startup-rejection-was-catchable");
  expect(result.stderr).toContain(
    "self-host Bun startup failed after process resources opened; exiting",
  );
});

test("a failed fatal diagnostic still prevents a catchable late startup rejection", async () => {
  const entryUrl = new URL("../src/entry-bun.ts", import.meta.url).href;
  const dataRoot = `/proc/selfhost-startup-diagnostic-${crypto.randomUUID()}`;
  const result = await runIsolated(`
    import { startSelfhostBunHost } from ${JSON.stringify(entryUrl)};
    process.env.TAKOSERVER_PUBLIC_ORIGIN = "https://operator.invalid";
    process.env.TAKOSERVER_DATA_ROOT = ${JSON.stringify(dataRoot)};
    process.env.TAKOSERVER_DB = ${JSON.stringify(join(dataRoot, "control.sqlite"))};
    process.env.TAKOSERVER_TAKOFORM_V2_CONFIG = JSON.stringify({
      documentation: "https://docs.example.invalid/takoform-v2",
      authenticationDocumentation: "https://docs.example.invalid/takoform-v2/authentication",
    });
    process.env.TAKOSERVER_TAKOFORM_V2_CURSOR_KEY = "A".repeat(43);
    process.stderr.write = () => { throw new Error("synthetic stderr failure"); };
    try {
      await startSelfhostBunHost();
      console.log("unexpected-success");
    } catch {
      console.log("catchable-late-startup-rejection");
    }
  `);
  expect(result.exitCode).toBe(1);
  expect(result.stdout).not.toContain("unexpected-success");
  expect(result.stdout).not.toContain("catchable-late-startup-rejection");
});
