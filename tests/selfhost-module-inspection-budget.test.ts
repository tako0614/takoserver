import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseSelfhostModuleInspectionWallTimeout,
  SELFHOST_MODULE_INSPECTION_WALL_TIMEOUT_VARIABLE,
} from "../src/workerd-worker-module-inspector.ts";

test("only a bounded canonical Host wall budget is accepted, with no implicit override", () => {
  expect(parseSelfhostModuleInspectionWallTimeout(undefined)).toBeUndefined();
  for (const value of ["25", "2000", "30000"]) {
    expect(parseSelfhostModuleInspectionWallTimeout(value)).toBe(Number(value));
  }
  for (const value of [
    "",
    "0",
    "24",
    "30001",
    "030000",
    " 2000",
    "2000 ",
    "2.5",
    "1e4",
    "NaN",
    "Infinity",
  ]) {
    expect(() => parseSelfhostModuleInspectionWallTimeout(value)).toThrow(
      SELFHOST_MODULE_INSPECTION_WALL_TIMEOUT_VARIABLE,
    );
  }
});

test("normal entry refuses an invalid wall budget before creating control state", async () => {
  const root = await mkdtemp(join(tmpdir(), "selfhost-inspection-budget-"));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const dataRoot = join(root, "unopened");
    const running = Bun.spawn([process.execPath, "--no-env-file", "src/entry-bun.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        TAKOSERVER_DATA_ROOT: dataRoot,
        TAKOSERVER_PUBLIC_ORIGIN: "https://inspection.example.test",
        TAKOSERVER_TAKOFORM_V2_CURSOR_KEY: randomBytes(32).toString("base64url"),
        TAKOSERVER_TAKOFORM_V2_CONFIG: JSON.stringify({
          documentation: "https://docs.example.test/v2",
          authenticationDocumentation: "https://docs.example.test/auth",
        }),
        [SELFHOST_MODULE_INSPECTION_WALL_TIMEOUT_VARIABLE]: "30001",
      },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    child = running;
    timer = setTimeout(() => child?.kill("SIGKILL"), 30_000);
    const stderr = new Response(running.stderr).text();
    expect(await running.exited).not.toBe(0);
    expect(await stderr).toContain(SELFHOST_MODULE_INSPECTION_WALL_TIMEOUT_VARIABLE);
    await expect(stat(dataRoot)).rejects.toHaveProperty("code", "ENOENT");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (child?.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 45_000);
