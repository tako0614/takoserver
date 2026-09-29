import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createActorAddressing } from "../src/actor-addressing.ts";
import { renderActorAddressingModuleSource } from "../src/actor-addressing-source.ts";
import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";

const binary = nativeEvidenceBinary("actor-qualification");
const expectedDigest = process.env.TAKOSERVER_ACTOR_QUALIFICATION_SHA256;

test.skipIf(binary === undefined)(
  "generated Actor addressing ESM runs inside native workerd before tenant globals mutate",
  async () => {
    if (!binary || !expectedDigest || !/^[a-f0-9]{64}$/u.test(expectedDigest))
      throw new Error("explicit candidate binary and SHA256 required");
    expect(
      createHash("sha256")
        .update(await readFile(binary))
        .digest("hex"),
    ).toBe(expectedDigest);
    const root = await mkdtemp(join(tmpdir(), "actor-addressing-native-"));
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      await mkdir(join(root, "run"), { mode: 0o700 });
      await writeFile(join(root, "addressing.mjs"), renderActorAddressingModuleSource());
      await writeFile(
        join(root, "tenant.mjs"),
        "String.prototype.charCodeAt = () => 0; export default {};",
      );
      await writeFile(
        join(root, "wrapper.mjs"),
        `import { createActorAddressing } from "./addressing.mjs";
import "./tenant.mjs";
const addressing = createActorAddressing();
export default { fetch(request) {
  const name = new URL(request.url).searchParams.get("name");
  return Response.json({ id: addressing.idFromName(name), unique: addressing.newUniqueId() });
} };`,
      );
      const reserved = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
      const port = reserved.port;
      reserved.stop(true);
      if (!port) throw new Error("ephemeral port unavailable");
      await writeFile(
        join(root, "config.capnp"),
        `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
 services = [(name = "public", worker = (
  modules = [(name = "wrapper.mjs", esModule = embed "wrapper.mjs", role = hostPrivate),
   (name = "addressing.mjs", esModule = embed "addressing.mjs", role = hostPrivate),
   (name = "tenant.mjs", esModule = embed "tenant.mjs", role = application)],
  modulePolicy = (applicationMain = "tenant.mjs"),
  compatibilityDate = "2026-01-01", compatibilityFlags = ["experimental", "disallow_importable_env"],
  globalOutbound = "deny"
 )), (name = "deny", network = (allow = []))],
 sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "public")]
);`,
      );
      child = Bun.spawn([binary, "serve", "--experimental", join(root, "config.capnp")], {
        env: {},
        cwd: root,
        stdout: "ignore",
        stderr: "inherit",
      });
      const origin = `http://127.0.0.1:${port}`;
      let response: Response | undefined;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          response = await fetch(`${origin}/?name=${encodeURIComponent("room🦐")}`, {
            signal: AbortSignal.timeout(100),
          });
          break;
        } catch {
          await Bun.sleep(25);
        }
      }
      expect(response?.status).toBe(200);
      const result = (await response?.json()) as { id: string; unique: string };
      expect(result.id).toBe(createActorAddressing().idFromName("room🦐"));
      expect(result.unique).toMatch(/^u1_[a-f0-9]{64}$/u);
    } finally {
      child?.kill(9);
      await child?.exited;
      await rm(root, { recursive: true, force: true });
    }
  },
  10_000,
);
