import { runInNewContext } from "node:vm";
import type { resolveActorAbiProfile } from "../../src/actor-class-execution.ts";
import type {
  createActorNativeOwner,
  createActorNativeSocketPort,
} from "../../src/actor-native-owner-worker.ts";
import { ACTOR_NATIVE_BOOTSTRAP_SOURCE } from "../../src/generated/actor-native-bootstrap.ts";

interface ActorNativeRealm {
  readonly createActorNativeOwner: typeof createActorNativeOwner;
  readonly createActorNativeSocketPort: typeof createActorNativeSocketPort;
  readonly resolveActorAbiProfile: typeof resolveActorAbiProfile;
}

/** The deliberate native constructor exists before the trusted bundle loads. */
export function actorNativeBundleRealm(nativeWebSocket: {
  readonly prototype: { close(code?: number, reason?: string): void };
}): ActorNativeRealm {
  const exports = /\nexport \{\n(?: {2}[A-Za-z][A-Za-z0-9]*,?\n)+\};\n?$/u.exec(
    ACTOR_NATIVE_BOOTSTRAP_SOURCE,
  );
  if (!exports || exports.index === undefined)
    throw new Error("unexpected native bootstrap export syntax");
  // Remove only ESM's export statement; all evaluated implementation bytes are
  // the formal artifact. Each fixture gets its own globals and profile brands.
  return runInNewContext(
    `${ACTOR_NATIVE_BOOTSTRAP_SOURCE.slice(0, exports.index)}
({ createActorNativeOwner, createActorNativeSocketPort, resolveActorAbiProfile });`,
    {
      WebSocket: nativeWebSocket,
      Headers,
      Request,
      Response,
      ReadableStream,
      crypto,
      TextEncoder,
      TextDecoder,
      Uint8Array,
      ArrayBuffer,
      AbortController,
      AbortSignal,
      DOMException,
      setTimeout,
      clearTimeout,
      atob,
      btoa,
    },
    { timeout: 1_000 },
  ) as ActorNativeRealm;
}
