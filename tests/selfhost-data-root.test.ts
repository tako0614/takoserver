import { expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSelfhostDataRoot } from "../src/selfhost-data-root.ts";

async function withTemporary(run: (root: string) => Promise<void>): Promise<void> {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "data-root-")));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("the documented relative default resolves against the working directory", async () => {
  await withTemporary(async (root) => {
    expect(resolveSelfhostDataRoot(undefined, root)).toBe(join(root, ".takoserver"));
    expect(resolveSelfhostDataRoot("state/../data", root)).toBe(join(root, "data"));
    expect(resolveSelfhostDataRoot(join(root, "absolute"), "/")).toBe(join(root, "absolute"));
    // Resolution names a location; it creates nothing.
    expect(existsSync(join(root, ".takoserver"))).toBe(false);
  });
});

test("memory control state passes through and unusable values are refused by name", () => {
  expect(resolveSelfhostDataRoot(":memory:", "/")).toBe(":memory:");
  for (const value of ["", "   ", "a\u0000b"]) {
    expect(() => resolveSelfhostDataRoot(value, "/")).toThrow(
      /^TAKOSERVER_DATA_ROOT must name a directory/u,
    );
  }
});

test("a symlinked existing prefix is canonicalized and the missing tail kept", async () => {
  await withTemporary(async (root) => {
    const real = join(root, "volume", "takoserver");
    await mkdir(real, { recursive: true });
    await symlink(real, join(root, "link"));
    expect(resolveSelfhostDataRoot(join(root, "link"), "/")).toBe(real);
    expect(resolveSelfhostDataRoot("link/not/yet", root)).toBe(join(real, "not", "yet"));
  });
});

test("a dangling symlink or a file component is refused instead of carried forward", async () => {
  await withTemporary(async (root) => {
    await symlink(join(root, "missing-target"), join(root, "dangling"));
    expect(() => resolveSelfhostDataRoot(join(root, "dangling", "data"), "/")).toThrow(
      `TAKOSERVER_DATA_ROOT ${join(root, "dangling", "data")} cannot be resolved (ENOENT)`,
    );
    await writeFile(join(root, "file"), "not a directory");
    expect(() => resolveSelfhostDataRoot(join(root, "file", "data"), "/")).toThrow("(ENOTDIR)");
  });
});
