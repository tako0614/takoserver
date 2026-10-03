import { createHmac } from "node:crypto";
import type { SelfhostVersionActorBinding } from "./providers/selfhost-version-bindings.ts";

/** Derives one private facade credential from an immutable Version secret. */
export function deriveSelfhostActorForwardToken(input: {
  readonly eventToken: string;
  readonly workerVersionResourceUid: string;
  readonly binding: SelfhostVersionActorBinding;
}): string {
  const key = Buffer.from(input.eventToken, "base64url");
  if (
    key.length !== 32 ||
    key.toString("base64url") !== input.eventToken ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{2,254}$/u.test(input.workerVersionResourceUid)
  )
    throw new Error("Actor Version credential unavailable");
  const binding = input.binding;
  if (
    !binding ||
    typeof binding.name !== "string" ||
    typeof binding.tenantId !== "string" ||
    typeof binding.namespaceResourceUid !== "string"
  )
    throw new Error("Actor Version relation unavailable");
  // JSON arrays are length-delimited by the encoding and preserve field
  // boundaries even when tenant or binding names contain punctuation.
  const message = JSON.stringify([
    "takoserver.selfhost-actor-forward-token@v1",
    binding.tenantId,
    input.workerVersionResourceUid,
    binding.namespaceResourceUid,
    binding.name,
  ]);
  return createHmac("sha256", key).update(message, "utf8").digest("hex");
}
