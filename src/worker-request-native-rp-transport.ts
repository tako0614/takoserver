import { captureAuth103NativeRpTransportInputs } from "./auth103-native-origin-source.ts";
import { base64UrlDecode, base64UrlEncode } from "./json.ts";
import {
  assertWorkerRequestBackingOrigin,
  captureWorkerSharedAuthStaging,
  type WorkerRequestSql,
  type WorkerSharedAuthStaging,
} from "./worker-request-composition.ts";
import { createWorkerRequestSharedRpOriginalPrincipalProjection } from "./worker-request-shared-principal-issuance.ts";

/** Transport key DATA only. This decoder grants no request or issuer authority. */
export function decodeAuth103RpSessionEncryptionKey(value: unknown): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value))
    throw new TypeError("selected RP transport is unavailable");
  const decoded = base64UrlDecode(value);
  if (decoded === null || decoded.byteLength !== 32 || base64UrlEncode(decoded) !== value)
    throw new TypeError("selected RP transport is unavailable");
  return Uint8Array.from(decoded);
}

/**
 * The default selected entry obtains dedicated transport bytes from the actual
 * startup platform environment. The original Root projection is static, never
 * an option callback. Native registration is checked by the subsequent ONE
 * common-graph constructor; these transport values are not permission.
 */
export async function captureWorkerRequestNativeRpTransport(
  connection: WorkerRequestSql,
): Promise<WorkerSharedAuthStaging> {
  assertWorkerRequestBackingOrigin(connection);
  const transport = await captureAuth103NativeRpTransportInputs();
  assertWorkerRequestBackingOrigin(connection);
  const secret = Object.getOwnPropertyDescriptor(transport, "clientSecret");
  const key = Object.getOwnPropertyDescriptor(transport, "sessionEncryptionKey");
  if (
    !secret ||
    !("value" in secret) ||
    typeof secret.value !== "string" ||
    secret.value.length === 0 ||
    !key ||
    !("value" in key)
  )
    throw new TypeError("selected RP transport is unavailable");
  const selected = captureWorkerSharedAuthStaging({
    kind: "shared-auth-staging-v1",
    clientSecret: secret.value,
    encryptionKey: decodeAuth103RpSessionEncryptionKey(key.value),
    principals: createWorkerRequestSharedRpOriginalPrincipalProjection(connection),
  });
  assertWorkerRequestBackingOrigin(connection);
  return selected;
}
