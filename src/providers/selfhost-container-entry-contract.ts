/** Code-only Host composition contracts. These types carry existing authority;
 * they neither mint acceptance nor import the running application/bootstrap. */
import type { ObjectStoreAccess, Sql } from "../ports.ts";
import type { V2HostAcceptance } from "../takoform-v2/host-acceptance.ts";
import type { V2Form } from "../takoform-v2/types.ts";
import type {
  createDockerHttpRevisionRuntime,
  DockerHttpRevisionOptions,
} from "./docker-http-revision.ts";

export interface SelfhostContainerEntryContext {
  readonly sql: Sql;
  readonly clock: () => Date;
  readonly dataRoot: string;
  readonly docker: Readonly<DockerHttpRevisionOptions>;
}
export interface SelfhostContainerEntryBackend {
  readonly backend: ReturnType<typeof createDockerHttpRevisionRuntime>;
  readonly acceptance: V2HostAcceptance;
  /** Exact existing AppPorts.v2FormFactory structural contract. This neutral
   * carrier does not depend on the application/bootstrap module. */
  readonly formFactory?: (context: {
    readonly sql: Sql;
    readonly objects: ObjectStoreAccess;
    readonly clock: () => Date;
  }) => Readonly<Record<string, V2Form>>;
  readonly close?: () => Promise<void>;
}
export type SelfhostContainerEntryBackendFactory = (
  context: SelfhostContainerEntryContext,
) => Promise<SelfhostContainerEntryBackend>;
