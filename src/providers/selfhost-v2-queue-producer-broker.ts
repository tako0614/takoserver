import { Buffer } from "node:buffer";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  SELFHOST_DATA_PLANE_CONTENT_TYPE,
  SELFHOST_DATA_PLANE_PROTOCOL,
  SELFHOST_DATA_PLANE_QUEUE_PATH,
} from "./selfhost-worker-wrapper.ts";

const UID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const BINDING = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/u;
const MAX_TOKEN_LENGTH = 32_768;
const MAX_REQUEST_BYTES = 18 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 127_000;

export interface V2QueueProducerBindingGrant {
  readonly principal: string;
  readonly space: string;
  readonly targetKey: string;
  readonly workerUid: string;
  readonly workerVersionUid: string;
  readonly workerVersionOperationId: string;
  readonly nativeVersionId: string;
  readonly incarnationId: string;
  readonly servingSourceOperationId: string;
  readonly bindings: readonly { readonly name: string; readonly resourceUid: string }[];
}

export interface V2QueueProducerBindingResolution {
  readonly identity: {
    readonly principal: string;
    readonly space: string;
    readonly targetKey: string;
    readonly resourceUid: string;
  };
  readonly target: {
    readonly queueId: string;
    readonly messageRetentionSeconds: number;
    readonly deliveryDelaySeconds: number;
  };
  readonly vector: string;
}

export interface SelfhostV2QueueProducerBrokerOptions {
  readonly custody: {
    admitV2Batch(input: {
      readonly claim: {
        readonly principal: string;
        readonly space: string;
        readonly targetKey: string;
        readonly queueUid: string;
        readonly workerUid: string;
        readonly workerVersionUid: string;
        readonly workerVersionOperationId: string;
        readonly bindingName: string;
      };
      readonly target: V2QueueProducerBindingResolution["target"];
      readonly messages: readonly {
        readonly messageId: string;
        readonly body: Uint8Array;
        readonly delaySeconds?: number;
      }[];
    }): Promise<boolean>;
  };
  readonly targetKey: string;
  readonly signingKey: Uint8Array;
  readonly observeVersionTarget: (input: {
    readonly workerUid: string;
    readonly versionId: string;
    readonly incarnationId: string;
    readonly servingSourceOperationId: string;
  }) => Promise<
    | {
        readonly kind: "confirmed";
        readonly workerUid: string;
        readonly versionId: string;
        readonly incarnationId: string;
        readonly servingSourceOperationId: string;
        readonly status: "active" | "draining";
      }
    | { readonly kind: "unknown" }
  >;
  readonly resolveCurrentBinding: (
    grant: V2QueueProducerBindingGrant,
    binding: string,
  ) => Promise<V2QueueProducerBindingResolution | null>;
}

