import {
  type ApplyInput,
  failed,
  type Provider,
  type ProviderOffering,
  type ProviderTicket,
  succeeded,
} from "../provider-port.ts";

/**
 * Provisioning on the machine this is running on.
 *
 * Takoserver's shape has always allowed this — the engine, the billing, and
 * the lifecycle talk to a `Provider` and know nothing about clouds — but until
 * now the only provider was Cloudflare, which made "self-hostable" a claim
 * about the architecture rather than something anybody could run.
 *
 * Two kinds are served here and they are honest about what they are:
 *
 * - An **object bucket** is a namespace. The data plane already keys objects
 *   by the resource's uid in whatever store this deployment was given, so a
 *   bucket needs no backend of its own — creating one is agreeing that a name
 *   exists. On Cloudflare it is an R2 bucket because R2 charges per bucket;
 *   here it is a prefix, which is the same promise with less machinery.
 * - A **SQL database** is a file under the data root, named for the resource.
 *   Nothing is created eagerly: a database file appears when something writes
 *   to it, and reporting a path that does not exist yet would be reporting a
 *   thing that is not there.
 *
 * Workers are deliberately absent. Running somebody else's code is a different
 * problem from storing their bytes — it needs a runtime, isolation, and a way
 * to route a hostname at it — and a provider that claimed the capability and
 * then failed at apply would be worse than one that says plainly it does not
 * have it.
 */

export interface LocalProviderOptions {
  readonly id?: string;
  readonly offerings: readonly ProviderOffering[];
  /** Where databases live. Objects live wherever the ObjectStore was pointed. */
  readonly dataRoot: string;
}

export function createLocalProvider(options: LocalProviderOptions): Provider {
  const id = options.id ?? "local";

  const forKind = (offering: ProviderOffering, identity: ApplyInput["identity"]) => {
    // Derived from the address, so the same declaration always names the same
    // thing and a retry cannot make a second one.
    const name = `${identity.tenantRef}-${identity.space}-${identity.name}`.replace(
      /[^A-Za-z0-9_-]/gu,
      "_",
    );
    switch (offering.kind) {
      case "object_bucket":
        return {
          nativeId: `local-bucket:${name}`,
          observed: { name },
          outputs: { protocol: "s3", bucketName: name },
        };
      case "sql_database":
        return {
          nativeId: `local-sqlite:${name}`,
          observed: { name },
          outputs: { engine: "sqlite", path: `${options.dataRoot}/databases/${name}.sqlite` },
        };
      default:
        return null;
    }
  };

  return {
    id,
    offerings: structuredClone(options.offerings) as ProviderOffering[],

    async apply(input): Promise<ProviderTicket> {
      const made = forKind(input.offering, input.identity);
      if (!made) {
        return failed(
          "invalid_spec",
          `${input.offering.kind} needs a runtime this deployment does not have`,
        );
      }
      // Nothing here has mutable backend state, so an update confirms rather
      // than changes. Saying so beats pretending work happened.
      return succeeded(made);
    },

    async observe(input): Promise<ProviderTicket> {
      const made = forKind(input.offering, input.identity);
      if (!made) return failed("not_found", "unrecognised native identity");
      return succeeded({ ...made, nativeId: input.nativeId });
    },

    async delete(input): Promise<ProviderTicket> {
      // The bytes are the customer's and the data plane owns them; a lifecycle
      // delete removes the declaration. Removing the objects too is a
      // reconciliation step, done deliberately and not inside an apply.
      return succeeded({ nativeId: input.nativeId, observed: { deleted: true }, outputs: {} });
    },

    async adopt(input): Promise<ProviderTicket> {
      const made = forKind(input.offering, input.identity);
      if (!made) return failed("not_found", "unrecognised native identity");
      return succeeded({ ...made, nativeId: input.nativeId });
    },
  };
}

/** Kinds this provider will execute. Everything else is somebody's cloud. */
export const LOCAL_KINDS: readonly string[] = ["object_bucket", "sql_database"];

/**
 * The offerings a local deployment can actually honour.
 *
 * Filtered, because a catalogue listing something no provider will execute
 * sells a resource that fails at apply — after the customer has chosen it,
 * named it, and been told the price.
 */
export function localOfferings(all: readonly ProviderOffering[]): readonly ProviderOffering[] {
  return all.filter((offering) => LOCAL_KINDS.includes(offering.kind));
}
