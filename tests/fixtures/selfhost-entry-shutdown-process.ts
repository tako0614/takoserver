import { appendFileSync, writeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createSelfhostContainerEndpointHttpsListener,
  verifySelfhostContainerEndpointHttpsHandshake,
} from "../../src/selfhost-container-endpoint-https.ts";
import { createSelfhostEntryProcessShutdown } from "../../src/selfhost-entry-process-shutdown.ts";
import {
  closeSelfhostEntryOwnedResources,
  type SelfhostEntryOwnedResourceStage,
} from "../../src/selfhost-entry-shutdown.ts";

const [failure, root] = process.argv.slice(2);
if (!root) throw new Error("isolated fixture root required");
const containerMode = failure === "container-stream" || failure === "container-deadline";
const ingressDrainTimeoutMs = Number(process.argv[4]);
const callsPath = join(root, "calls.log");
const record = (stage: string) => appendFileSync(callsPath, `${stage}\n`);
const stage = (name: SelfhostEntryOwnedResourceStage) => {
  record(name);
  if (failure === name) throw new Error("injected shutdown failure");
};
async function containerIngress(directory: string) {
  const suffix = "example.test";
  let port = 0;
  const listener = await createSelfhostContainerEndpointHttpsListener({
    configuration: { configuredSuffix: suffix, publicOrigin: `https://${suffix}`, port: 443 },
    certificateChain: await readFile(join(directory, "certificate.pem"), "utf8"),
    privateKey: await readFile(join(directory, "private-key.pem"), "utf8"),
    factories: {
      serve(options) {
        const live = Bun.serve({ ...options, hostname: "127.0.0.1", port: 0 });
        port = live.port ?? 0;
        return { port: 443, stop: (force) => live.stop(force) };
      },
      proveSni(input) {
        if (!port) throw new Error("Container HTTPS fixture did not bind a port");
        return verifySelfhostContainerEndpointHttpsHandshake({ ...input, port });
      },
    },
  });
  let finish: (() => void) | undefined;
  const encoder = new TextEncoder();
  listener.installEndpointFetch((request) => {
    if (new URL(request.url).pathname !== "/held") return new Response("admitted");
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("held body\n"));
          finish = () => {
            record("body-eof");
            controller.close();
          };
        },
      }),
    );
  });
  void Bun.stdin.text().then((command) => {
    if (command === "release\n") finish?.();
  });
  return { port, close: () => listener.close(false) };
}

function httpIngress() {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("ingress"),
  });
  return { port: server.port, close: () => server.stop(false) };
}

const ingress = containerMode ? await containerIngress(root) : httpIngress();
const dependent = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response("dependent plane"),
});

const lifecycle = createSelfhostEntryProcessShutdown({
  ...(failure === "container-deadline" ? { ingressDrainTimeoutMs } : {}),
  stopIngress: async () => {
    record("ingress");
    if (failure === "ingress") throw new Error("injected ingress failure");
    const stopped = ingress.close();
    if (containerMode) writeSync(process.stdout.fd, "ingress-fenced\n");
    await stopped;
  },
  finishShutdown: async () => {
    const closed = await closeSelfhostEntryOwnedResources({
      workerdShutdown: async () => stage("workerd-reap"),
      mayCloseDependents: () => true,
      v2WorkerSuspend: async () => stage("v2-worker-suspend"),
      actorClose: async () => stage("actor-close"),
      dataPlanesStop: async () => {
        stage("data-plane-close");
        await dependent.stop(false);
      },
      controlDatabaseClose: () => stage("control-database-close"),
      onFailure: (name) => {
        record(`failed:${name}`);
        writeSync(process.stderr.fd, `self-host shutdown failed at ${name}\n`);
      },
    });
    if (!closed) throw new Error("owned resources did not close cleanly");
  },
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    process.exitCode = 1;
    void lifecycle.shutdown();
  });
}
writeSync(
  process.stdout.fd,
  `${JSON.stringify({ ingressPort: ingress.port, dependentPort: dependent.port, pid: process.pid })}\n`,
);
