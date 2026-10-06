import { createTakoformV2Engine } from "./engine.ts";
import { createTakoformV2Routes, type TakoformV2HttpOptions } from "./routes.ts";
import type { V2EngineOptions } from "./types.ts";

/**
 * One explicit Form map and one durable authority for the v2 wire and executor.
 * Embedders must schedule runNext independently; reads never dispatch work.
 * This constructor does not migrate a database or replace an existing Host.
 */
export function createTakoformV2Host(options: V2EngineOptions & TakoformV2HttpOptions) {
  const engine = createTakoformV2Engine(options);
  const routes = createTakoformV2Routes(engine, options);
  return {
    fetch: routes.fetch,
    runNext: () => engine.runNext(),
  };
}
