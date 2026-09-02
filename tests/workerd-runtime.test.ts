import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { chmod, mkdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkerdRuntime, type WorkerdBinding } from "../src/workerd-runtime.ts";

/**
 * The generated configuration is assembled by concatenating strings, and the
 * values in it belong to a tenant. These tests are about the two properties
 * that follow from that: a value can never end the literal it is written into,
 * and the file it lands in is readable only by the operator.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "takoserver-workerd-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const MODULES = new Map([["index.js", new TextEncoder().encode("export default {}")]]);

async function publish(vars?: readonly WorkerdBinding[]): Promise<string> {
  const runtime = createWorkerdRuntime({ root, isReady: () => true });
  await runtime.write(
    "site",
    {
      directory: "site",
      mainModule: "index.js",
      hostnames: ["site.localhost"],
      generation: "gen-1",
      ...(vars ? { vars } : {}),
    },
    MODULES,
  );
  await runtime.reload();
  return await readFile(join(root, "workers", "workerd.capnp"), "utf8");
}

test("renders text and json bindings the module can read", async () => {
  const config = await publish([
    { name: "LANE", value: "takoform-v1", kind: "text" },
    { name: "LIMITS", value: '{"retries":3}', kind: "json" },
  ]);
  expect(config).toContain('(name = "LANE", text = "takoform-v1")');
  expect(config).toContain('(name = "LIMITS", json = "{\\"retries\\":3}")');
});

test("a script that declares no binding renders exactly the bytes it always did", async () => {
  const without = await publish();
  const empty = await publish([]);
  expect(empty).toBe(without);
  // The script's own service block, as distinct from the router's, still names
  // no bindings at all.
  expect(without).toContain(
    'esModule = embed "site/index.js") ],\n      compatibilityDate = "2026-01-01",',
  );
});

test("escapes every character that could end the literal or the line", async () => {
  const value = 'quote " backslash \\ newline\n tab\t bell\x07 unit\x1f delete\x7f é 😀';
  const config = await publish([{ name: "AWKWARD", value, kind: "text" }]);
  const rendered = /\(name = "AWKWARD", text = ("(?:[^"\\]|\\.)*")\)/u.exec(config)?.[1];
  expect(rendered).toBe(
    '"quote \\" backslash \\\\ newline\\n tab\\t bell\\x07 unit\\x1f delete\\x7f é 😀"',
  );
  // Nothing after the value leaked out of its literal: the script's binding
  // list still closes where it should, and the router's list is untouched.
  expect(config).toContain(`bindings = [ (name = "AWKWARD", text = ${rendered}) ],`);
});

test("refuses a binding name it would otherwise have to mangle", async () => {
  for (const name of ["", "1LEADING", "has space", "has$dollar", "a".repeat(129)]) {
    await expect(publish([{ name, value: "x", kind: "text" }])).rejects.toThrow(
      "unusable worker binding",
    );
  }
});

test("refuses a duplicate binding name rather than letting one win silently", async () => {
  await expect(
    publish([
      { name: "SAME", value: "first", kind: "text" },
      { name: "SAME", value: "second", kind: "text" },
    ]),
  ).rejects.toThrow("unusable worker binding");
});

test("refuses a value capnp text cannot carry", async () => {
  await expect(publish([{ name: "NUL", value: "a\u0000b", kind: "text" }])).rejects.toThrow(
    "unusable worker binding value",
  );
  await expect(publish([{ name: "LONE", value: "a\ud800", kind: "text" }])).rejects.toThrow(
    "unusable worker binding value",
  );
});

test("writes the configuration and the manifest so only the operator can read them", async () => {
  await publish([{ name: "SECRET_SHAPED", value: "value", kind: "text" }]);
  const config = await stat(join(root, "workers", "workerd.capnp"));
  const manifest = await stat(join(root, "workers", "site", "takoserver-site.json"));
  const directory = await stat(join(root, "workers", "site"));
  expect(config.mode & 0o777).toBe(0o600);
  expect(manifest.mode & 0o777).toBe(0o600);
  expect(directory.mode & 0o777).toBe(0o700);
});

test("skips a published script whose recorded bindings cannot be rendered", async () => {
  const runtime = createWorkerdRuntime({ root, isReady: () => true });
  await runtime.write(
    "good",
    { directory: "good", mainModule: "index.js", hostnames: ["good.localhost"] },
    MODULES,
  );
  await runtime.write(
    "broken",
    { directory: "broken", mainModule: "index.js", hostnames: ["broken.localhost"] },
    MODULES,
  );
  await Bun.write(
    join(root, "workers", "broken", "takoserver-site.json"),
    JSON.stringify({
      mainModule: "index.js",
      hostnames: ["broken.localhost"],
      vars: [{ name: "not a name", value: "x", kind: "text" }],
    }),
  );
  await runtime.reload();
  const config = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
  expect(config).toContain('name = "good"');
  expect(config).not.toContain('name = "broken"');
});

test("skips a published script whose recorded binding value cannot be rendered", async () => {
  const runtime = createWorkerdRuntime({ root, isReady: () => true });
  await runtime.write(
    "good",
    { directory: "good", mainModule: "index.js", hostnames: ["good.localhost"] },
    MODULES,
  );
  await runtime.write(
    "broken",
    { directory: "broken", mainModule: "index.js", hostnames: ["broken.localhost"] },
    MODULES,
  );
  // The name is valid, so the earlier guard passes; only rendering the value
  // refuses. On disk this is a torn write or a tampered manifest, which the
  // write path itself can never produce.
  await Bun.write(
    join(root, "workers", "broken", "takoserver-site.json"),
    JSON.stringify({
      mainModule: "index.js",
      hostnames: ["broken.localhost"],
      vars: [{ name: "TORN", value: "a\u0000b", kind: "text" }],
    }),
  );
  await runtime.reload();
  const config = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
  expect(config).toContain('name = "good"');
  expect(config).not.toContain('name = "broken"');
});

test("tightens a scripts tree an older tree left group- or world-readable", async () => {
  // `mkdir(mode)` is a no-op on a directory that already exists, so an upgraded
  // deployment kept whatever `workers/` and its script directories were made
  // with. The rendered config and every manifest under them carry binding
  // values, so publishing repairs the mode rather than inheriting it.
  await mkdir(join(root, "workers", "site"), { recursive: true, mode: 0o755 });
  await chmod(join(root, "workers", "site"), 0o777);
  await chmod(join(root, "workers"), 0o755);

  await publish([{ name: "SECRET_SHAPED", value: "value", kind: "text" }]);

  expect((await stat(join(root, "workers"))).mode & 0o777).toBe(0o700);
  expect((await stat(join(root, "workers", "site"))).mode & 0o777).toBe(0o700);
});

/**
 * A restarted self-host brings its own Workers back.
 *
 * `workerd` was started by a publication and by nothing else, so a machine that
 * restarted served nothing at all — while its control plane reported healthy
 * and `tofu plan` answered "No changes. Your infrastructure matches the
 * configuration". Every resource was observed Ready and no request could reach
 * any Worker; a read or a refresh did not revive it, only a fresh publication
 * did. So the boot asks the durable manifests what this machine had published
 * and renders the configuration again for them.
 */
