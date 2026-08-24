import { startStableLocalWorkerHost } from "../src/entry-stable-local-worker-host.ts";

const takoformRepositoryRoot = process.env.TAKOFORM_STABLE_CATALOG_ROOT?.trim() ?? "";
const token = process.env.TAKOSERVER_STABLE_LOCAL_TOKEN?.trim() ?? "";
const space = process.env.TAKOSERVER_STABLE_LOCAL_SPACE?.trim() || "default";
if (!takoformRepositoryRoot || !token) {
  throw new Error("TAKOFORM_STABLE_CATALOG_ROOT and TAKOSERVER_STABLE_LOCAL_TOKEN are required");
}

const host = await startStableLocalWorkerHost({
  takoformRepositoryRoot,
  token,
  space,
  port: 0,
});
console.log(
  JSON.stringify({
    kind: "takoserver.stable-local-worker-host@v1",
    status: "ready",
    classification: host.classification,
    endpoint: host.endpoint,
    diagnosticRuntimeEndpoint: host.diagnosticRuntimeEndpoint,
    space: host.space,
  }),
);

let stopping = false;
const stop = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  await host.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await new Promise(() => {});
