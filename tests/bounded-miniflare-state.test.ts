import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBoundedMiniflareState } from "./helpers/bounded-miniflare-state.ts";
import { nativeEvidenceHostAvailable } from "./helpers/native-evidence.ts";

const roots: string[] = [];
const hasTmpfs = nativeEvidenceHostAvailable("linux-tmpfs");
function requiredPath(path: string | undefined): string {
  if (path === undefined) throw new Error("fixture path is missing");
  return path;
}
const root = (base = "/dev/shm") => {
  const path = mkdtempSync(join(base, "bounded-state-"));
  roots.push(path);
  return path;
};
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("unset state root omits persistence options and preserves the runtime", async () => {
  for (const selected of [undefined, ""]) {
    let calls = 0;
    const runtime = {
      async dispose() {
        calls++;
      },
    };
    const fixture = createBoundedMiniflareState((options) => {
      expect(options).toEqual({});
      return runtime;
    }, selected);
    expect(fixture.runtime).toBe(runtime);
    await fixture.dispose();
    expect(calls).toBe(1);
  }
});

test.skipIf(!hasTmpfs)(
  "invalid, non-tmpfs and symlink roots refuse before creating a runtime",
  () => {
    const disk = root(tmpdir());
    const link = join(root(), "link");
    symlinkSync(root(), link);
    for (const selected of ["relative", "/proc", link, join(disk, "absent")]) {
      let calls = 0;
      expect(() =>
        createBoundedMiniflareState(() => {
          calls++;
          return { async dispose() {} };
        }, selected),
      ).toThrow();
      expect(calls).toBe(0);
    }
  },
);

test.skipIf(!hasTmpfs)(
  "each state is fresh and removal waits for successful runtime disposal",
  async () => {
    const selected = root();
    const directories: string[] = [];
    let release = () => {};
    let disposals = 0;
    const fixture = createBoundedMiniflareState((options) => {
      const directory = requiredPath(options.resourcePersistencePath);
      directories.push(directory);
      writeFileSync(join(directory, "held"), "state");
      return {
        async dispose() {
          disposals++;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          expect(existsSync(directory)).toBe(true);
        },
      };
    }, selected);
    const other = createBoundedMiniflareState((options) => {
      directories.push(requiredPath(options.resourcePersistencePath));
      return { async dispose() {} };
    }, selected);
    expect(directories[0]).not.toBe(directories[1]);
    const disposal = fixture.dispose();
    await Promise.resolve();
    expect(existsSync(requiredPath(directories[0]))).toBe(true);
    release();
    await disposal;
    await fixture.dispose();
    await other.dispose();
    expect(disposals).toBe(1);
    expect(readdirSync(selected)).toEqual([]);
  },
);

test.skipIf(!hasTmpfs)(
  "constructor failure cleans its new state and keeps the original error",
  () => {
    const selected = root();
    const error = new Error("constructor failed");
    expect(() =>
      createBoundedMiniflareState(() => {
        throw error;
      }, selected),
    ).toThrow(error);
    expect(readdirSync(selected)).toEqual([]);
  },
);

test.skipIf(!hasTmpfs)(
  "failed runtime disposal retains state and fails repeated disposal",
  async () => {
    const selected = root();
    const error = new Error("runtime disposal failed");
    const fixture = createBoundedMiniflareState(
      () => ({
        async dispose() {
          throw error;
        },
      }),
      selected,
    );
    await expect(fixture.dispose()).rejects.toBe(error);
    await expect(fixture.dispose()).rejects.toBe(error);
    expect(readdirSync(selected)).toHaveLength(1);
  },
);

test.skipIf(!hasTmpfs)(
  "allocated state beyond the bound disposes only its runtime and cannot pass",
  async () => {
    const selected = root();
    const neighbor = join(selected, "neighbor");
    writeFileSync(neighbor, "keep");
    let stopped = 0;
    const fixture = createBoundedMiniflareState(
      (options) => {
        writeFileSync(
          join(requiredPath(options.resourcePersistencePath), "overflow"),
          new Uint8Array(8192).fill(1),
        );
        return {
          async dispose() {
            stopped++;
          },
        };
      },
      selected,
      4096,
    );
    const until = Date.now() + 2000;
    while (stopped === 0 && Date.now() < until) await Bun.sleep(10);
    expect(stopped).toBe(1);
    await expect(fixture.dispose()).rejects.toThrow("4096-byte bound");
    expect(stopped).toBe(1);
    expect(readdirSync(selected)).toEqual(["neighbor"]);
  },
);

test.skipIf(!hasTmpfs)("a lowered regression bound cannot widen the real fixture limit", () => {
  const selected = root();
  for (const bound of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 64 * 1024 * 1024 + 1]) {
    let calls = 0;
    expect(() =>
      createBoundedMiniflareState(
        () => {
          calls++;
          return { async dispose() {} };
        },
        selected,
        bound,
      ),
    ).toThrow("at most 64 MiB");
    expect(calls).toBe(0);
  }
  expect(readdirSync(selected)).toEqual([]);
});

test.skipIf(!hasTmpfs)("state measurement and cleanup do not follow child symlinks", async () => {
  const selected = root();
  const external = root();
  writeFileSync(join(external, "held"), "keep");
  const fixture = createBoundedMiniflareState((options) => {
    const directory = requiredPath(options.resourcePersistencePath);
    symlinkSync(directory, join(directory, "cycle"));
    symlinkSync(external, join(directory, "external"));
    return { async dispose() {} };
  }, selected);
  await fixture.dispose();
  expect(readdirSync(selected)).toEqual([]);
  expect(readdirSync(external)).toEqual(["held"]);
});
