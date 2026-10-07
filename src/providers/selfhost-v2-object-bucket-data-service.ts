import {
  MAX_SELFHOST_OBJECT_DOCUMENT_BYTES,
  SELFHOST_DATA_PLANE_CONTENT_TYPE,
  SELFHOST_DATA_PLANE_MAX_RESPONSE_BYTES,
  SELFHOST_DATA_PLANE_OBJECT_CONTENT_TYPE,
  SELFHOST_DATA_PLANE_OBJECT_REQUEST_HEADER,
  SELFHOST_DATA_PLANE_OBJECT_RESULT_HEADER,
  SELFHOST_V2_OBJECT_BUCKET_BINDING_ORIGIN,
  SELFHOST_V2_OBJECT_BUCKET_BINDING_PATH,
  SELFHOST_V2_OBJECT_MULTIPART_PARTS_CONTENT_TYPE,
} from "./selfhost-worker-wrapper.ts";
import {
  WORKERD_V2_PRIVATE_OBJECT_BUCKET_ORIGIN_BINDING,
  WORKERD_V2_PRIVATE_OBJECT_BUCKET_TOKEN_BINDING,
} from "./workerd-v2-private-binding-names.ts";

export const SELFHOST_V2_OBJECT_BUCKET_DATA_SERVICE_MODULE =
  "__takoserver-selfhost-v2-object-bucket.js" as const;

/** The per-Version service holds one exact signed grant and only reaches its private object route. */
export function selfhostV2ObjectBucketDataServiceSource(): string {
  return `const PATH = ${JSON.stringify(SELFHOST_V2_OBJECT_BUCKET_BINDING_PATH)};
const ORIGIN = ${JSON.stringify(SELFHOST_V2_OBJECT_BUCKET_BINDING_ORIGIN)};
const PLANE = ${JSON.stringify(WORKERD_V2_PRIVATE_OBJECT_BUCKET_ORIGIN_BINDING)};
const TOKEN = ${JSON.stringify(WORKERD_V2_PRIVATE_OBJECT_BUCKET_TOKEN_BINDING)};
const REQUEST = ${JSON.stringify(SELFHOST_DATA_PLANE_OBJECT_REQUEST_HEADER)};
const RESULT = ${JSON.stringify(SELFHOST_DATA_PLANE_OBJECT_RESULT_HEADER)};
const BODY = ${JSON.stringify(SELFHOST_DATA_PLANE_OBJECT_CONTENT_TYPE)};
const JSON_BODY = ${JSON.stringify(SELFHOST_DATA_PLANE_CONTENT_TYPE)};
const PARTS = ${JSON.stringify(SELFHOST_V2_OBJECT_MULTIPART_PARTS_CONTENT_TYPE)};
const MAX_DOCUMENT = ${MAX_SELFHOST_OBJECT_DOCUMENT_BYTES};
const MAX_RESPONSE = ${SELFHOST_DATA_PLANE_MAX_RESPONSE_BYTES};

function refuse(status) {
  return new Response('{"ok":false,"error":{"code":"backend_unavailable"}}', {
    status,
    headers: { "content-type": "application/json" },
  });
}

export default {
  async fetch(request, env) {
    let url;
    try { url = new URL(request.url); } catch { return refuse(404); }
    if (url.pathname !== PATH || request.method !== "POST") return refuse(404);
    const token = env[TOKEN];
    const plane = env[PLANE];
    const document = request.headers.get(REQUEST);
    const requestType = request.headers.get("content-type");
    if (typeof token !== "string" || token.length === 0 || token.length > 32768 || !plane) {
      return refuse(503);
    }
    if (
      typeof document !== "string" || document.length === 0 || document.length > MAX_DOCUMENT ||
      (requestType !== null && requestType !== BODY && requestType !== PARTS)
    ) return refuse(400);

    const headers = {
      authorization: "Bearer " + token,
      "content-type": requestType === PARTS ? PARTS : BODY,
    };
    headers[REQUEST] = document;
    let response;
    try {
      const init = { method: "POST", headers };
      if (request.body) {
        init.body = request.body;
      }
      response = await plane.fetch(ORIGIN + PATH, init);
    } catch {
      return refuse(502);
    }

    if (response.headers.get("content-type") === BODY) {
      const result = response.headers.get(RESULT);
      if (typeof result !== "string" || result.length === 0 || result.length > MAX_DOCUMENT) {
        return refuse(502);
      }
      const answerHeaders = { "content-type": BODY };
      answerHeaders[RESULT] = result;
      return new Response(response.body, { status: response.status, headers: answerHeaders });
    }
    if (response.headers.get("content-type") !== JSON_BODY) return refuse(502);
    let text;
    try { text = await response.text(); } catch { return refuse(502); }
    if (text.length > MAX_RESPONSE) return refuse(502);
    return new Response(text, {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  },
};
`;
}
