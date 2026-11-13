import type { Clock, Sql } from "./ports.ts";
import { createSelfhostLinuxContainerNodeComposition } from "./selfhost-linux-container-node-composition.ts";
import type { SelfhostLinuxDockerCoreSelection } from "./selfhost-linux-docker-core.ts";
import type { V2OperatorFormSelectionFactory } from "./takoform-v2/application.ts";
import type { V2PrivateInputCustody } from "./takoform-v2/private-inputs.ts";
import type { V2Action } from "./takoform-v2/types.ts";

/** Preserve the original Docker API while sharing the actual Node binding.
 * Lazy original Sql/clock/action reads retain the disabled/refusal ordering;
 * no caller backend, native owner or verification callback is introduced.
 */
export function createSelfhostLinuxDockerNodeComposition(input: {
  readonly sql: Sql;
  readonly clock: Clock;
  readonly selection: SelfhostLinuxDockerCoreSelection | undefined;
  readonly formSelectionFactory: V2OperatorFormSelectionFactory | undefined;
  readonly privateInputCustody: V2PrivateInputCustody | undefined;
  readonly retainedExecutionActions?: Readonly<Record<string, readonly V2Action[]>>;
}): ReturnType<typeof createSelfhostLinuxContainerNodeComposition> {
  const formSelectionFactory = input.formSelectionFactory;
  const privateInputCustody = input.privateInputCustody;
  const selection = input.selection;
  return createSelfhostLinuxContainerNodeComposition({
    get sql() {
      return input.sql;
    },
    get clock() {
      return input.clock;
    },
    selection: selection === undefined ? undefined : { kind: "docker", selection },
    formSelectionFactory,
    privateInputCustody,
    get retainedExecutionActions() {
      return input.retainedExecutionActions;
    },
  });
}
