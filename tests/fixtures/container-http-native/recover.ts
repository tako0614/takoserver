import { createDockerHttpRevisionRuntime } from "../../../src/providers/docker-http-revision.ts";
import { createSelfhostContainerRuntime } from "../../../src/providers/selfhost-container-runtime.ts";

const configuration = JSON.parse(process.argv[2]!);
const backend = createDockerHttpRevisionRuntime({
  socketPath: configuration.socketPath,
  installationId: configuration.installation,
  network: configuration.network,
  maxMemoryBytes: 268_435_456,
  maxNanoCpus: 500_000_000,
  pidsLimit: 128,
  timeoutMs: 5000,
});
const runtime = await createSelfhostContainerRuntime({
  root: configuration.root,
  backend,
  drainTimeoutMs: 30_000,
});
try {
  const observation = await runtime.observe(configuration.identity);
  const response = await runtime.fetch(configuration.identity, new Request("http://ignored/echo"));
  console.info(
    JSON.stringify({
      servingGeneration: observation.servingGeneration,
      revision: ((await response.json()) as { revision: string }).revision,
    }),
  );
} finally {
  await runtime.close();
}
