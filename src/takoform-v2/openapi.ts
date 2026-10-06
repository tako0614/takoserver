/** Documentation of this implementation, not a second normative Takoform specification. */
const object = { type: "object", additionalProperties: true } as const;
const identifier = {
  type: "string",
  pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
} as const;
const formUrl = { type: "string", format: "uri", description: "Exact versioned HTTPS Form URL." };
const generation = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER } as const;
const ref = (name: string) => ({ $ref: `#/components/schemas/TakoformV2${name}` });
const json = (schema: unknown) => ({ "application/json": { schema } });
const problem = {
  description: "Request refused; code classifies the failure without provider or secret payloads.",
  content: { "application/problem+json": { schema: ref("Problem") } },
};
const idempotency = {
  in: "header",
  name: "Idempotency-Key",
  required: true,
  description: "Unique operation key shared by the organization's credentials.",
  schema: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$" },
};
const expectedGeneration = {
  in: "header",
  name: "Takoform-Expected-Generation",
  required: true,
  schema: { type: "string", pattern: "^[1-9][0-9]*$" },
};
const organization = {
  in: "header",
  name: "Takoform-Organization",
  required: false,
  description:
    "Required for an owner session. An API key uses its authenticated organization, never this header.",
  schema: identifier,
};
const uid = { in: "path", name: "uid", required: true, schema: identifier };
const operationResponses = {
  "200": {
    description:
      "Replay of a terminal Operation, including failed Operations; inspect status and effect.",
    headers: { Location: { schema: { type: "string", format: "uri" } } },
    content: json(ref("Operation")),
  },
  "202": {
    description:
      "Operation durably accepted or still pending; this does not mean the effect succeeded.",
    headers: {
      Location: { schema: { type: "string", format: "uri" } },
      "Retry-After": { schema: { type: "string" } },
    },
    content: json(ref("Operation")),
  },
  default: problem,
};
const body = (schema: unknown) => ({ required: true, content: json(schema) });

export const TAKOFORM_V2_SCHEMAS = {
  TakoformV2Problem: {
    type: "object",
    required: ["type", "title", "status", "code"],
    additionalProperties: false,
    properties: {
      type: { const: "about:blank" },
      title: { type: "string" },
      status: { type: "integer", minimum: 400, maximum: 599 },
      code: { type: "string" },
    },
  },
  TakoformV2Resource: {
    type: "object",
    required: [
      "uid",
      "form",
      "space",
      "name",
      "generation",
      "observedGeneration",
      "observedAt",
      "phase",
      "spec",
      "observed",
      "output",
      "lastOperation",
    ],
    additionalProperties: false,
    properties: {
      uid: identifier,
      form: formUrl,
      space: identifier,
      name: identifier,
      generation,
      observedGeneration: { ...generation, minimum: 0 },
      observedAt: { type: ["string", "null"], format: "date-time" },
      phase: { enum: ["pending", "idle", "deleting", "error"] },
      spec: object,
      observed: object,
      output: object,
      lastOperation: identifier,
    },
  },
  TakoformV2Operation: {
    type: "object",
    required: [
      "id",
      "resourceUid",
      "action",
      "generation",
      "status",
      "effect",
      "createdAt",
      "updatedAt",
      "retainUntil",
    ],
    additionalProperties: false,
    properties: {
      id: identifier,
      resourceUid: identifier,
      action: { enum: ["create", "update", "delete"] },
      generation,
      status: {
        enum: ["queued", "running", "waiting_input", "reconciling", "succeeded", "failed"],
      },
      effect: { enum: ["none", "unknown", "partial", "complete"] },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
      retainUntil: { type: "string", format: "date-time" },
      error: {
        type: "object",
        required: ["code", "message"],
        additionalProperties: false,
        properties: { code: { type: "string" }, message: { type: "string" } },
      },
    },
  },
};

/** Only implemented required operations; disabled optional capabilities are not advertised. */
export const TAKOFORM_V2_OPERATIONS: Readonly<Record<string, Record<string, unknown>>> = {
  takoformReadSupport: {
    summary: "Check implementation support for one exact Form URL",
    parameters: [organization, { in: "query", name: "form", required: true, schema: formUrl }],
    responses: {
      "200": {
        description:
          "Technical support only; not authorization, capacity, or a guarantee of creation.",
        content: json({
          type: "object",
          required: ["form", "supported", "operations", "privateInputs"],
          additionalProperties: false,
          properties: {
            form: formUrl,
            supported: { type: "boolean" },
            operations: { type: "array", items: { enum: ["create", "read", "update", "delete"] } },
            privateInputs: { const: false },
          },
        }),
      },
      default: problem,
    },
  },
  takoformListResources: {
    summary: "List resources visible to this organization",
    parameters: [
      organization,
      ...["space", "name"].map((name) => ({ in: "query", name, schema: identifier })),
      { in: "query", name: "form", schema: formUrl },
      { in: "query", name: "limit", schema: { type: "integer", minimum: 1 } },
      { in: "query", name: "cursor", schema: { type: "string" } },
    ],
    responses: {
      "200": {
        description: "Page from durable state; reading does not dispatch operations.",
        content: json({
          type: "object",
          required: ["items", "nextCursor"],
          additionalProperties: false,
          properties: {
            items: { type: "array", items: ref("Resource") },
            nextCursor: { type: ["string", "null"] },
          },
        }),
      },
      default: problem,
    },
  },
  takoformCreateResource: {
    summary: "Accept creation of a resource and return its Operation",
    parameters: [organization, idempotency],
    requestBody: body({
      type: "object",
      required: ["form", "space", "name", "spec"],
      additionalProperties: false,
      properties: { form: formUrl, space: identifier, name: identifier, spec: object },
    }),
    responses: operationResponses,
  },
  takoformReadResource: {
    summary: "Read durable resource state without executing an operation",
    parameters: [organization, uid],
    responses: {
      "200": { description: "Current resource state.", content: json(ref("Resource")) },
      "410": { ...problem, description: "The resource was deleted and its tombstone is retained." },
      default: problem,
    },
  },
  takoformUpdateResource: {
    summary: "Accept a replacement spec at the expected resource generation",
    parameters: [organization, uid, idempotency, expectedGeneration],
    requestBody: body({
      type: "object",
      required: ["spec"],
      additionalProperties: false,
      properties: { spec: object },
    }),
    responses: operationResponses,
  },
  takoformDeleteResource: {
    summary: "Accept deletion at the expected generation; no request body",
    parameters: [organization, uid, idempotency, expectedGeneration],
    responses: operationResponses,
  },
  takoformReadOperation: {
    summary: "Read an Operation without triggering execution",
    parameters: [
      organization,
      { in: "path", name: "operationId", required: true, schema: identifier },
    ],
    responses: {
      "200": {
        description: "Current Operation status and effect.",
        content: json(ref("Operation")),
      },
      default: problem,
    },
  },
};
