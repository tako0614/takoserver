import { spawn } from "node:child_process";
import { isIP } from "node:net";
import { canonicalJson, isJsonObject } from "../json.ts";
import type {
  DockerContainerNativeIdentity,
  DockerContainerRuntimePolicy,
} from "./docker-container-runtime-preparation.ts";
import type {
  LinuxContainerEgressPlan,
  LinuxContainerEgressPort,
  LinuxContainerHostHttpBridge,
} from "./linux-container-egress.ts";

const LIMIT = 1024 * 1024;
function fail(): never {
  throw new Error("docker_physical_session_unavailable");
}

export interface DockerPhysicalProcessOptions {
  readonly helper: string;
  readonly socketPath: string;
  /** Actual operator-owned Engine peer identity, never a tenant PID selector. */
  readonly peerPid: number;
  readonly peerUid: number;
  readonly networkId: string;
  readonly table: string;
  readonly signal: AbortSignal;
  /** Explicit native mode is only for a separately qualified selected namespace. */
  readonly native?: { readonly ipBinary: string; readonly nftBinary: string };
}

/** The process, not the emitted metadata, retains the original peer pidfd/netnsFD.
 * Capture-only is useful for a genuine own AF_UNIX fixture without setns/exec.
 */
export async function openDockerPhysicalProcess(options: DockerPhysicalProcessOptions) {
  if (
    ![options.helper, options.socketPath].every(
      (value) => value.startsWith("/") && !/[\0\r\n]/u.test(value),
    ) ||
    !Number.isSafeInteger(options.peerPid) ||
    options.peerPid < 1 ||
    !Number.isSafeInteger(options.peerUid) ||
    options.peerUid < 0 ||
    !/^[a-f0-9]{64}$/u.test(options.networkId) ||
    !/^takos_cx_[a-z0-9_]{1,40}$/u.test(options.table) ||
    options.signal.aborted ||
    (options.native &&
      ![options.native.ipBinary, options.native.nftBinary].every(
        (value) => value.startsWith("/") && !/[\0\r\n]/u.test(value),
      ))
  )
    fail();
  const args = [
    options.socketPath,
    String(options.peerPid),
    String(options.peerUid),
    options.networkId,
    options.table,
    ...(options.native ? ["--native", options.native.ipBinary, options.native.nftBinary] : []),
  ];
  const child = spawn(options.helper, args, {
    stdio: ["pipe", "pipe", "ignore"],
    env: { LANG: "C", LC_ALL: "C" },
  });
  let ended = false;
  let buffered = Buffer.alloc(0);
  let waiter: { resolve(value: Buffer): void; reject(): void } | undefined;
  let terminal = false;
  const exited = new Promise<void>((resolve) => {
    child.once("close", () => {
      ended = true;
      terminal = true;
      waiter?.reject();
      resolve();
    });
  });
  const stop = () => {
    terminal = true;
    waiter?.reject();
    child.stdin.destroy();
    if (!ended) child.kill("SIGKILL");
  };
  child.once("error", stop);
  const consume = () => {
    if (!waiter || buffered.length < 4) return;
    const size = buffered.readUInt32BE(0);
    if (size < 1 || size > LIMIT) {
      stop();
      return;
    }
    if (buffered.length < size + 4) return;
    const frame = buffered.subarray(4, size + 4);
    buffered = buffered.subarray(size + 4);
    const pending = waiter;
    waiter = undefined;
    if (frame[0] !== 0) {
      terminal = true;
      pending.reject();
    } else pending.resolve(frame.subarray(1));
  };
  child.stdout.on("data", (data: Buffer) => {
    if (buffered.length + data.length > LIMIT + 4) {
      stop();
      return;
    }
    buffered = Buffer.concat([buffered, data]);
    consume();
  });
  options.signal.addEventListener("abort", stop, { once: true });
  if (options.signal.aborted) stop();
  async function receive(): Promise<Buffer> {
    if (terminal || waiter) fail();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<Buffer>((resolve, reject) => {
        waiter = {
          resolve,
          reject: () => reject(new Error("docker_physical_session_unavailable")),
        };
        timer = setTimeout(stop, 4000);
        consume();
      });
    } finally {
      clearTimeout(timer);
      waiter = undefined;
    }
  }
  let queue: Promise<unknown> = Promise.resolve();
  function request(command: string) {
    const next = queue.then(async () => {
      if (terminal || options.signal.aborted) fail();
      const bytes = Buffer.from(command);
      if (bytes.length < 1 || bytes.length > 65536 + 128 || bytes.includes(0)) fail();
      const length = Buffer.alloc(4);
      length.writeUInt32BE(bytes.length);
      const reply = receive();
      child.stdin.write(Buffer.concat([length, bytes]), (error) => {
        if (error) stop();
      });
      return reply;
    });
    queue = next.catch(() => {
      terminal = true;
    });
    return next;
  }
  try {
    const hello: unknown = JSON.parse((await receive()).toString("utf8"));
    if (
      !isJsonObject(hello) ||
      hello.kind !== "docker-physical-session@1" ||
      hello.peerPid !== options.peerPid ||
      hello.peerUid !== options.peerUid ||
      hello.captureOnly !== !options.native ||
      ![hello.namespaceDevice, hello.namespaceInode, hello.parentDevice, hello.parentInode].every(
        (value) => typeof value === "string" && /^[0-9]+$/u.test(value),
      )
    )
      fail();
    const metadata = Object.freeze({ ...hello });
    return Object.freeze({
      metadata,
      closed: exited,
      async current() {
        await request("CURRENT");
      },
      async network() {
        return parseNetworkHttp(await request("NETWORK"));
      },
      async link(name: string) {
        if (!/^[A-Za-z][A-Za-z0-9_-]{0,14}$/u.test(name)) fail();
        return JSON.parse((await request(`LINK ${name}`)).toString("utf8")) as unknown;
      },
      async addresses(name: string) {
        if (!/^[A-Za-z][A-Za-z0-9_-]{0,14}$/u.test(name)) fail();
        return JSON.parse((await request(`ADDR ${name}`)).toString("utf8")) as unknown;
      },
      port(plan: LinuxContainerEgressPlan): LinuxContainerEgressPort {
        if (plan.table !== options.table) fail();
        const script = plan.script;
        return Object.freeze({
          async namespace() {
            await request("CURRENT");
            return `net:[${String(metadata.namespaceInode)}]`;
          },
          async execute(command: Parameters<LinuxContainerEgressPort["execute"]>[0]) {
            const argv = canonicalJson(command.argv);
            if (
              argv === canonicalJson(["nft", "--check", "-f", "-"]) ||
              argv === canonicalJson(["nft", "-f", "-"])
            ) {
              if (command.stdin !== script) fail();
              return (
                await request(
                  `${command.argv[1] === "--check" ? "NFTCHECK" : "NFTAPPLY"}\n${script}`,
                )
              ).toString("utf8");
            }
            if (command.stdin !== undefined) fail();
            for (const family of ["inet", "bridge"] as const) {
              const name = family === "inet" ? options.table : `${options.table}_bridge`;
              if (argv === canonicalJson(["nft", "-j", "list", "table", family, name]))
                return (await request(`NFTREAD ${family}`)).toString("utf8");
            }
            return fail();
          },
        });
      },
      async close() {
        try {
          if (!terminal) await request("CLOSE");
        } catch {
          /* original terminal remains */
        } finally {
          stop();
          await exited;
          options.signal.removeEventListener("abort", stop);
        }
      },
    });
  } catch {
    stop();
    await exited;
    options.signal.removeEventListener("abort", stop);
    return fail();
  }
}

