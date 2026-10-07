import type { Sql } from "./ports.ts";
import type { createSelfhostActorExecutionHost } from "./selfhost-actor-execution-host.ts";
import type { ActorGraphAuthority } from "./selfhost-actor-graph-authority.ts";
import type { SelfhostV2ActorBootPort } from "./selfhost-v2-worker-composition.ts";
import { createV2ActorBindingAuthority } from "./takoform-v2/actor-binding-authority.ts";
import { createV2ActorForwardBoot } from "./takoform-v2/actor-forward-runtime.ts";
import {
  createV2ActorNamespaceForm,
  type V2ActorAcceptedOperationRuntimeObserver,
} from "./takoform-v2/actor-namespace-backend.ts";
import type { V2ActorAcceptedOperationGraphAuthority } from "./takoform-v2/actor-namespace-graph-authority.ts";

type PhysicalActorHost = Pick<
  ReturnType<typeof createSelfhostActorExecutionHost>,
  | "fetch"
  | "reserveDuplex"
  | "hasNamespace"
  | "registerNamespace"
  | "namespaceEmpty"
  | "forgetNamespace"
  | "namespaceAbsent"
> &
  V2ActorAcceptedOperationRuntimeObserver;

/**
 * App-layer assembly of one exact v2 accepted SQL authority and physical Host.
 * The portable Worker composition receives only the prepared private port; no
 * v1 ResourceDeployment or public FormSupport registry participates.
 */
export function createSelfhostV2ActorBoot(options: {
  readonly sql: Sql;
  readonly targetKey: string;
  readonly namespaceGraph: ActorGraphAuthority & V2ActorAcceptedOperationGraphAuthority;
  readonly physical: PhysicalActorHost;
  readonly privateSocketDirectory: string;
}): SelfhostV2ActorBootPort {
  if (
    !options.sql ||
    !options.targetKey ||
    typeof options.namespaceGraph?.readGraph !== "function" ||
    typeof options.namespaceGraph?.readAcceptedOperationGraph !== "function" ||
    typeof options.namespaceGraph?.acceptedOperationRealization !== "function" ||
    typeof options.namespaceGraph?.hasRealization !== "function" ||
    typeof options.namespaceGraph?.stillCurrent !== "function" ||
    typeof options.namespaceGraph?.selectVersion !== "function" ||
    typeof options.physical?.fetch !== "function" ||
    typeof options.physical?.reserveDuplex !== "function" ||
    typeof options.physical?.hasNamespace !== "function" ||
    typeof options.physical?.registerNamespace !== "function" ||
    typeof options.physical?.namespaceEmpty !== "function" ||
    typeof options.physical?.forgetNamespace !== "function" ||
    typeof options.physical?.namespaceAbsent !== "function" ||
    typeof options.physical?.observeNamespaceRuntimeForAcceptedOperation !== "function" ||
    typeof options.physical?.warmNamespaceForAcceptedOperation !== "function"
  ) {
    throw new TypeError("v2 Actor boot requires exact graph, physical owner and readback");
  }
  const sql = options.sql;
  const targetKey = options.targetKey;
  const namespaceGraph = options.namespaceGraph;
  const physical = options.physical;
  const privateSocketDirectory = options.privateSocketDirectory;
  return Object.freeze({
    prepare(input: Parameters<SelfhostV2ActorBootPort["prepare"]>[0]) {
      if (
        input.sql !== sql ||
        input.targetKey !== targetKey ||
        typeof input.bundleCustody?.readHeldVerified !== "function" ||
        typeof input.inspector?.inspectActorClass !== "function"
      ) {
        throw new TypeError("v2 Actor boot must use the same SQL, target and held inspector");
      }
      const bindingAuthority = createV2ActorBindingAuthority({
        sql,
        targetKey,
        namespaceGraph,
        physical,
      });
      const forwardBoot = createV2ActorForwardBoot({
        sql,
        targetKey,
        authority: bindingAuthority,
        physical,
        privateSocketDirectory,
        canInvoke: input.actorInvocationReady,
      });
      const namespaceForm = createV2ActorNamespaceForm({
        sql,
        targetKey,
        bundleCustody: input.bundleCustody,
        inspector: input.inspector,
        physical,
        ownerForWorker: input.ownerForWorker,
        acceptedGraph: namespaceGraph,
      });
      return Object.freeze({ namespaceForm, bindingAuthority, forwardBoot });
    },
  });
}
