import { appendFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { createSelfhostEntryProcessShutdown } from "../../src/selfhost-entry-process-shutdown.ts";
import {
  closeSelfhostEntryOwnedResources,
  type SelfhostEntryOwnedResourceStage,
} from "../../src/selfhost-entry-shutdown.ts";

const [failure, root] = process.argv.slice(2);
if (!root) throw new Error("isolated fixture root required");
const callsPath = join(root, "calls.log");
const record = (stage: string) => appendFileSync(callsPath, `${stage}\n`);
const stage = (name: SelfhostEntryOwnedResourceStage) => {
  record(name);
  if (failure === name) throw new Error("injected shutdown failure");
};
const ingress = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response("ingress"),
});
const dependent = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response("dependent plane"),
});

const lifecycle = createSelfhostEntryProcessShutdown({
  stopIngress: async () => {
    record("ingress");
    if (failure === "ingress") throw new Error("injected ingress failure");
    await ingress.stop(false);
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
  `${JSON.stringify({ ingressPort: ingress.port, dependentPort: dependent.port })}\n`,
);