/** Private-only producer endpoint. Neither URL nor bearer is a public Form interface. */
export function createSelfhostV2QueueProducerBroker(options: SelfhostV2QueueProducerBrokerOptions) {
  if (
    !options?.custody ||
    !options.targetKey ||
    !(options.signingKey instanceof Uint8Array) ||
    options.signingKey.byteLength < 32 ||
    typeof options.observeVersionTarget !== "function" ||
    typeof options.resolveCurrentBinding !== "function"
  )
    throw new TypeError("private Queue producer authority is required");
  const key = Buffer.from(options.signingKey);

  function issueGrant(input: V2QueueProducerBindingGrant): string {
    const grant = checkedGrant(input, options.targetKey);
    const payload = Buffer.from(JSON.stringify(grant)).toString("base64url");
    const signature = createHmac("sha256", key).update(payload).digest("base64url");
    return `${payload}.${signature}`;
  }

  function authenticate(request: Request): V2QueueProducerBindingGrant | null {
    const header = request.headers.get("authorization");
    if (!header?.startsWith("Bearer ") || header.length > MAX_TOKEN_LENGTH) return null;
    const [payload, offered, ...extra] = header.slice(7).split(".");
    if (!payload || !offered || extra.length || !/^[A-Za-z0-9_-]+$/u.test(payload)) return null;
    try {
      const bytes = Buffer.from(payload, "base64url");
      const signature = Buffer.from(offered, "base64url");
      const expected = createHmac("sha256", key).update(payload).digest();
      if (
        bytes.toString("base64url") !== payload ||
        signature.length !== expected.length ||
        signature.toString("base64url") !== offered ||
        !timingSafeEqual(signature, expected)
      )
        return null;
      return checkedGrant(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        options.targetKey,
      );
    } catch {
      return null;
    }
  }

  async function resolveCurrent(
    grant: V2QueueProducerBindingGrant,
    binding: string,
  ): Promise<V2QueueProducerBindingResolution | null> {
    const selected = grant.bindings.find((item) => item.name === binding);
    if (!selected) return null;
    const native = await options.observeVersionTarget({
      workerUid: grant.workerUid,
      versionId: grant.nativeVersionId,
      incarnationId: grant.incarnationId,
      servingSourceOperationId: grant.servingSourceOperationId,
    });
    if (
      native.kind !== "confirmed" ||
      native.workerUid !== grant.workerUid ||
      native.versionId !== grant.nativeVersionId ||
      native.incarnationId !== grant.incarnationId ||
      native.servingSourceOperationId !== grant.servingSourceOperationId ||
      (native.status !== "active" && native.status !== "draining")
    )
      return null;
    const resolution = await options.resolveCurrentBinding(grant, binding);
    if (
      !resolution ||
      resolution.identity.principal !== grant.principal ||
      resolution.identity.space !== grant.space ||
      resolution.identity.targetKey !== grant.targetKey ||
      resolution.identity.resourceUid !== selected.resourceUid ||
      resolution.target.queueId !== `takoform-v2-queue:${selected.resourceUid}` ||
      typeof resolution.vector !== "string" ||
      resolution.vector.length === 0
    )
      return null;
    return resolution;
  }

  async function handle(request: Request): Promise<Response | null> {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return null;
    }
    if (url.pathname !== SELFHOST_DATA_PLANE_QUEUE_PATH) return null;
    if (request.method !== "POST") return refusal("backend_unavailable", 405);
    const grant = authenticate(request);
    if (!grant) return refusal("backend_unavailable", 401);
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(await boundedBody(request)),
      );
    } catch {
      return refusal("backend_unavailable", 400);
    }
    if (
      !record(input) ||
      input.protocol !== SELFHOST_DATA_PLANE_PROTOCOL ||
      typeof input.binding !== "string" ||
      (input.op !== "send" && input.op !== "sendBatch") ||
      Object.keys(input).some(
        (key) => !["binding", "body", "delaySeconds", "messages", "op", "protocol"].includes(key),
      ) ||
      (input.op === "send"
        ? typeof input.body !== "string" || input.messages !== undefined
        : input.body !== undefined || input.delaySeconds !== undefined)
    ) {
      return refusal("backend_unavailable", 400);
    }
    const parsed = parseMessages(input);
    if (parsed.error) return refusal(parsed.error, 200);
    const messages = parsed.messages;
    try {
      const current = await resolveCurrent(grant, input.binding);
      if (!current) return refusal("backend_unavailable", 200);
      const selected = grant.bindings.find((item) => item.name === input.binding);
      if (!selected) return refusal("backend_unavailable", 200);
      const accepted = await options.custody.admitV2Batch({
        claim: {
          principal: grant.principal,
          space: grant.space,
          targetKey: grant.targetKey,
          queueUid: selected.resourceUid,
          workerUid: grant.workerUid,
          workerVersionUid: grant.workerVersionUid,
          workerVersionOperationId: grant.workerVersionOperationId,
          bindingName: selected.name,
        },
        target: current.target,
        messages,
      });
      if (!accepted) return refusal("backend_unavailable", 200);
      // IDs are generated before admission and returned in input order only after commit.
      return success(
        input.op === "send"
          ? { messageId: messages[0]?.messageId }
          : { messageIds: messages.map((message) => message.messageId) },
      );
    } catch {
      return refusal("backend_unavailable", 200);
    }
  }
  return Object.freeze({ issueGrant, handle });
}

type Parsed =
  | {
      readonly messages: readonly { messageId: string; body: Uint8Array; delaySeconds?: number }[];
      readonly error?: never;
    }
  | {
      readonly messages?: never;
      readonly error: "invalid_body" | "message_too_large" | "batch_too_large";
    };
