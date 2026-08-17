import type { TakoserverModule } from "./contracts.ts";
import {
  createTakoformHost,
  type InstalledTakoformForm,
  type TakoformHost,
  type TakoformResourceDriver,
} from "./takoform-host.ts";

/**
 * Adapts an Organization-scoped Takoserver API key to the current Takoform
 * Host lane. A single-use execution grant is intentionally never accepted as
 * the provider's run-wide bearer credential.
 */
export function createTakoserverTakoformHost(options: {
  readonly server: TakoserverModule;
  readonly forms: readonly InstalledTakoformForm[];
  readonly driver: TakoformResourceDriver;
  readonly clock?: () => Date;
  readonly randomId?: () => string;
}): TakoformHost {
  return createTakoformHost({
    authenticate: async (authorization) => {
      const actor = await options.server.authorizeOrganization(authorization, "resources:write");
      return actor ? { tenantId: actor.organizationId, principalId: actor.principalId } : null;
    },
    forms: options.forms,
    driver: options.driver,
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.randomId ? { randomId: options.randomId } : {}),
  });
}
