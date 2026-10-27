import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inspectMoneyNativeBuildSourceTree } from "../scripts/deploy/money-native-build-closure.ts";
import { WRANGLER } from "../scripts/deploy/process.ts";

test("real no-bundle publication build needs an explicit output directory to keep source closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "worker-upload-source-"));
  try {
    for (const explicit of [false, true]) {
      const owner = join(root, explicit ? "green" : "red");
      const output = join(root, explicit ? "green-output" : "red-output");
      mkdirSync(owner);
      mkdirSync(output);
      const files = {
        "package.json": "{}\n",
        "src/worker.js": "export default {fetch(){return new Response('closed')}};\n",
      };
      const expected = Object.entries(files).map(([path, bytes]) => {
        mkdirSync(dirname(join(owner, path)), { recursive: true });
        writeFileSync(join(owner, path), bytes);
        return {
          path,
          executable: false,
          blob: createHash("sha1")
            .update(`blob ${Buffer.byteLength(bytes)}\0${bytes}`)
            .digest("hex"),
        };
      });
      const inspect = () => inspectMoneyNativeBuildSourceTree(owner, expected);
      const before = inspect();
      const config = join(output, "wrangler.jsonc");
      writeFileSync(
        config,
        JSON.stringify({
          name: "source-closure-test",
          main: join(owner, "src/worker.js"),
          compatibility_date: "2026-08-17",
          workers_dev: false,
        }),
      );
      const child = Bun.spawn(
        [
          Bun.which("node")!,
          WRANGLER,
          "deploy",
          join(owner, "src/worker.js"),
          "--no-bundle",
          "--dry-run",
          "--strict",
          "--config",
          config,
          ...(explicit ? ["--outdir", join(output, "upload")] : []),
        ],
        {
          cwd: owner,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: root,
            TMPDIR: root,
            CI: "1",
            NO_COLOR: "1",
            WRANGLER_SEND_METRICS: "false",
          },
        },
      );
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ code, diagnostics: code === 0 ? "" : stdout + stderr }).toEqual({
        code: 0,
        diagnostics: "",
      });
      if (explicit) {
        expect(existsSync(join(owner, ".wrangler"))).toBe(false);
        expect(inspect().identityDigest).toBe(before.identityDigest);
        expect(readFileSync(join(output, "upload/worker.js"), "utf8")).toBe(files["src/worker.js"]);
      } else {
        expect(existsSync(join(owner, ".wrangler/tmp"))).toBe(true);
        expect(inspect).toThrow("differs from the reviewed complete Git tree");
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