test("restores the runtime from what a previous process published", async () => {
  const published = createWorkerdRuntime({ root, isReady: () => true });
  await published.write(
    "site",
    {
      directory: "site",
      mainModule: "index.js",
      hostnames: ["site.localhost"],
      generation: "gen-1",
    },
    MODULES,
  );
  await published.reload();
  const before = await readFile(join(root, "workers", "workerd.capnp"), "utf8");

  // The next process: a new runtime over the same data directory, told nothing.
  const reloaded: string[] = [];
  const restarted = createWorkerdRuntime({
    root,
    isReady: () => true,
    onReload: async (configPath) => {
      reloaded.push(configPath);
    },
  });
  expect(await restarted.restore()).toEqual(["site"]);
  // The runtime was actually started, against the configuration this build
  // renders rather than whichever one happened to be on disk.
  expect(reloaded).toEqual([join(root, "workers", "workerd.capnp")]);
  expect(await readFile(join(root, "workers", "workerd.capnp"), "utf8")).toBe(before);
  expect(await restarted.has("site", "gen-1")).toBe(true);
});

test("starts nothing on a machine that has published no Worker", async () => {
  const reloaded: string[] = [];
  const runtime = createWorkerdRuntime({
    root,
    isReady: () => true,
    onReload: async (configPath) => {
      reloaded.push(configPath);
    },
  });
  expect(await runtime.restore()).toEqual([]);
  // No configuration, and above all no runtime: a machine that never runs a
  // Worker must not be given a workerd to run one in.
  expect(reloaded).toEqual([]);
  await expect(readFile(join(root, "workers", "workerd.capnp"), "utf8")).rejects.toThrow();
});
