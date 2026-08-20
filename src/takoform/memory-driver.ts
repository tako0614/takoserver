import type {
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
    return { observed: structuredClone(input.spec) };
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
    return { observed: structuredClone(input.spec) };
  }

  async delete(input: Parameters<TakoformResourceDriver["delete"]>[0]): Promise<void> {
    const resourceKey = `${input.tenantId}\0${input.resourceUid}`;
    const nativeKey = this.#nativeByResource.get(resourceKey);
    if (nativeKey !== undefined) this.#resourceByNative.delete(nativeKey);
    this.#nativeByResource.delete(resourceKey);
  }
}
