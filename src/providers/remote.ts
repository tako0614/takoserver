import type { JsonObject } from "../ports.ts";
import {
  failed,
  type Provider,
  type ProviderOffering,
  type ProviderTicket,
} from "../provider-port.ts";

/**
 * Provisioning through a provisioner this deployment runs elsewhere.
 *
 * The Worker that answers the public API is deliberately unable to reach
 * Cloudflare's account APIs — it holds no account credential, and the import
 * gate proves it cannot acquire one. That rule is why provisioning lives on a
 * self-hosted entry. What was missing was the road between them: the two
 * entries were alternatives rather than one system, so an apply against the
 * public origin found no provider at all and answered that the backend was
 * unavailable, which was true and unhelpful.
 *
 * This is that road. Everything cloud-shaped stays on the far side; what
 * crosses is the same classified ticket the port already speaks, and the only
 * credential here is one this deployment issued to itself.
 *
 * It is a `Provider` like any other, which is the point: the engine, the
 * billing, and the operation records do not learn that provisioning happens
 * somewhere else.
 */

export interface RemoteProviderOptions {
  readonly id?: string;
  /** Origin of the provisioner, without a path. */
  readonly origin: string;
  readonly offerings: readonly ProviderOffering[];
  /** Returns an `Authorization` header value. The credential never lives here. */
  readonly authorize: () => string | Promise<string>;
  readonly fetch?: (request: Request) => Promise<Response>;
  /** How long to wait before giving up on one call. */
  readonly timeoutMs?: number;
}

/** The path the provisioner serves. Not public: it is between our own halves. */
export const PROVISIONER_PATH = "/internal/v1/provision";

type Call =
  | { readonly operation: "apply"; readonly input: JsonObject }
  | { readonly operation: "observe"; readonly input: JsonObject }
  | { readonly operation: "delete"; readonly input: JsonObject }
  | { readonly operation: "adopt"; readonly input: JsonObject }
  | { readonly operation: "poll"; readonly input: JsonObject };

export function createRemoteProvider(options: RemoteProviderOptions): Provider {
  const send = options.fetch ?? ((request: Request) => fetch(request));
  const timeout = options.timeoutMs ?? 60_000;

  const call = async (body: Call): Promise<ProviderTicket> => {
    let authorization: string;
    try {
      authorization = await options.authorize();
    } catch {
      return failed("denied", "this deployment has no provisioner credential");
    }

    let response: Response;
    try {
      response = await send(
        new Request(`${options.origin}${PROVISIONER_PATH}`, {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeout),
        }),
      );
    } catch {
      // Retryable on purpose: a provisioner that is restarting is the ordinary
      // reason for this, and the operation record is what makes a retry safe.
      return failed("unavailable", "the provisioner is unreachable", true);
    }

    if (response.status === 401 || response.status === 403) {
      return failed("denied", "the provisioner refused this deployment's credential");
    }
    const payload = (await response.json().catch(() => null)) as {
      readonly ticket?: unknown;
    } | null;
    if (!response.ok || !payload) {
      return failed(
        "unavailable",
        `the provisioner refused the request (${response.status})`,
        true,
      );
    }
    const ticket = asTicket(payload.ticket);
    if (!ticket) {
      // A malformed answer must not be read as success. Reporting it as
      // unavailable keeps the operation open rather than recording a resource
      // that may not exist.
      return failed("unavailable", "the provisioner returned an unusable answer", true);
    }
    return ticket;
  };

  return {
    id: options.id ?? "remote",
    offerings: structuredClone(options.offerings) as ProviderOffering[],
    apply: (input) => call({ operation: "apply", input: input as unknown as JsonObject }),
    observe: (input) => call({ operation: "observe", input: input as unknown as JsonObject }),
    delete: (input) => call({ operation: "delete", input: input as unknown as JsonObject }),
    adopt: (input) => call({ operation: "adopt", input: input as unknown as JsonObject }),
    poll: (input) => call({ operation: "poll", input: input as unknown as JsonObject }),
  };
}

/**
 * Reads a ticket, or nothing.
 *
 * The far side is ours, which is a reason to keep the shapes in step and not a
 * reason to trust the bytes: a half-written answer that parsed as a success
 * would record a resource nobody created.
 */
function asTicket(value: unknown): ProviderTicket | null {
  if (typeof value !== "object" || value === null) return null;
  const ticket = value as Record<string, unknown>;
  if (ticket.phase === "succeeded") {
    const result = ticket.result as Record<string, unknown> | undefined;
    if (!result || typeof result.nativeId !== "string") return null;
    return value as ProviderTicket;
  }
  if (ticket.phase === "failed") {
    const failure = ticket.failure as Record<string, unknown> | undefined;
    if (!failure || typeof failure.code !== "string") return null;
    return value as ProviderTicket;
  }
  if (ticket.phase === "running") {
    if (typeof ticket.handle !== "string" || typeof ticket.pollAfterMs !== "number") return null;
    return value as ProviderTicket;
  }
  return null;
}
