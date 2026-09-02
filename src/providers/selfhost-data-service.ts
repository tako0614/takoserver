import {
  MAX_SELFHOST_OBJECT_DOCUMENT_BYTES,
  SELFHOST_DATA_PLANE_CONTENT_TYPE,
  SELFHOST_DATA_PLANE_KV_PATH,
  SELFHOST_DATA_PLANE_MAX_RESPONSE_BYTES,
  SELFHOST_DATA_PLANE_OBJECT_CONTENT_TYPE,
  SELFHOST_DATA_PLANE_OBJECT_REQUEST_HEADER,
  SELFHOST_DATA_PLANE_OBJECT_RESULT_HEADER,
  SELFHOST_DATA_PLANE_OBJECTS_PATH,
  SELFHOST_DATA_PLANE_ORIGIN,
  SELFHOST_DATA_PLANE_QUEUE_PATH,
  SELFHOST_DATA_PLANE_SQL_PATH,
  SELFHOST_WORKER_DATA_TOKEN_BINDING,
} from "./selfhost-worker-wrapper.ts";

/**
 * The one isolate on this machine that holds a Worker Version's plane token.
 *
 * A binding is a property of the service it is declared on, and workerd hands
 * every binding of a service to every module that service runs — through the
 * handler's `env` and, unless the runtime is told otherwise, through
 * `cloudflare:workers` as well. Leaving the token and the plane's
 * `externalServer` on the tenant's own service therefore never hid them from
 * tenant code; it only kept them out of one object.
 *
 * So they live here instead, on a service of this Host's own, running only this
 * module. The tenant's service is given a plain service binding to it and
 * nothing else: no token, no address, and no way to name a destination. What
 * crosses that binding is a request this module rewrites completely — fixed
 * method, fixed URL, fixed headers, the tenant's JSON body and nothing more —
 * so a binding that leaked into tenant code would still reach exactly three
 * routes and could not be turned on the control API, the provisioner, or any
 * other address this machine listens on.
 *
 * The source is a constant. Nothing a tenant declares reaches it, which is what
 * makes it safe for this module to be the one holding the secret.
 *
 * The object route is the one that does not buffer. An object is up to 5 GiB
 * and reading one into an isolate to hand it on would be a ceiling nobody
 * asked for, so its body streams through in both directions and the operation
 * travels as one header this module copies verbatim and bounds. Copying is not
 * forwarding: the method, the URL, the credential, and every other header are
 * still this module's, and the one header that does cross is opaque to it and
 * validated field by field by the plane behind.
 */

/** Module name the generated data service is published under. */
export const SELFHOST_WORKER_DATA_SERVICE_MODULE = "__takoserver-selfhost-data.js" as const;

/** The `externalServer` binding this module reaches the Bun planes through. */
export const SELFHOST_WORKER_DATA_PLANE_BINDING = "__TAKOSERVER_SELFHOST_DATA_PLANE" as const;

/**
 * The whole of the facade service, as bytes.
 *
 * Written per script rather than shared because a workerd service embeds its
 * modules from its own script directory, and one file per script keeps the
 * configuration a pure function of what is on disk.
 */
