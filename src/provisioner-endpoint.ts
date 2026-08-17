import { failed, type Provider, type ProviderTicket } from "./provider-port.ts";
import { PROVISIONER_PATH } from "./providers/remote.ts";

/**
 * The provisioner's side of the road.
 *
 * The public API runs on Workers and is deliberately unable to reach any cloud
 * account. This is the half that can, and it answers one path with one shape:
 * a provider call in, a classified ticket out. Nothing else about the product
 * is served here — no tenant, no billing, no lifecycle. Those stay where the
 * customer's request already is.
 *
 * Authorization is a single credential this deployment issued to itself,
 * compared in constant time. There is no per-tenant identity to check because
 * there is no per-tenant decision to make: whoever holds this credential is the
 * other half of this deployment, and the decisions were already taken there.
 *
 * If no credential is configured the path is not served at all. Serving it
 * open would hand the account to anyone who found the port.
 */

export interface ProvisionerEndpointOptions {
  readonly providers: readonly Provider[];
  /** Shared credential. Absent means the endpoint is not served. */
  readonly credential?: string | undefined;
}

export type ProvisionerEndpoint = (request: Request) => Promise<Response | null>;

export function createProvisionerEndpoint(
  options: ProvisionerEndpointOptions,
): ProvisionerEndpoint {
  const byOffering = new Map<string, Provider>();
  for (const provider of options.providers) {
    for (const offering of provider.offerings) byOffering.set(offering.id, provider);
  }

  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== PROVISIONER_PATH) return null;
    if (!options.credential) {
      // Not configured is not the same as forbidden, and saying so would tell
      // a scanner that this deployment has a provisioner worth finding.
      return Response.json({ error: { code: "not_found" } }, { status: 404 });
    }
    if (request.method !== "POST") {
      return Response.json({ error: { code: "method_not_allowed" } }, { status: 405 });
    }
    const presented = request.headers.get("authorization") ?? "";
    if (!matches(presented, `Bearer ${options.credential}`)) {
      return Response.json({ error: { code: "unauthenticated" } }, { status: 401 });
    }

    const body = (await request.json().catch(() => null)) as {
      readonly operation?: unknown;
      readonly input?: unknown;
    } | null;
    if (!body || typeof body.operation !== "string" || !isRecord(body.input)) {
      return Response.json({ error: { code: "invalid_argument" } }, { status: 400 });
    }

    const ticket = await run(byOffering, body.operation, body.input);
    return Response.json({ ticket });
  };
}

async function run(
  byOffering: ReadonlyMap<string, Provider>,
  operation: string,
  input: Record<string, unknown>,
): Promise<ProviderTicket> {
  const offering = input.offering as { readonly id?: unknown } | undefined;
  const provider =
    typeof offering?.id === "string" ? byOffering.get(offering.id) : firstOf(byOffering);
  if (!provider) return failed("invalid_spec", "no provisioner serves that offering");

  try {
    switch (operation) {
      case "apply":
        return await provider.apply(input as never);
      case "observe":
        return await provider.observe(input as never);
      case "delete":
        return await provider.delete(input as never);
      case "adopt":
        return provider.adopt
          ? await provider.adopt(input as never)
          : failed("invalid_spec", "this provisioner cannot adopt");
      case "poll":
        return provider.poll
          ? await provider.poll(input as never)
          : failed("invalid_spec", "this provisioner has nothing to poll");
      default:
        return failed("invalid_spec", "unknown provisioner operation");
    }
  } catch (error) {
    // A provider that threw is a fault on this side. It crosses back as a
    // retryable failure rather than as an exception the caller cannot classify,
    // and the detail is logged where an operator of *this* half can read it.
    console.error(
      JSON.stringify({
        event: "takoserver.provisioner.threw",
        operation,
        error: error instanceof Error ? `${error.name}: ${error.message}` : "unknown",
      }).slice(0, 4_096),
    );
    return failed("unavailable", "the provisioner could not complete this", true);
  }
}

function firstOf(byOffering: ReadonlyMap<string, Provider>): Provider | undefined {
  for (const provider of byOffering.values()) return provider;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Compares two credentials without letting the time taken say how much of the
 * guess was right.
 */
function matches(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
