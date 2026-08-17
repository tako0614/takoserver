import { handleTakoserverWorkerRequest } from "./worker.ts";

export default {
  async fetch(request, env): Promise<Response> {
    return await handleTakoserverWorkerRequest(request, {
      stateDb: env.STATE_DB,
      objects: env.OBJECTS,
    });
  },
} satisfies ExportedHandler<Env>;
