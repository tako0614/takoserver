import { readdirSync, readFileSync, statSync } from "node:fs";
import { connect as connectTcp } from "node:net";

export interface IsolatedSelfhostNativeObservation {
  readonly selfNetworkNamespace: number;
  readonly initNetworkNamespace: number;
  readonly interfaces: readonly string[];
  readonly loopbackIsUp: boolean;
  readonly occupiedPorts: readonly number[];
  readonly ownedChildExitCode?: number | null;
}

export function assertIsolatedSelfhostNativeObservation(
  observation: IsolatedSelfhostNativeObservation,
): void {
  if (observation.selfNetworkNamespace === observation.initNetworkNamespace) {
    throw new Error("isolated_selfhost_native_network_namespace_required");
  }
  if (
    observation.interfaces.length !== 1 ||
    observation.interfaces[0] !== "lo" ||
    !observation.loopbackIsUp
  ) {
    throw new Error("isolated_selfhost_native_loopback_only_required");
  }
  if (observation.occupiedPorts.length > 0) {
    throw new Error("isolated_selfhost_native_fixed_port_occupied");
  }
  if (observation.ownedChildExitCode !== undefined && observation.ownedChildExitCode !== null) {
    throw new Error("isolated_selfhost_native_owned_child_exited");
  }
}

export async function assertIsolatedSelfhostNativeEnvironment(input: {
  readonly fixedPorts: readonly number[];
  readonly ownedChild?: { readonly exitCode: number | null };
}): Promise<void> {
  if (process.platform !== "linux") {
    throw new Error("isolated_selfhost_native_linux_required");
  }
  const observation = readNetworkObservation(input.ownedChild?.exitCode);
  // Reject a host namespace or non-loopback link before probing any listener.
  assertIsolatedSelfhostNativeObservation({ ...observation, occupiedPorts: [] });

  const occupiedPorts: number[] = [];
  for (const port of input.fixedPorts) {
    if (!(await tcpPortIsClosed(port))) occupiedPorts.push(port);
  }
  assertIsolatedSelfhostNativeObservation({ ...observation, occupiedPorts });
}

function readNetworkObservation(
  ownedChildExitCode: number | null | undefined,
): Omit<IsolatedSelfhostNativeObservation, "occupiedPorts"> {
  try {
    const selfNetworkNamespace = statSync("/proc/self/ns/net").ino;
    const initNetworkNamespace = statSync("/proc/1/ns/net").ino;
    const interfaces = readdirSync("/sys/class/net").sort();
    const loopbackFlags = Number.parseInt(
      readFileSync("/sys/class/net/lo/flags", "utf8").trim(),
      16,
    );
    return {
      selfNetworkNamespace,
      initNetworkNamespace,
      interfaces,
      loopbackIsUp: Number.isSafeInteger(loopbackFlags) && (loopbackFlags & 0x1) !== 0,
      ...(ownedChildExitCode === undefined ? {} : { ownedChildExitCode }),
    };
  } catch {
    throw new Error("isolated_selfhost_native_network_observation_unavailable");
  }
}

function tcpPortIsClosed(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = connectTcp({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("isolated_selfhost_native_port_probe_timeout"));
    }, 250);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(false);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === "ECONNREFUSED") resolve(true);
      else reject(new Error("isolated_selfhost_native_port_probe_unconfirmed"));
    });
  });
}
