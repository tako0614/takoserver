import {
  type StableLocalCloudflareHost,
  startStableLocalCloudflareHost,
} from "../src/entry-stable-local-cloudflare-host.ts";

interface StableLocalCloudflareHostConfiguration {
  readonly takoformRepositoryRoot: string;
  readonly token: string;
  readonly space: string;
  readonly port: number;
}

type ReadyHost = Pick<
  StableLocalCloudflareHost,
  "endpoint" | "diagnosticRuntimeEndpoint" | "space" | "classification" | "report"
>;

/**
 * Parses only disposable local-host inputs.
 */
export function parseStableLocalCloudflareHostEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): StableLocalCloudflareHostConfiguration {
  const takoformRepositoryRoot = environment.TAKOFORM_STABLE_CATALOG_ROOT?.trim() ?? "";
  const token = environment.TAKOSERVER_STABLE_LOCAL_TOKEN?.trim() ?? "";
  if (!takoformRepositoryRoot || !token) {
    throw new Error("TAKOFORM_STABLE_CATALOG_ROOT and TAKOSERVER_STABLE_LOCAL_TOKEN are required");
  }

  const space = environment.TAKOSERVER_STABLE_LOCAL_SPACE?.trim() || "default";
  const encodedPort = environment.TAKOSERVER_STABLE_LOCAL_PORT?.trim() ?? "";
  if (encodedPort && !/^(?:0|[1-9][0-9]{0,4})$/u.test(encodedPort)) {
    throw new Error("TAKOSERVER_STABLE_LOCAL_PORT must be an integer from 0 through 65535");
  }
  const port = encodedPort ? Number(encodedPort) : 0;
  if (port > 65_535) {
    throw new Error("TAKOSERVER_STABLE_LOCAL_PORT must be an integer from 0 through 65535");
  }

  return { takoformRepositoryRoot, token, space, port };
}

export function stableLocalCloudflareHostReadyRecord(host: ReadyHost) {
  for (const endpoint of [host.endpoint, host.diagnosticRuntimeEndpoint]) {
    const url = new URL(endpoint);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
      throw new Error("stable local Cloudflare Host must bind an HTTP loopback endpoint");
    }
  }
  const report = host.report();
  return {
    kind: "takoserver.stable-local-cloudflare-host@v1" as const,
    status: "ready" as const,
    classification: host.classification,
    endpoint: host.endpoint,
    diagnosticRuntimeEndpoint: host.diagnosticRuntimeEndpoint,
    space: host.space,
    report: {
      installedFormKindCount: report.installedFormKindCount,
      resourceGraphCount: report.resourceGraphCount,
      currentObjectBucketIdentities: report.currentObjectBucketIdentities,
      currentEdgeObjectsReferences: report.currentEdgeObjectsReferences,
    },
  };
}

export async function runStableLocalCloudflareHost(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const configuration = parseStableLocalCloudflareHostEnvironment(environment);
  const host = await startStableLocalCloudflareHost(configuration);
  console.log(JSON.stringify(stableLocalCloudflareHostReadyRecord(host)));

  let resolveStopped: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= host.close().then(() => resolveStopped?.());
    return closing;
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
  await stopped;
}

if (import.meta.main) await runStableLocalCloudflareHost();
