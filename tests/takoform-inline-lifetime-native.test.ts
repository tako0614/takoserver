import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Miniflare } from "miniflare";
import { miniflareServiceBinding } from "./helpers/miniflare-service-binding.ts";

const executorSource = `
import { WorkerEntrypoint } from "cloudflare:workers";
export class Executor extends WorkerEntrypoint {
  async apply() {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await this.env.STATE_DB.prepare("INSERT INTO effects (id) VALUES (1)").run();
    return "settled";
  }
}
export default { fetch() { return new Response("not found", { status: 404 }); } };
`;

test("an over-budget Host request retains its native provider RPC until settlement", async () => {
  const repositoryRoot = resolve(import.meta.dir, "..");
  const buildDirectory = await mkdtemp(join(tmpdir(), "takoserver-inline-lifetime-"));
  const entrypoint = join(repositoryRoot, `.takoserver-inline-lifetime-${randomUUID()}.ts`);
  const outputPath = join(buildDirectory, "caller.js");
  const callerSource = `
import { awaitInlineExecution } from "./src/takoform/inline-lifetime.ts";
export default {
  async fetch(_request, env, ctx) {
    const settled = await awaitInlineExecution(
      env.EXECUTOR.apply(),
      25,
      (work) => ctx.waitUntil(work),
      () => {},
    );
    return new Response(settled ? "settled" : "pending", { status: settled ? 200 : 202 });
  },
};
`;
  try {
    await Bun.write(entrypoint, callerSource);
    const build = Bun.spawn(
      [
        process.execPath,
        "build",
        entrypoint,
        "--target=browser",
        "--format=esm",
        "--external=cloudflare:workers",
        `--outfile=${outputPath}`,
      ],
      { cwd: repositoryRoot, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      build.exited,
      new Response(build.stdout).text(),
      new Response(build.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error([stdout, stderr].filter(Boolean).join("\n"));

    const runtime = new Miniflare({
      workers: [
        {
          config: {
            name: "caller",
            type: "worker",
            compatibilityDate: "2026-08-17",
            env: { EXECUTOR: miniflareServiceBinding("worker", "executor", "Executor") },
            manifest: {
              mainModule: "caller.js",
              modules: {
                "caller.js": { type: "esm", contents: await Bun.file(outputPath).text() },
              },
            },
          },
        },
        {
          config: {
            name: "executor",
            type: "worker",
            compatibilityDate: "2026-08-17",
            env: { STATE_DB: { type: "d1", id: "inline-lifetime" } },
            manifest: {
              mainModule: "executor.js",
              modules: { "executor.js": { type: "esm", contents: executorSource } },
            },
          },
        },
      ],
    });
    try {
      const database = await runtime.getD1Database("STATE_DB", "executor");
      await database.prepare("CREATE TABLE effects (id INTEGER PRIMARY KEY)").run();
      const response = await runtime.dispatchFetch("https://caller.invalid/");
      expect(response.status).toBe(202);
      expect(await response.text()).toBe("pending");
      await Bun.sleep(400);
      const effect = await database.prepare("SELECT id FROM effects WHERE id = 1").first();
      expect(effect).toEqual({ id: 1 });
    } finally {
      await runtime.dispose();
    }
  } finally {
    await Promise.all([
      rm(entrypoint, { force: true }),
      rm(buildDirectory, { recursive: true, force: true }),
    ]);
  }
});
