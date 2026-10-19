import {
  createDockerImageImportTransport,
  DockerImageAcquisition,
  DockerImageAcquisitionError,
  type DockerImageAcquisitionTarget,
  type DockerImageArchiveOwner,
} from "./docker-container-image-acquisition.ts";
import type {
  DockerImageSourcePort,
  DockerImageSupplyLimits,
} from "./docker-container-image-supplier.ts";
import {
  createDockerHttpRevisionRuntime,
  type DockerHttpRevisionOptions,
} from "./docker-http-revision.ts";
import { createFileDockerImageArchiveOwner } from "./docker-image-archive-owner.ts";

type Session = Parameters<DockerImageArchiveOwner["retain"]>[0];

/** Selfhost Host composition. It constructs the actual Docker driver with the
 * fixed byte-verifying supplier, durable archive owner and binary import path.
 * The Host must supply a concrete peer/TLS-controlled registry source and a
 * strict bounded gzip/zstd codec through the existing source-port contract.
 * No global fetch/codec fallback, public Form field or capability boolean. */
export async function createDockerImageRuntime(options: {
  readonly runtime: Omit<DockerHttpRevisionOptions, "imageAcquisition">;
  readonly limits: DockerImageSupplyLimits;
  readonly source: (
    session: Session,
    target: DockerImageAcquisitionTarget,
  ) => DockerImageSourcePort;
  readonly archives: {
    readonly root: string;
    readonly maxTotalBytes: number;
    readonly maxArchives: number;
  };
  readonly maxImportMetadataBytes: number;
  readonly maxImportLineBytes: number;
}) {
  if (!options.runtime.runtimePreparation?.createCustody)
    throw new DockerImageAcquisitionError("unavailable");
  const archives = await createFileDockerImageArchiveOwner({
    ...options.archives,
    maxArchiveBytes: options.limits.maxArchiveBytes,
  });
  const native = createDockerImageImportTransport({
    socketPath: options.runtime.socketPath,
    timeoutMs: options.limits.maxDurationMs,
    maxMetadataBytes: options.maxImportMetadataBytes,
    maxLineBytes: options.maxImportLineBytes,
    maxArchiveBytes: options.limits.maxArchiveBytes,
    maxManifestBytes: options.limits.maxManifestBytes,
    maxConfigBytes: options.limits.maxConfigBytes,
    maxLayers: options.limits.maxLayers,
  });
  const imageAcquisition = new DockerImageAcquisition({
    limits: options.limits,
    source: options.source,
    archives,
    native,
  });
  return createDockerHttpRevisionRuntime({ ...options.runtime, imageAcquisition });
}
