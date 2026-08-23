import type {
  InstalledTakoformForm,
  TakoformDriverReceipt,
  TakoformResourceDriver,
  TakoformStoredResource,
} from "./types.ts";
import { TakoformHostError } from "./types.ts";

/**
 * A driver that provisions nothing and reports the desired state back as
 * observed.
 *
 * It exists so the Host's own behaviour — identity, fences, review, replay,
 * projection — can be exercised without a provider in the way. It is the
 * default for embedders evaluating the API and for tests that are about the
 * protocol rather than about any backend.
 *
 * One Form obliges even a provisionless driver to answer: `WorkerEndpoint`
 * declares an outputSchema, and the engine refuses a receipt that omits what
 * the Form promised. The address a real backend would assign is minted here
 * deterministically from the resource uid, so it is complete, canonical, and
 * immutable for the lifetime of the incarnation — exactly the properties the
 * Form states — while plainly resolving to nothing (`.invalid`).
 */
export class InMemoryTakoformResourceDriver implements TakoformResourceDriver {
  readonly #nativeByResource = new Map<string, string>();
  readonly #resourceByNative = new Map<string, string>();
  readonly #migrationLedgers = new Map<
    string,
    readonly { path: string; digest: `sha256:${string}` }[]
  >();

  readonly sqliteMigrations = {
    readLedger: async (input: {
      readonly tenantId: string;
      readonly database: TakoformStoredResource;
    }) =>
      structuredClone(
        this.#migrationLedgers.get(`${input.tenantId}\0${input.database.metadata.uid}`) ?? [],
      ),
    applySuffix: async (input: {
      readonly tenantId: string;
      readonly database: TakoformStoredResource;
      readonly expectedPrefix: readonly { path: string; digest: `sha256:${string}` }[];
      readonly migrations: readonly {
        readonly path: string;
        readonly digest: `sha256:${string}`;
      }[];
    }) => {
      const key = `${input.tenantId}\0${input.database.metadata.uid}`;
      const current = this.#migrationLedgers.get(key) ?? [];
      if (
        current.length !== input.expectedPrefix.length ||
        current.some(
          (migration, index) =>
            migration.path !== input.expectedPrefix[index]?.path ||
            migration.digest !== input.expectedPrefix[index]?.digest,
        )
      ) {
        throw new TakoformHostError("migration_required", 409);
      }
      this.#migrationLedgers.set(key, [
        ...current,
        ...input.migrations.map(({ path, digest }) => ({ path, digest })),
      ]);
    },
  };

  async apply(
    input: Parameters<TakoformResourceDriver["apply"]>[0],
  ): Promise<TakoformDriverReceipt> {
    return {
      observed: structuredClone(input.spec),
      ...mintedOutputs(input.form, input.resourceUid),
    };
  }

  async observe(input: {
    readonly tenantId: string;
    readonly resource: TakoformStoredResource;
  }): Promise<TakoformDriverReceipt> {
    return {
      observed: structuredClone(input.resource.status.observed ?? input.resource.spec),
      ...(input.resource.status.outputs
        ? { outputs: structuredClone(input.resource.status.outputs) }
        : {}),
    };
  }

  async import(
    input: Parameters<NonNullable<TakoformResourceDriver["import"]>>[0],
  ): Promise<TakoformDriverReceipt> {
    const resourceKey = `${input.tenantId}\0${input.resourceUid}`;
    const nativeKey = `${input.tenantId}\0${input.nativeId}`;
    const claimedResource = this.#resourceByNative.get(nativeKey);
    const currentNative = this.#nativeByResource.get(resourceKey);
    if (
      (claimedResource !== undefined && claimedResource !== resourceKey) ||
      (currentNative !== undefined && currentNative !== nativeKey)
    ) {
      throw new TakoformHostError("import_conflict", 409);
    }
    this.#resourceByNative.set(nativeKey, resourceKey);
    this.#nativeByResource.set(resourceKey, nativeKey);
    return {
      observed: structuredClone(input.spec),
      ...mintedOutputs(input.form, input.resourceUid),
    };
  }

  async delete(input: Parameters<TakoformResourceDriver["delete"]>[0]): Promise<void> {
    const resourceKey = `${input.tenantId}\0${input.resourceUid}`;
    const nativeKey = this.#nativeByResource.get(resourceKey);
    if (nativeKey !== undefined) this.#resourceByNative.delete(nativeKey);
    this.#nativeByResource.delete(resourceKey);
  }
}

/**
 * The outputs a Form's outputSchema obliges the driver to publish.
 *
 * Only `WorkerEndpoint` declares one today: a complete HTTPS address the host
 * assigned. Deterministic hex of the resource uid keeps the address stable for
 * the incarnation and unique across incarnations, and the reserved `.invalid`
 * TLD keeps it honest — this driver runs nothing, so the address must not look
 * like it resolves.
 */
function mintedOutputs(
  form: InstalledTakoformForm,
  resourceUid: string,
): Pick<TakoformDriverReceipt, "outputs"> | Record<never, never> {
  if (!form.outputSchema || form.identity.formRef.kind !== "WorkerEndpoint") return {};
  const hex = [...new TextEncoder().encode(resourceUid)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 60);
  const hostname = `ep-${hex}.takoform.invalid`;
  return { outputs: { hostname, url: `https://${hostname}/` } };
}
