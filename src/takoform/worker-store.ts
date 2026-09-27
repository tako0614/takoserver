/**
 * Worker-safe Host persistence and build-pinned catalog composition. Importing
 * these through the root barrel also resolves the Bun/self-host adapters.
 * This subpath adds no store, admission policy, or runtime authority of its own.
 */
export {
  type StableProductionTakoformCatalog,
  stableProductionTakoformCatalog,
} from "./stable-production-catalog.ts";
export { createTakoformStore, type TakoformStore } from "./store.ts";
