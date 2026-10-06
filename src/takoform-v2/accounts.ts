import { type Accounts, AuthError, grants } from "../auth.ts";
import type { TakoformV2HttpPrincipal } from "./routes.ts";

/**
 * Composes existing Takoserver account credentials into organization-owned v2
 * identity. The credential's current scopes remain request-local; the stable
 * principal and Space are shared by the organization's authorized credentials.
 */
export function createTakoformV2AccountAccess(
  accounts: Pick<Accounts, "authenticate" | "requireOwner">,
): {
  authenticate(request: Request): Promise<TakoformV2HttpPrincipal | null>;
  authorize(principal: string, space: string, access: "read" | "write"): Promise<boolean>;
} {
  return {
    async authenticate(request) {
      const actor = await accounts.authenticate(request.headers.get("authorization"));
      if (!actor) return null;

      let organizationId: string;
      let access: TakoformV2HttpPrincipal["access"];
      if (actor.kind === "api_key") {
        // The organization comes only from the authenticated key row. In
        // particular, the selection header never rebinds a bearer key.
        if (!actor.organizationId) return null;
        if (grants(actor.scopes, "resources:write")) access = "write";
        else if (grants(actor.scopes, "resources:read")) access = "read";
        else return null;
        organizationId = actor.organizationId;
      } else {
        // A session must select its organization explicitly on every request.
        // Pass the exact opaque ID to the owner check; do not normalize aliases.
        const selectedOrganization = request.headers.get("takoform-organization");
        if (selectedOrganization === null) return null;
        try {
          await accounts.requireOwner(actor, selectedOrganization);
        } catch (error) {
          if (error instanceof AuthError && error.code === "not_found") return null;
          throw error;
        }
        organizationId = selectedOrganization;
        access = "write";
      }

      return { principal: `org:${organizationId}`, access };
    },

    async authorize(principal, space, access) {
      // The HTTP boundary checks the live credential's read/write grant before
      // calling the engine. This callback binds durable v2 rows to the exact
      // organization Space and does not retain mutable request authority.
      if (access !== "read" && access !== "write") return false;
      if (!principal.startsWith("org:")) return false;
      const organizationId = principal.slice("org:".length);
      return organizationId.length > 0 && space === organizationId;
    },
  };
}
