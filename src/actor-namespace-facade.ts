/** Host-owned forward Actor binding facade. This module loads before tenant code. */
const NativeRequest = Request;
const SafeObjectCreate = Object.create;
const SafeObjectDefineProperty = Object.defineProperty;
const SafeObjectFreeze = Object.freeze;
const SafeReflectApply = Reflect.apply;

export interface ActorAddressingPort {
  idFromName(name: string): string;
  newUniqueId(): string;
  isValidActorId(value: unknown): boolean;
}

export interface ActorNamespaceFacade {
  idFromName(name: string): string;
  newUniqueId(): string;
  get(id: string): Readonly<{
    fetch(input: Request | string, init?: RequestInit): Promise<Response>;
  }>;
}

function fixed(target: object, name: string, value: unknown): void {
  SafeObjectDefineProperty(target, name, {
    value,
    configurable: false,
    enumerable: true,
    writable: false,
  });
}

/**
 * `invoke` is a lexical Host cap. The returned object never contains the
 * broker token, native socket, selected Version, or raw service binding.
 */
export function createActorNamespace(options: {
  readonly addressing: ActorAddressingPort;
  readonly invoke: (id: string, request: Request) => Promise<Response>;
}): ActorNamespaceFacade {
  const addressing = options.addressing;
  const invoke = options.invoke;
  if (
    !addressing ||
    typeof addressing.idFromName !== "function" ||
    typeof addressing.newUniqueId !== "function" ||
    typeof addressing.isValidActorId !== "function" ||
    typeof invoke !== "function"
  )
    throw new TypeError("Actor namespace facade unavailable");
  const idFromName = addressing.idFromName;
  const newUniqueId = addressing.newUniqueId;
  const isValidActorId = addressing.isValidActorId;
  const namespace = SafeObjectCreate(null) as ActorNamespaceFacade;
  fixed(
    namespace,
    "idFromName",
    (name: string): string => SafeReflectApply(idFromName, addressing, [name]) as string,
  );
  fixed(
    namespace,
    "newUniqueId",
    (): string => SafeReflectApply(newUniqueId, addressing, []) as string,
  );
  fixed(namespace, "get", (id: string) => {
    if (SafeReflectApply(isValidActorId, addressing, [id]) !== true)
      throw new TypeError("Actor ID is invalid");
    const stub = SafeObjectCreate(null) as ReturnType<ActorNamespaceFacade["get"]>;
    fixed(stub, "fetch", async (input: Request | string, init?: RequestInit) => {
      const request = new NativeRequest(input, init);
      return await invoke(id, request);
    });
    return SafeObjectFreeze(stub);
  });
  return SafeObjectFreeze(namespace);
}