export function selfhostDataServiceSource(): string {
  return `const KV_PATH = ${JSON.stringify(SELFHOST_DATA_PLANE_KV_PATH)};
const OBJECTS_PATH = ${JSON.stringify(SELFHOST_DATA_PLANE_OBJECTS_PATH)};
const OBJECTS_URL = ${JSON.stringify(`${SELFHOST_DATA_PLANE_ORIGIN}${SELFHOST_DATA_PLANE_OBJECTS_PATH}`)};
const OBJECT_REQUEST_HEADER = ${JSON.stringify(SELFHOST_DATA_PLANE_OBJECT_REQUEST_HEADER)};
const OBJECT_RESULT_HEADER = ${JSON.stringify(SELFHOST_DATA_PLANE_OBJECT_RESULT_HEADER)};
const OBJECT_CONTENT_TYPE = ${JSON.stringify(SELFHOST_DATA_PLANE_OBJECT_CONTENT_TYPE)};
const MAX_OBJECT_DOCUMENT_BYTES = ${MAX_SELFHOST_OBJECT_DOCUMENT_BYTES};
const SQL_PATH = ${JSON.stringify(SELFHOST_DATA_PLANE_SQL_PATH)};
const QUEUE_PATH = ${JSON.stringify(SELFHOST_DATA_PLANE_QUEUE_PATH)};
const KV_URL = ${JSON.stringify(`${SELFHOST_DATA_PLANE_ORIGIN}${SELFHOST_DATA_PLANE_KV_PATH}`)};
const SQL_URL = ${JSON.stringify(`${SELFHOST_DATA_PLANE_ORIGIN}${SELFHOST_DATA_PLANE_SQL_PATH}`)};
const QUEUE_URL = ${JSON.stringify(`${SELFHOST_DATA_PLANE_ORIGIN}${SELFHOST_DATA_PLANE_QUEUE_PATH}`)};
const CONTENT_TYPE = ${JSON.stringify(SELFHOST_DATA_PLANE_CONTENT_TYPE)};
const TOKEN = ${JSON.stringify(SELFHOST_WORKER_DATA_TOKEN_BINDING)};
const PLANE = ${JSON.stringify(SELFHOST_WORKER_DATA_PLANE_BINDING)};
const MAX_BYTES = ${SELFHOST_DATA_PLANE_MAX_RESPONSE_BYTES};

// Every refusal is the same closed envelope the planes themselves answer with,
// so a caller cannot tell "this Host is misconfigured" from "that is not a
// route" from "the plane said no" — and none of them carries a token, an
// address, or a diagnostic.
function refuse(status) {
  return new Response('{"ok":false,"error":{"code":"backend_unavailable"}}', {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The object route: one method, one URL, one credential, one copied header.
 *
 * The body is never read here. A 5 GiB object would otherwise have to fit in an
 * isolate twice over, and there is nothing this module could learn from the
 * bytes anyway — the operation is entirely in the header, which the plane
 * behind validates field by field.
 */
async function objects(request, env) {
  if (request.method !== "POST") return refuse(404);
  const token = env[TOKEN];
  const plane = env[PLANE];
  if (typeof token !== "string" || token.length === 0 || !plane) return refuse(503);
  const document = request.headers.get(OBJECT_REQUEST_HEADER);
  if (
    typeof document !== "string" ||
    document.length === 0 ||
    document.length > MAX_OBJECT_DOCUMENT_BYTES
  ) {
    return refuse(400);
  }
  const headers = {
    authorization: "Bearer " + token,
    "content-type": OBJECT_CONTENT_TYPE,
  };
  headers[OBJECT_REQUEST_HEADER] = document;
  let response;
  try {
    const init = { method: "POST", headers };
    if (request.body) {
      init.body = request.body;
      // workerd needs to be told the body is a stream it may forward without
      // knowing the length, which is exactly what an object body is.
      init.duplex = "half";
    }
    response = await plane.fetch(OBJECTS_URL, init);
  } catch {
    return refuse(502);
  }
  if (response.headers.get("content-type") !== OBJECT_CONTENT_TYPE) {
    // The closed JSON envelope, read under the ordinary ceiling. Nothing else
    // this plane could answer with is something a tenant may see.
    let text;
    try {
      text = await response.text();
    } catch {
      return refuse(502);
    }
    if (text.length > MAX_BYTES) return refuse(502);
    return new Response(text, {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  }
  const result = response.headers.get(OBJECT_RESULT_HEADER);
  if (typeof result !== "string" || result.length === 0 || result.length > MAX_OBJECT_DOCUMENT_BYTES) {
    return refuse(502);
  }
  // Two headers and the bytes. Every other header the plane set is this Host's
  // business rather than the tenant's.
  const answer = { "content-type": OBJECT_CONTENT_TYPE };
  answer[OBJECT_RESULT_HEADER] = result;
  return new Response(response.body, { status: response.status, headers: answer });
}

export default {
  async fetch(request, env) {
    let pathname = null;
    try {
      pathname = new URL(request.url).pathname;
    } catch {
      return refuse(404);
    }
    if (pathname === OBJECTS_PATH) return await objects(request, env);
    let target = null;
    try {
      target =
        pathname === KV_PATH
          ? KV_URL
          : pathname === SQL_PATH
            ? SQL_URL
            : pathname === QUEUE_PATH
              ? QUEUE_URL
              : null;
    } catch {
      return refuse(404);
    }
    if (target === null || request.method !== "POST") return refuse(404);
    const token = env[TOKEN];
    const plane = env[PLANE];
    if (typeof token !== "string" || token.length === 0 || !plane) return refuse(503);
    let body;
    try {
      body = await request.arrayBuffer();
    } catch {
      return refuse(400);
    }
    if (body.byteLength > MAX_BYTES) return refuse(413);
    // Rebuilt, never forwarded. The tenant chose the bytes below and nothing
    // else: not the destination, not the method, not one header.
    let response;
    try {
      response = await plane.fetch(target, {
        method: "POST",
        headers: { authorization: "Bearer " + token, "content-type": CONTENT_TYPE },
        body,
      });
    } catch {
      return refuse(502);
    }
    let text;
    try {
      text = await response.text();
    } catch {
      return refuse(502);
    }
    if (text.length > MAX_BYTES) return refuse(502);
    // The envelope only. A response header the plane set is this Host's
    // business, not the tenant's.
    return new Response(text, {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  },
};
`;
}
