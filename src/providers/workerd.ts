import {
  type ApplyInput,
  failed,
  type Provider,
  type ProviderOffering,
  type ProviderTicket,
  succeeded,
} from "../provider-port.ts";

/**
 * Running a customer's Worker on this machine.
 *
 * The same runtime Cloudflare runs at the edge, started as a local process
 * against a configuration this generates. That is what makes a self-hosted
 * deployment a PaaS rather than a place to keep files: the whole point of
 * declaring a WorkerScript is that something serves it afterwards.
 *
 * The design is deliberately dull. Every published script is a directory of
 * modules under the data root and an entry in one generated config; workerd
 * watches that config and reloads itself. There is no orchestrator, no
 * per-worker process, and nothing to keep in sync — the config *is* the state,
 * rewritten from what the store already knows, so a restart converges by
 * reading rather than by remembering.
 *
 * Requests reach the right script through a hostname map, because that is the
 * only routing a customer ever declared. A hostname nobody claimed is refused
 * rather than sent to whichever script happens to be first: serving one
 * customer's site from another's address is worse than serving nothing.
 *
 * What this does not do is isolate a tenant from the machine. workerd isolates
 * scripts from each other, and that is a real boundary, but a self-hosted
 * operator is running code they accepted on hardware they own. Saying so here
 * is more useful than a comment claiming a guarantee nobody checked.
 */

export interface WorkerdSite {
  /** Directory holding this script's modules. */
  readonly directory: string;
  readonly mainModule: string;
  readonly hostnames: readonly string[];
  /**
   * How the asset layer answers a path that matches no file, when the script
   * declared assets. Absent means it declared none.
   */
  readonly assets?: { readonly notFoundHandling: string };
}

export interface WorkerdRuntime {
  /** Makes a published script's files present, replacing whatever was there. */
  write(
    name: string,
    site: WorkerdSite,
    modules: ReadonlyMap<string, Uint8Array>,
    assets?: ReadonlyMap<string, Uint8Array>,
  ): Promise<void>;
  /** Forgets a script and its files. */
  remove(name: string): Promise<void>;
  /** Rewrites the configuration from every script currently published. */
  reload(): Promise<void>;
  /** Whether a script is present, for `observe`. */
  has(name: string): Promise<boolean>;
}

export interface WorkerdProviderOptions {
  readonly id?: string;
  readonly offerings: readonly ProviderOffering[];
  readonly runtime: WorkerdRuntime;
  /** Reads a committed bundle. The same seam the Cloudflare provider uses. */
  readonly artifacts: {
    manifest(
      tenantRef: string,
      digest: string,
    ): Promise<{
      readonly kind: string;
      readonly mainModule?: string;
      readonly modules?: readonly { readonly name: string; readonly digest: string }[];
      readonly files?: readonly {
        readonly name: string;
        readonly digest: string;
        readonly mediaType?: string;
      }[];
    } | null>;
    blob(digest: string): Promise<Uint8Array | null>;
  };
  /** Hostname suffixes this deployment will serve. Empty means any. */
  readonly suffixes?: readonly string[];
}

