/** Shared event transport contract for managed and self-hosted Workers. */
export const TAKOSERVER_MANAGED_WORKER_EVENT_PROTOCOL =
  "takoserver.managed-worker-event@v1" as const;
export const TAKOSERVER_MANAGED_WORKER_EVENT_PATH =
  "/.well-known/takoserver/managed-worker-events/v1" as const;
export const TAKOSERVER_MANAGED_WORKER_EVENT_CONTENT_TYPE =
  "application/vnd.takoserver.managed-worker-event.v1+json" as const;
export const TAKOSERVER_MANAGED_WORKER_EVENT_RESPONSE_CONTENT_TYPE =
  "application/vnd.takoserver.managed-worker-event-response.v1+json" as const;
