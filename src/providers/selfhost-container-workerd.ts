import { chmod, lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CONTAINER_CONTRACT as C } from "../container-contract.ts";
import { selfhostContainerBindingClientSource } from "./selfhost-container-binding-client.ts";
import type { openSelfhostContainerBindingSocket } from "./selfhost-container-binding-socket.ts";

type Socket = Awaited<ReturnType<typeof openSelfhostContainerBindingSocket>>;

/** Closed-graph candidate projection, used by qualification before Host admission. */
export async function prepareContainerWorkerd(options: {
  readonly root: string;
  readonly applicationSource: string;
  readonly port: number;
  readonly bindings: readonly { readonly name: string; readonly socket: Socket }[];
}) {
  if (
    !Number.isInteger(options.port) ||
    options.port < 1 ||
    options.port > 65535 ||
    options.bindings.length > 64
  )
    throw new TypeError("invalid candidate projection");
  const names = new Set<string>();
  for (const binding of options.bindings) {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/u.test(binding.name) || names.has(binding.name))
      throw new TypeError("invalid binding name");
    names.add(binding.name);
    const metadata = await lstat(binding.socket.path);
    if (
      !metadata.isSocket() ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.dev !== binding.socket.identity.dev ||
      metadata.ino !== binding.socket.identity.ino ||
      metadata.uid !== binding.socket.identity.uid
    )
      throw new TypeError("broker socket identity changed");
  }
  await mkdir(options.root, { recursive: true, mode: 0o700 });
  if ((await realpath(options.root)) !== options.root)
    throw new TypeError("canonical private root required");
  const root = await lstat(options.root);
  if ((root.mode & 0o077) !== 0 || root.uid !== process.getuid?.())
    throw new TypeError("private execution root required");
  const bindings = options.bindings.map((binding, index) => ({
    publicName: binding.name,
    privateName: `BROKER_${index}`,
    serviceName: `container-broker-${index}`,
    path: binding.socket.path,
  }));
  const wrapper = `import application from "./application.js";
import { makeContainerBinding } from "./client.js";
const bindings = ${JSON.stringify(bindings.map(({ publicName, privateName }) => ({ publicName, privateName })))};
export default {
  fetch(request, env, ctx) {
    const applicationEnv = Object.create(null);
    for (const binding of bindings) applicationEnv[binding.publicName] = makeContainerBinding(env[binding.privateName]);
    return application.fetch(request, Object.freeze(applicationEnv), ctx);
  }
};`;
  const config = `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "application", worker = (
      modules = [
        (name = "wrapper.js", esModule = embed "wrapper.js", role = hostPrivate),
        (name = "client.js", esModule = embed "client.js", role = hostPrivate),
        (name = "application.js", esModule = embed "application.js", role = application)
      ],
      modulePolicy = (applicationMain = "application.js"),
      compatibilityDate = "2026-01-01", compatibilityFlags = ["disallow_importable_env"],
      globalOutbound = "deny",
      bindings = [${bindings.map((binding) => `(name = ${JSON.stringify(binding.privateName)}, service = ${JSON.stringify(binding.serviceName)})`).join(", ")}]
    )),
    ${bindings.map((binding) => `(name = ${JSON.stringify(binding.serviceName)}, external = (address = ${JSON.stringify(`unix:${binding.path}`)}, http = ()))`).join(",\n    ")}${bindings.length ? "," : ""}
    (name = "deny", network = (allow = []))
  ],
  sockets = [(name = "entry", address = ${JSON.stringify(`127.0.0.1:${options.port}`)}, http = (), service = "application")]
);`;
  for (const [name, source] of [
    ["application.js", options.applicationSource],
    ["wrapper.js", wrapper],
    ["client.js", selfhostContainerBindingClientSource()],
    ["workerd.capnp", config],
  ]) {
    const path = join(options.root, name!);
    await writeFile(path, source!, { mode: 0o600, flag: "wx" });
    await chmod(path, 0o600);
  }
  return { configPath: join(options.root, "workerd.capnp"), supported: C.supported };
}