export function createWorkerdProvider(options: WorkerdProviderOptions): Provider {
  const { runtime, artifacts } = options;

  const scriptName = (identity: ApplyInput["identity"]): string =>
    `${identity.tenantRef}-${identity.space}-${identity.name}`
      .replace(/[^A-Za-z0-9_-]/gu, "_")
      .toLowerCase();

  const serves = (hostname: string): boolean => {
    const suffixes = options.suffixes ?? [];
    if (suffixes.length === 0) return true;
    return suffixes.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
  };

  return {
    id: options.id ?? "workerd",
    offerings: structuredClone(options.offerings) as ProviderOffering[],

    async apply(input): Promise<ProviderTicket> {
      if (input.offering.kind !== "worker_script") {
        return failed("invalid_spec", "this provider runs Workers and nothing else");
      }
      const bundleDigest = typeof input.spec.bundle === "string" ? input.spec.bundle : null;
      if (!bundleDigest) return failed("invalid_spec", "a bundle digest is required");

      const manifest = await artifacts.manifest(input.identity.tenantRef, bundleDigest);
      if (!manifest || manifest.kind !== "WorkerBundle") {
        return failed("invalid_spec", "the declared bundle is not a committed WorkerBundle");
      }
      const mainModule = manifest.mainModule;
      const declared = manifest.modules ?? [];
      if (!mainModule || declared.length === 0) {
        return failed("invalid_spec", "the bundle declares no modules");
      }

      const hostnames = Array.isArray(input.spec.hostnames)
        ? input.spec.hostnames.filter((entry): entry is string => typeof entry === "string")
        : [];
      for (const hostname of hostnames) {
        if (!serves(hostname)) {
          return failed(
            "invalid_spec",
            `this deployment does not serve ${hostname}; it answers only for the suffixes it was configured with`,
          );
        }
      }

      const modules = new Map<string, Uint8Array>();
      for (const module of declared) {
        const bytes = await artifacts.blob(module.digest);
        // A module the store cannot produce would become a script that fails
        // to start, some time later, for reasons nothing connects to this.
        if (!bytes) return failed("invalid_spec", `a declared module is missing: ${module.name}`);
        modules.set(module.name, bytes);
      }

      // A site is the ordinary case, not an extra: a Worker that declares
      // assets and is served without them answers every path with its script,
      // which for anything with client-side routing means a blank page.
      const declaredAssets =
        typeof input.spec.assets === "object" && input.spec.assets !== null
          ? (input.spec.assets as { bundle?: unknown; notFoundHandling?: unknown })
          : null;
      let assets: Map<string, Uint8Array> | undefined;
      let notFoundHandling = "single-page-application";
      if (declaredAssets) {
        const digest = typeof declaredAssets.bundle === "string" ? declaredAssets.bundle : null;
        if (!digest) return failed("invalid_spec", "an asset bundle digest is required");
        const bundle = await artifacts.manifest(input.identity.tenantRef, digest);
        if (!bundle || bundle.kind !== "StaticAssetBundle") {
          return failed(
            "invalid_spec",
            "the declared assets are not a committed StaticAssetBundle",
          );
        }
        const files = bundle.files ?? [];
        if (files.length === 0) return failed("invalid_spec", "the asset bundle declares no files");
        assets = new Map<string, Uint8Array>();
        for (const file of files) {
          const bytes = await artifacts.blob(file.digest);
          if (!bytes) return failed("invalid_spec", `a declared asset is missing: ${file.name}`);
          assets.set(file.name, bytes);
        }
        if (typeof declaredAssets.notFoundHandling === "string") {
          notFoundHandling = declaredAssets.notFoundHandling;
        }
      }

      const name = scriptName(input.identity);
      await runtime.write(
        name,
        {
          directory: name,
          mainModule,
          hostnames,
          ...(assets ? { assets: { notFoundHandling } } : {}),
        },
        modules,
        assets,
      );
      await runtime.reload();

      return succeeded({
        nativeId: `workerd:${name}`,
        observed: {
          name,
          mainModule,
          moduleCount: modules.size,
          hostnames,
          ...(assets ? { assetCount: assets.size } : {}),
        },
        outputs: {
          scriptName: name,
          hostnames,
          ...(hostnames[0] ? { url: `http://${hostnames[0]}` } : {}),
        },
      });
    },

    async observe(input): Promise<ProviderTicket> {
      const name = input.nativeId.startsWith("workerd:")
        ? input.nativeId.slice("workerd:".length)
        : null;
      if (!name) return failed("not_found", "unrecognised native identity");
      if (!(await runtime.has(name))) return failed("not_found", "the script is not published");
      return succeeded({
        nativeId: input.nativeId,
        observed: { name, present: true },
        outputs: { scriptName: name },
      });
    },

    async delete(input): Promise<ProviderTicket> {
      const name = input.nativeId.startsWith("workerd:")
        ? input.nativeId.slice("workerd:".length)
        : null;
      if (!name) return failed("not_found", "unrecognised native identity");
      await runtime.remove(name);
      await runtime.reload();
      return succeeded({ nativeId: input.nativeId, observed: { deleted: true }, outputs: {} });
    },
  };
}