function parseMessages(input: Record<string, unknown>): Parsed {
  const raw =
    input.op === "send"
      ? [
          {
            body: input.body,
            ...(input.delaySeconds === undefined ? {} : { delaySeconds: input.delaySeconds }),
          },
        ]
      : input.messages;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 100)
    return { error: "batch_too_large" };
  const messages: { messageId: string; body: Uint8Array; delaySeconds?: number }[] = [];
  for (const item of raw) {
    if (
      !record(item) ||
      Object.keys(item).some((key) => !["body", "delaySeconds"].includes(key)) ||
      typeof item.body !== "string"
    )
      return { error: "invalid_body" };
    const body = Buffer.from(item.body, "base64");
    if (body.toString("base64") !== item.body) return { error: "invalid_body" };
    if (body.byteLength > MAX_MESSAGE_BYTES) return { error: "message_too_large" };
    if (
      item.delaySeconds !== undefined &&
      (typeof item.delaySeconds !== "number" ||
        !Number.isSafeInteger(item.delaySeconds) ||
        item.delaySeconds < 0 ||
        item.delaySeconds > 43_200)
    )
      return { error: "invalid_body" };
    messages.push({
      messageId: randomUUID(),
      body: Uint8Array.from(body),
      ...(item.delaySeconds === undefined ? {} : { delaySeconds: item.delaySeconds }),
    });
  }
  return { messages };
}

function checkedGrant(input: unknown, targetKey: string): V2QueueProducerBindingGrant {
  if (
    !record(input) ||
    Object.keys(input).sort().join(",") !==
      "bindings,incarnationId,nativeVersionId,principal,servingSourceOperationId,space,targetKey,workerUid,workerVersionOperationId,workerVersionUid"
  ) {
    throw new TypeError("invalid Queue producer grant");
  }
  for (const field of [
    "principal",
    "space",
    "targetKey",
    "workerUid",
    "workerVersionUid",
    "workerVersionOperationId",
    "nativeVersionId",
    "incarnationId",
    "servingSourceOperationId",
  ] as const) {
    if (typeof input[field] !== "string" || input[field].length < 1 || input[field].length > 256)
      throw new TypeError("invalid Queue producer grant identity");
  }
  for (const field of [
    "workerUid",
    "workerVersionUid",
    "workerVersionOperationId",
    "servingSourceOperationId",
  ] as const) {
    if (!UID.test(input[field] as string)) throw new TypeError("invalid Queue producer grant UID");
  }
  if (
    input.targetKey !== targetKey ||
    !Array.isArray(input.bindings) ||
    input.bindings.length < 1 ||
    input.bindings.length > 64
  )
    throw new TypeError("invalid Queue producer grant bindings");
  const names = new Set<string>();
  const bindings = input.bindings.map((item) => {
    if (
      !record(item) ||
      Object.keys(item).sort().join(",") !== "name,resourceUid" ||
      typeof item.name !== "string" ||
      !BINDING.test(item.name) ||
      typeof item.resourceUid !== "string" ||
      !UID.test(item.resourceUid) ||
      names.has(item.name)
    )
      throw new TypeError("invalid Queue producer grant entry");
    names.add(item.name);
    return { name: item.name, resourceUid: item.resourceUid };
  });
  bindings.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    principal: input.principal as string,
    space: input.space as string,
    targetKey: input.targetKey as string,
    workerUid: input.workerUid as string,
    workerVersionUid: input.workerVersionUid as string,
    workerVersionOperationId: input.workerVersionOperationId as string,
    nativeVersionId: input.nativeVersionId as string,
    incarnationId: input.incarnationId as string,
    servingSourceOperationId: input.servingSourceOperationId as string,
    bindings,
  };
}

async function boundedBody(request: Request): Promise<Uint8Array> {
  if (!request.body) throw new TypeError("missing body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > MAX_REQUEST_BYTES) {
      void reader.cancel().catch(() => undefined);
      throw new TypeError("body too large");
    }
    chunks.push(next.value);
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function success(value: unknown): Response {
  return Response.json(
    { ok: true, value },
    { status: 200, headers: { "content-type": SELFHOST_DATA_PLANE_CONTENT_TYPE } },
  );
}
function refusal(code: string, status: number): Response {
  return Response.json(
    { ok: false, error: { code } },
    { status, headers: { "content-type": SELFHOST_DATA_PLANE_CONTENT_TYPE } },
  );
}
