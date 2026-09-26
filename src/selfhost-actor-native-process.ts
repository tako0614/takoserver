import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { ACTOR_NATIVE_BOOTSTRAP_SOURCE } from "./generated/actor-native-bootstrap.ts";
import { SELFHOST_WORKER_PROJECT_ENV_EXPORT } from "./providers/selfhost-worker-wrapper.ts";
import { type WorkerdSite, writeWorkerdPrivateExecution } from "./workerd-runtime.ts";

/** Internal, selected bytes only. Never accepted as provider desired state. */
export interface WorkerdActorNamespaceOptions {
  readonly namespaceKey: string;
  readonly storagePath: string;
  readonly className: string;
  readonly site: WorkerdSite;
  readonly modules: ReadonlyMap<string, Uint8Array>;
  readonly hostModules: ReadonlyMap<string, Uint8Array>;
  readonly signal: AbortSignal;
}

export interface WorkerdActorNamespace {
  fetch(id: string, request: Request): Promise<Response>;
  /** Settles when the native child exits, including an intentional close. */
  readonly exited: Promise<void>;
  /** Ordinary retirement drains responses; a dead child can be reaped immediately. */
  close(): Promise<void>;
}

/**
 * Private native namespace lifetime. Called only by HostedWorkerdRuntime using
 * the same operator-selected executable as its other children. No route,
 * provider capability or accepted-artifact selection is installed here.
 * Service/data bindings fail closed until their retained leases are composed.
 */
export async function openWorkerdActorNamespace(
  binary: string,
  options: WorkerdActorNamespaceOptions,
): Promise<WorkerdActorNamespace> {
  options.signal.throwIfAborted();
  if (
    !binary ||
    !isAbsolute(options.storagePath) ||
    !/^[a-f0-9]{64}$/u.test(options.namespaceKey) ||
    !options.className ||
    options.className.includes("\u0000")
  )
    throw new Error("unusable Actor namespace selection");
  const site = structuredClone(options.site);
  const modules = new Map(
    [...options.modules].map(([name, bytes]) => [name, new Uint8Array(bytes)]),
  );
  const hostModules = new Map(
    [...options.hostModules].map(([name, bytes]) => [name, new Uint8Array(bytes)]),
  );
  if ((site.serviceBindings?.length ?? 0) > 0 || site.dataPlane) {
    throw new Error("Actor retained service/data binding composition unavailable");
  }
  const wrapper = site.hostEntrypoint;
  if (!wrapper || wrapper === site.mainModule || !hostModules.has(wrapper)) {
    throw new Error("Actor selected Version has no private environment projector");
  }
  const occupied = new Set([...modules.keys(), ...hostModules.keys(), site.mainModule]);
  const allocate = (stem: string): string => {
    let name = `${stem}.js`;
    for (let index = 1; occupied.has(name); index += 1) name = `${stem}-${index}.js`;
    occupied.add(name);
    return name;
  };
  const entry = allocate("__actor_entry");
  const owner = allocate("__actor_owner");
  const helper = allocate("__actor_bootstrap");
  const token = randomBytes(32).toString("hex");
  const literal = JSON.stringify;
  const encoder = new TextEncoder();
  hostModules.set(helper, encoder.encode(ACTOR_NATIVE_BOOTSTRAP_SOURCE));
  hostModules.set(
    owner,
    encoder.encode(`import { createActorNativeOwner, createActorNativeIngress } from ${literal(`./${helper}`)};
export const ActorOwner = createActorNativeOwner();
export default createActorNativeIngress(${literal(token)});`),
  );
  // Application loading happens only in the native child. The raw native env
  // and storage never enter the constructor: the existing Host wrapper
  // projects declared bindings, then the adapter builds a closed context.
  hostModules.set(
    entry,
    encoder.encode(`import { createNativeActorExecution } from ${literal(`./${helper}`)};
import { ${SELFHOST_WORKER_PROJECT_ENV_EXPORT} as projectEnv } from ${literal(`./${wrapper}`)};
export class ActorChild {
  constructor(state, env) {
    this.execution = import(${literal(`./${site.mainModule}`)}).then(namespace => createNativeActorExecution({ namespace, exportName: ${literal(options.className)}, id: state.id.toString(), env: projectEnv(env), storage: state.storage }));
  }
  async fetch(request) { return (await this.execution).fetch(request); }
}
export default { fetch() { return new Response(null, { status: 404 }); } };`),
  );
  const root = await mkdtemp(join(tmpdir(), "tactor-"));
  await chmod(root, 0o700);
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      if (child) {
        child.kill("SIGKILL");
        await child.exited;
      }
      // Retained namespace storage is deliberately outside this directory.
      await rm(root, { recursive: true, force: true });
    })();
    return closing;
  };
  try {
    await mkdir(options.storagePath, { recursive: true, mode: 0o700 });
    const socket = join(root, "run.sock");
    const config = await writeWorkerdPrivateExecution({
      root,
      site: {
        ...site,
        hostEntrypoint: entry,
        hostModules: [...hostModules.keys()].filter((name) => name !== entry),
      },
      modules,
      hostModules,
      runSocketPath: socket,
      actor: {
        namespaceKey: options.namespaceKey,
        storagePath: options.storagePath,
        ownerModule: owner,
        className: "ActorChild",
      },
    });
    options.signal.throwIfAborted();
    child = Bun.spawn([binary, "serve", config, "--experimental"], {
      env: {},
      stdout: "ignore",
      stderr: "ignore",
    });
    let ready = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      options.signal.throwIfAborted();
      if (child.exitCode !== null) throw new Error("Actor native child exited during startup");
      try {
        const response = await fetch("http://actor.invalid/", {
          unix: socket,
          headers: { "x-takoserver-private-actor-token": token },
          signal: AbortSignal.timeout(100),
        });
        if (response.status === 204) {
          ready = true;
          break;
        }
        await response.body?.cancel();
      } catch {
        /* startup socket is not ready yet */
      }
      await Bun.sleep(10);
    }
    if (!ready) throw new Error("Actor native child readiness unavailable");
    options.signal.throwIfAborted();
    const runningChild = child;
    return {
      exited: runningChild.exited.then(() => {}),
      async fetch(id, request) {
        if (closing || child?.exitCode !== null) throw new Error("Actor namespace unavailable");
        const headers = new Headers(request.headers);
        headers.set("x-takoserver-private-actor-token", token);
        headers.set("x-takoserver-private-actor-id", encodeURIComponent(id));
        // This private hop returns application redirects as response heads.
        // Following one here could escape the Unix socket with hop credentials.
        return fetch(new Request(request, { headers, redirect: "manual" }), {
          unix: socket,
          redirect: "manual",
        });
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