function parseNetworkHttp(bytes: Buffer): unknown {
  const boundary = bytes.indexOf("\r\n\r\n");
  if (boundary < 0 || boundary > 16384) fail();
  const lines = bytes.subarray(0, boundary).toString("ascii").split("\r\n");
  if (!/^HTTP\/1\.[01] 200 /u.test(lines.shift() ?? "")) fail();
  const headers = new Map<string, string>();
  for (const line of lines) {
    const split = line.indexOf(":");
    if (split < 1 || /^[ \t]/u.test(line)) fail();
    const name = line.slice(0, split).toLowerCase();
    if (headers.has(name)) fail();
    headers.set(name, line.slice(split + 1).trim());
  }
  const wire = bytes.subarray(boundary + 4);
  let body = wire;
  if (headers.get("transfer-encoding") === "chunked") {
    if (headers.has("content-length")) fail();
    const chunks: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const end = wire.indexOf("\r\n", offset);
      if (end < 0) fail();
      const text = wire.subarray(offset, end).toString("ascii");
      if (!/^[a-fA-F0-9]{1,8}$/u.test(text)) fail();
      const size = Number.parseInt(text, 16);
      offset = end + 2;
      if (size === 0) {
        if (wire.subarray(offset).toString("ascii") !== "\r\n") fail();
        break;
      }
      if (
        size > LIMIT ||
        offset + size + 2 > wire.length ||
        wire.subarray(offset + size, offset + size + 2).toString("ascii") !== "\r\n"
      )
        fail();
      chunks.push(wire.subarray(offset, offset + size));
      offset += size + 2;
    }
    body = Buffer.concat(chunks);
  } else {
    const length = headers.get("content-length");
    if (
      headers.has("transfer-encoding") ||
      length === undefined ||
      !/^[0-9]+$/u.test(length) ||
      Number(length) !== body.length
    )
      fail();
  }
  return JSON.parse(body.toString("utf8")) as unknown;
}

