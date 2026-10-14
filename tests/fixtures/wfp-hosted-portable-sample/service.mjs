export default {
  async fetch(request, env) {
    if (request.headers.get("x-takoserver-e2e-run") !== env.E2E_RUN_ID) {
      return Response.json({ error: "wrong_run" }, { status: 403 });
    }
    return Response.json({ runId: env.E2E_RUN_ID, revision: env.E2E_REVISION });
  },
};
