import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Opt-in candidate-runtime evidence only. This does not change the serving pin or
// claim that a native WebSocket response satisfies the Actor socket contract.
const binary = process.env.TAKOSERVER_ACTOR_QUALIFICATION_BINARY;
const expectedDigest = process.env.TAKOSERVER_ACTOR_QUALIFICATION_SHA256;

const PROBE_MODULE = `export default {
  fetch(request) {
    if (new URL(request.url).pathname === "/health") return new Response("ok");
    const failure = (run) => {
      try { run(); return null; }
      catch (error) { return { name: error.name, message: String(error.message) }; }
    };
    const plain101 = failure(() => new Response(null, { status: 101 }));
    const pair = new WebSocketPair();
    const upgrade = new Response(null, { status: 101, webSocket: pair[0] });
    const clone = failure(() => upgrade.clone());
    const alias = new Response(upgrade.body, upgrade);
    const copiedInit = failure(() => new Response(null, {
      status: upgrade.status, headers: upgrade.headers,
    }));
    const result = {
      plain101,
      upgradeStatus: upgrade.status,
      upgradeNullBody: upgrade.body === null,
      nativeSocketPublic: upgrade.webSocket === pair[0],
      clone,
      aliasStatus: alias.status,
      aliasNullBody: alias.body === null,
      aliasNativeSocketPublic: alias.webSocket === pair[0],
      copiedInit,
    };
    return Response.json(result);
  },
};`;

test.skipIf(binary === undefined)(
  "candidate workerd native Response 101 exposes a WebSocket and cannot be cloned",
  async () => {
    if (!binary || !expectedDigest || !/^[a-f0-9]{64}$/u.test(expectedDigest)) {
      throw new Error("explicit candidate binary and SHA256 required");
    }
    const root = await mkdtemp(join(tmpdir(), "takoserver-actor-upgrade-response-"));
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const snapshot = join(root, "workerd");
      await copyFile(binary, snapshot);
      expect(
        createHash("sha256")
          .update(await readFile(snapshot))
          .digest("hex"),
      ).toBe(expectedDigest);
      const reserved = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
      const port = reserved.port;
      reserved.stop(true);
      await writeFile(join(root, "probe.mjs"), PROBE_MODULE, { mode: 0o600 });
      const config = `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "probe", worker = (
      modules = [(name = "probe.mjs", esModule = embed "probe.mjs")],
      compatibilityDate = "2026-01-01", globalOutbound = "deny"
    )),
    (name = "deny", network = (allow = []))
  ],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "probe")]
);`;
      const configPath = join(root, "workerd.capnp");
      await writeFile(configPath, config, { mode: 0o600 });
      child = Bun.spawn([snapshot, "serve", configPath], {
        env: {},
        stdout: "ignore",
        stderr: "inherit",
      });
      const origin = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + 5_000;
      let ready = false;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error("candidate workerd exited before readiness");
        try {
          const response = await fetch(`${origin}/health`, {
            signal: AbortSignal.timeout(250),
          });
          ready = response.status === 200 && (await response.text()) === "ok";
          if (ready) break;
        } catch {
          // Listener not ready yet.
        }
        await Bun.sleep(25);
      }
      if (!ready) throw new Error("candidate workerd did not become ready");
      const response = await fetch(`${origin}/probe`, { signal: AbortSignal.timeout(2_000) });
      expect(response.status).toBe(200);
      const result = (await response.json()) as Record<string, unknown>;
      expect(result).toMatchObject({
        upgradeStatus: 101,
        upgradeNullBody: true,
        nativeSocketPublic: true,
        aliasStatus: 101,
        aliasNullBody: true,
        aliasNativeSocketPublic: true,
      });
      expect(result.plain101).toMatchObject({ name: "RangeError" });
      expect(result.clone).toMatchObject({ name: "TypeError" });
      expect(result.copiedInit).toMatchObject({ name: "RangeError" });
    } finally {
      child?.kill(9);
      await child?.exited.catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  },
  10_000,
);
