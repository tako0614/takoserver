import { expect, test } from "bun:test";
import { existsSync, realpathSync, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSelfhostDataRootIfAbsent,
  resolveSelfhostDataRoot,
  unsafeAncestorProblem,
} from "../src/selfhost-data-root.ts";

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

test("a missing data root is created 0700 whatever the umask, and an existing one is left alone", async () => {
  await withTemporary(async (root) => {
    const previous = process.umask(0o000);
    try {
      const fresh = join(root, "missing", "data");
      expect(createSelfhostDataRootIfAbsent(fresh)).toBe(true);
      expect(statSync(fresh).mode & 0o777).toBe(0o700);
      expect(createSelfhostDataRootIfAbsent(fresh)).toBe(false);
      const shared = join(root, "shared");
      await mkdir(shared, { mode: 0o755 });
      await chmod(shared, 0o755);
      expect(createSelfhostDataRootIfAbsent(shared)).toBe(false);
      expect(statSync(shared).mode & 0o777).toBe(0o755);
      expect(createSelfhostDataRootIfAbsent(":memory:")).toBe(false);
      expect(existsSync(":memory:")).toBe(false);
    } finally {
      process.umask(previous);
    }
  });
});

test("an ancestor must be owned by root or this user and closed to other writers", () => {
  const name = "TAKOSERVER_DATA_ROOT";
  const self = 1000;
  // Owned by another non-root user: its owner could rename the leaf away.
  expect(unsafeAncestorProblem({ uid: 1001, mode: 0o40755 }, self, "/srv/x", name)).toBe(
    "TAKOSERVER_DATA_ROOT has an ancestor owned by another user: /srv/x has owner uid 1001, but needs owner uid 0 or 1000",
  );
  // Group-writable, even when this user owns it (umask 002, fsGroup 2775).
  expect(unsafeAncestorProblem({ uid: self, mode: 0o42775 }, self, "/srv/x", name)).toBe(
    "TAKOSERVER_DATA_ROOT has an unsafe writable ancestor: /srv/x has mode 2775 and owner uid 1000",
  );
  // Writable by others without being sticky and root-owned.
  expect(unsafeAncestorProblem({ uid: 0, mode: 0o40777 }, self, "/srv", name)).toContain(
    "unsafe writable ancestor",
  );
  // Accepted: root-owned or self-owned and closed, and a sticky root-owned /tmp.
  expect(unsafeAncestorProblem({ uid: 0, mode: 0o40755 }, self, "/", name)).toBeUndefined();
  expect(
    unsafeAncestorProblem({ uid: self, mode: 0o40755 }, self, "/home/u", name),
  ).toBeUndefined();
  expect(unsafeAncestorProblem({ uid: 0, mode: 0o41777 }, self, "/tmp", name)).toBeUndefined();
});
