/** This is a Host-private invocation plane, not a Host API or producer Binding. */
export const V2_QUEUE_SETTLEMENT_PATH = "/.well-known/takoserver/selfhost-queue-settlement/v2";
export const V2_QUEUE_SETTLEMENT_PROTOCOL = "takoserver.selfhost-queue-settlement@v2";
export const V2_QUEUE_SETTLEMENT_CONTENT_TYPE =
  "application/vnd.takoserver.queue-settlement.v2+json";
export const V2_QUEUE_SETTLEMENT_SERVICE_MODULE = "__takoserver-v2-queue-settlement.js";
export const V2_QUEUE_SETTLEMENT_SERVICE_BINDING = "__TAKOSERVER_V2_QUEUE_SETTLEMENT";
export const V2_QUEUE_SETTLEMENT_ORIGIN_BINDING = "__TAKOSERVER_V2_QUEUE_SETTLEMENT_ORIGIN";
export const V2_QUEUE_SETTLEMENT_TOKEN_BINDING = "__TAKOSERVER_V2_QUEUE_SETTLEMENT_TOKEN";
export const V2_QUEUE_SETTLEMENT_MAX_BYTES = 8192;