/** Queries actual namespace-bound link/IPAM data; labels only corroborate the
 * original allocation owner. No prefix-derived bridge or guessed stopped veth.
 */
export interface DockerPhysicalBridgeBinding {
  readonly bridge: LinuxContainerHostHttpBridge;
  readonly ipam: readonly { readonly subnet: string; readonly gateway: string }[];
}

export async function readDockerPhysicalBridge(
  process: Awaited<ReturnType<typeof openDockerPhysicalProcess>>,
  native: DockerContainerNativeIdentity,
  policy: DockerContainerRuntimePolicy,
  host: { readonly tcpPorts: readonly number[]; readonly conntrackMark: number },
): Promise<LinuxContainerHostHttpBridge> {
  return (await readDockerPhysicalBridgeBinding(process, native, policy, host)).bridge;
}

/** The original full allocation projection, held separately from compiler input.
 * Never discard the subnet/prefix when pinning pre/post native readback identity.
 */
export async function readDockerPhysicalBridgeBinding(
  process: Awaited<ReturnType<typeof openDockerPhysicalProcess>>,
  native: DockerContainerNativeIdentity,
  policy: DockerContainerRuntimePolicy,
  host: { readonly tcpPorts: readonly number[]; readonly conntrackMark: number },
): Promise<DockerPhysicalBridgeBinding> {
  await process.current();
  const network = await process.network();
  if (
    !isJsonObject(network) ||
    network.Id !== native.networkId ||
    network.Name !== native.network ||
    network.Driver !== "bridge" ||
    network.Scope !== "local" ||
    network.Internal !== !policy.outboundInternet ||
    network.Ingress !== false ||
    network.Attachable !== false ||
    !isJsonObject(network.Labels) ||
    network.Labels["takoserver.installation"] !== native.installationId ||
    !isJsonObject(network.Options) ||
    !isJsonObject(network.IPAM) ||
    !Array.isArray(network.IPAM.Config) ||
    !isJsonObject(network.Containers) ||
    Object.keys(network.Containers).some((id) => id !== native.nativeId)
  )
    fail();
  const name = network.Options["com.docker.network.bridge.name"];
  if (typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,14}$/u.test(name)) fail();
  const links = await process.link(name),
    addresses = await process.addresses(name);
  if (
    !Array.isArray(links) ||
    links.length !== 1 ||
    !Array.isArray(addresses) ||
    addresses.length !== 1
  )
    fail();
  const link = links[0],
    address = addresses[0];
  if (
    !isJsonObject(link) ||
    !isJsonObject(address) ||
    link.ifname !== name ||
    address.ifname !== name ||
    !Number.isSafeInteger(link.ifindex) ||
    (link.ifindex as number) < 1 ||
    address.ifindex !== link.ifindex ||
    !isJsonObject(link.linkinfo) ||
    link.linkinfo.info_kind !== "bridge" ||
    typeof link.address !== "string" ||
    !/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/u.test(link.address) ||
    !Array.isArray(address.addr_info)
  )
    fail();
  const configured: string[] = [];
  const ipam: { subnet: string; gateway: string }[] = [];
  for (const config of network.IPAM.Config) {
    if (
      !isJsonObject(config) ||
      typeof config.Gateway !== "string" ||
      typeof config.Subnet !== "string"
    )
      fail();
    const prefix = config.Subnet.split("/");
    if (
      prefix.length !== 2 ||
      !/^[0-9]{1,3}$/u.test(prefix[1] ?? "") ||
      isIP(config.Gateway) !== isIP(prefix[0] ?? "") ||
      !isIP(config.Gateway)
    )
      fail();
    const bits = Number(prefix[1]);
    if (
      bits > (isIP(config.Gateway) === 4 ? 32 : 128) ||
      !insideSubnet(config.Gateway, prefix[0] ?? "", bits)
    )
      fail();
    configured.push(`${normalizedIp(config.Gateway)}/${bits}`);
    ipam.push({
      subnet: `${normalizedIp(prefix[0] ?? "")}/${bits}`,
      gateway: normalizedIp(config.Gateway),
    });
  }
  const actual: string[] = [];
  for (const item of address.addr_info) {
    if (
      !isJsonObject(item) ||
      typeof item.local !== "string" ||
      !isIP(item.local) ||
      !Number.isSafeInteger(item.prefixlen)
    )
      fail();
    if (item.scope === "global")
      actual.push(`${normalizedIp(item.local)}/${String(item.prefixlen)}`);
    else if (
      item.scope !== "link" ||
      isIP(item.local) !== 6 ||
      !item.local.toLowerCase().startsWith("fe80:")
    )
      fail();
  }
  if (
    configured.length === 0 ||
    new Set(configured).size !== configured.length ||
    canonicalJson([...actual].sort()) !== canonicalJson([...configured].sort())
  )
    fail();
  await process.current();
  return Object.freeze({
    bridge: Object.freeze({
      tenantRef: policy.tenantRef,
      generation: policy.generation,
      networkId: native.networkId,
      bridge: name,
      ifindex: link.ifindex as number,
      hostMac: link.address,
      hostAddresses: Object.freeze(configured.map((value) => value.split("/")[0] ?? "")),
      tcpPorts: Object.freeze([...host.tcpPorts]),
      conntrackMark: host.conntrackMark,
    }),
    ipam: Object.freeze(
      ipam
        .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)))
        .map((value) => Object.freeze(value)),
    ),
  });
}
function normalizedIp(value: string) {
  if (isIP(value) === 4) return value;
  if (value.includes("%")) return fail();
  return new URL(`http://[${value}]/`).hostname.slice(1, -1);
}
function insideSubnet(address: string, subnet: string, bits: number) {
  const width = isIP(address) === 4 ? 32 : 128;
  const number = (value: string): bigint => {
    if (width === 32) return value.split(".").reduce((n, item) => (n << 8n) | BigInt(item), 0n);
    const text = normalizedIp(value);
    const parts = text.split("::");
    const left = (parts[0] ?? "").split(":").filter(Boolean);
    const right = (parts[1] ?? "").split(":").filter(Boolean);
    const groups =
      parts.length === 1
        ? left
        : [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
    if (groups.length !== 8 || groups.some((part) => !/^[a-f0-9]{1,4}$/u.test(part))) return fail();
    return groups.reduce((n, item) => (n << 16n) | BigInt(`0x${item}`), 0n);
  };
  const shift = BigInt(width - bits),
    network = number(subnet);
  return network === (network >> shift) << shift && number(address) >> shift === network >> shift;
}
