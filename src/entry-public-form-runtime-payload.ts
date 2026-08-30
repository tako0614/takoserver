import { PUBLIC_FORM_RUNTIME_PAYLOAD } from "./public-form-runtime.ts";

/**
 * Build-only root for semantic Form implementation identity. It is never
 * uploaded or executed. Referencing the real runtime seam and provider adapter
 * makes Wrangler retain their executable closure in the sealed payload bytes.
 */
export const TAKOSERVER_PUBLIC_FORM_RUNTIME_PAYLOAD = Object.freeze({
  runtime: PUBLIC_FORM_RUNTIME_PAYLOAD,
});

export default {
  fetch(): Response {
    return new Response(null, { status: 404 });
  },
};
