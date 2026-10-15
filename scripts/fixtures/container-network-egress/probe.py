"""Opt-in isolated native packet fixture. No Docker, provider, DNS or internet.

The parent unshares this process first. Every link/route/rule/sysctl operation
is guarded by the exact fresh outer network namespace identity.
"""
import argparse
import concurrent.futures
import json
import os
import selectors
import signal
import socket
import subprocess
import sys
import time
import traceback


def emit(value):
    print(json.dumps(value), flush=True)


def sink():
    selector = selectors.DefaultSelector()
    selector.register(sys.stdin, selectors.EVENT_READ, "control")
    markers, connections, buffers = [], [], {}
    for family in [socket.AF_INET, socket.AF_INET6]:
        for kind, ports in [(socket.SOCK_STREAM, [24, 25, 26, 8080]), (socket.SOCK_DGRAM, [25])]:
            for port in ports:
                sock = socket.socket(family, kind)
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                if family == socket.AF_INET6:
                    sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
                if kind == socket.SOCK_DGRAM:
                    # Reply with the actual destination alias, not the transit
                    # interface address; connected UDP clients pin their peer.
                    if family == socket.AF_INET:
                        sock.setsockopt(socket.IPPROTO_IP, getattr(socket, "IP_PKTINFO", 8), 1)
                    else:
                        sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_RECVPKTINFO, 1)
                sock.bind(("::" if family == socket.AF_INET6 else "0.0.0.0", port))
                if kind == socket.SOCK_STREAM:
                    sock.listen(64)
                sock.setblocking(False)
                selector.register(sock, selectors.EVENT_READ, "tcp" if kind == socket.SOCK_STREAM else "udp")
    emit({"ready": True})
    while True:
        for key, _ in selector.select(1):
            if key.data == "control":
                line = sys.stdin.readline()
                if not line:
                    return
                command = json.loads(line)
                if command.get("command") == "snapshot":
                    emit({"markers": markers, "activeConnections": len(connections)})
                elif command.get("command") == "stop":
                    return
            elif key.data == "tcp":
                conn, _ = key.fileobj.accept()
                conn.setblocking(False)
                connections.append(conn)
                buffers[conn] = b""
                selector.register(conn, selectors.EVENT_READ, "connection")
            elif key.data == "udp":
                data, ancillary, _flags, address = key.fileobj.recvmsg(65535, 256)
                markers.extend(data.decode().splitlines())
                key.fileobj.sendmsg([data], ancillary, 0, address)
            else:
                conn = key.fileobj
                try:
                    data = conn.recv(65535)
                except ConnectionResetError:
                    data = b""
                if not data:
                    selector.unregister(conn)
                    connections.remove(conn)
                    buffers.pop(conn, None)
                    conn.close()
                else:
                    buffers[conn] += data
                    while b"\n" in buffers[conn]:
                        line, buffers[conn] = buffers[conn].split(b"\n", 1)
                        markers.append(line.decode())
                    conn.sendall(data)


def client(args):
    family = socket.AF_INET6 if ":" in args.destination else socket.AF_INET
    sock = socket.socket(family, socket.SOCK_STREAM if args.transport == "tcp" else socket.SOCK_DGRAM)
    # Initial IPv6 neighbor discovery can wait for link-local DAD/retransmit.
    # This bounds connection setup separately from per-marker I/O below.
    sock.settimeout(1.5)
    if args.bind:
        sock.bind((args.bind, 0))
    try:
        sock.connect((args.destination, args.port))
    except OSError as error:
        emit({"connected": False, "errno": error.errno})
        return
    sock.settimeout(0.35)
    emit({"connected": True, "sourceAddress": sock.getsockname()[0]})
    for line in sys.stdin:
        command = json.loads(line)
        if command.get("command") == "close":
            sock.close()
            emit({"closed": True})
            return
        data = (command["marker"] + "\n").encode()
        try:
            sock.sendall(data)
            echoed = sock.recv(65535)
            emit({"echo": echoed == data})
        except OSError as error:
            emit({"echo": False, "errno": error.errno})


def fixture(args):
    outer = os.readlink("/proc/self/ns/net")
    if outer == args.parent:
        raise RuntimeError("refuse parent network namespace")
    children, keepers, clients, records, readbacks = [], {}, [], [], []
    result = {"kind": "isolated-container-native-egress@v1", "namespace": outer,
              "parentNamespace": args.parent, "fullRuntimeCoverage": False,
              "billingQualified": False, "counterUnit": "kernel-skb-bytes-at-inet-forward",
              "internetInterfaces": 0, "records": records, "readbacks": readbacks}

    def guard():
        if os.readlink("/proc/self/ns/net") != outer or outer == args.parent:
            raise RuntimeError("network namespace drift")

    def run(argv, stdin=None):
        guard()
        proc = subprocess.run(argv, input=stdin, text=True, capture_output=True, timeout=8)
        if proc.returncode:
            raise RuntimeError(json.dumps({"argv": argv, "exit": proc.returncode, "stderr": proc.stderr[:3000]}))
        return proc.stdout

    def ip(*argv):
        return run(["ip", *argv])

    def inside(name, *argv):
        return run(["nsenter", "--net=/proc/%d/ns/net" % keepers[name].pid, "--", *argv])

    def process(argv):
        guard()
        proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True)
        children.append(proc)
        return proc

    def line(proc):
        selector = selectors.DefaultSelector()
        selector.register(proc.stdout, selectors.EVENT_READ)
        try:
            if not selector.select(4):
                raise RuntimeError("fixture process response deadline")
            response = proc.stdout.readline()
            if not response:
                raise RuntimeError("fixture process exited: " + proc.stderr.read()[:1000])
            return json.loads(response)
        finally:
            selector.close()

    def request(proc, value):
        proc.stdin.write(json.dumps(value) + "\n")
        proc.stdin.flush()
        return line(proc)

    def observe(name, condition, detail):
        records.append({"name": name, "passed": bool(condition), "detail": detail})
        if not condition:
            raise RuntimeError("native acceptance failed: " + name)

    def start_client(name, destination="8.8.8.8", port=24, transport="tcp", bind=None):
        argv = ["nsenter", "--net=/proc/%d/ns/net" % keepers[name].pid, "--", "python3", __file__,
                "--client", "--parent", args.parent, "--expected-netns", os.readlink("/proc/%d/ns/net" % keepers[name].pid),
                "--destination", destination, "--port", str(port), "--transport", transport]
        if bind:
            argv.extend(["--bind", bind])
        proc = process(argv)
        connected = line(proc)
        if connected.get("connected"):
            clients.append(proc)
        return proc, connected

    def close_clients():
        for proc in clients:
            if proc.poll() is None:
                request(proc, {"command": "close"})
                proc.wait(timeout=2)
        clients.clear()

    def current():
        return json.loads(run(["nft", "-j", "list", "table", "inet", "takos_cx_native"]))

    def phase(name):
        close_clients()
        if readbacks:
            run(["nft", "delete", "table", "inet", "takos_cx_native"])
        script = compiled["plans"][name]["script"]
        run(["nft", "--check", "-f", "-"], script)
        run(["nft", "-f", "-"], script)
        item = {"phase": name, "before": current()}
        readbacks.append(item)
        return item

    def has_marker(proc, marker):
        return marker in request(proc, {"command": "snapshot"})["markers"]

    try:
        initial_links = json.loads(ip("-j", "link", "show"))
        initial_rules = json.loads(run(["nft", "-j", "list", "ruleset"]))
        observe("fresh isolated namespace", [item["ifname"] for item in initial_links] == ["lo"]
                and json.loads(ip("-j", "route", "show", "table", "all")) == []
                and json.loads(ip("-j", "-6", "route", "show", "table", "all")) == []
                and all("metainfo" in item for item in initial_rules["nftables"]), initial_links)
        compiled = json.loads(run([args.bun, "--no-env-file", args.compiler, "--compile-child", args.parent]))
        for name in ["a", "b", "sink"]:
            proc = process(["unshare", "--net", "--", "python3", "-c",
                            "import signal; signal.pause()"])
            keepers[name] = proc
            for _ in range(100):
                if os.readlink("/proc/%d/ns/net" % proc.pid) != outer:
                    break
                time.sleep(0.01)
            if os.readlink("/proc/%d/ns/net" % proc.pid) in [outer, args.parent]:
                raise RuntimeError("child namespace was not isolated")
            inside(name, "ip", "link", "set", "lo", "up")
        ip("link", "set", "lo", "up")
        for interface, child, number in [("cx_a", "a", 1), ("cx_a2", "a", 3), ("cx_b", "b", 2), ("cx_sink", "sink", 4)]:
            peer = interface + "p"
            ip("link", "add", interface, "type", "veth", "peer", "name", peer)
            ip("link", "set", peer, "netns", str(keepers[child].pid))
            ip("addr", "add", "10.246.%d.1/30" % number, "dev", interface)
            ip("-6", "addr", "add", "fdce:%d::1/64" % number, "dev", interface, "nodad")
            ip("link", "set", interface, "up")
            inside(child, "ip", "addr", "add", "10.246.%d.2/30" % number, "dev", peer)
            inside(child, "ip", "-6", "addr", "add", "fdce:%d::2/64" % number, "dev", peer, "nodad")
            inside(child, "ip", "link", "set", peer, "up")
        run(["sysctl", "-q", "-w", "net.ipv4.ip_forward=1", "net.ipv6.conf.all.forwarding=1"])
        v4_targets = ["8.8.8.8", "169.254.169.254", "10.99.0.1"]
        v6_targets = ["2606:4700:4700::1111", "fd00:dead::1"]
        for address in v4_targets:
            inside("sink", "ip", "addr", "add", address + "/32", "dev", "lo")
            ip("route", "add", address + "/32", "via", "10.246.4.2", "dev", "cx_sink")
        for address in v6_targets:
            inside("sink", "ip", "-6", "addr", "add", address + "/128", "dev", "lo", "nodad")
            ip("-6", "route", "add", address + "/128", "via", "fdce:4::2", "dev", "cx_sink")
        for child, number in [("a", 1), ("b", 2)]:
            for address in v4_targets:
                inside(child, "ip", "route", "add", address + "/32", "via", "10.246.%d.1" % number)
            for address in v6_targets:
                inside(child, "ip", "-6", "route", "add", address + "/128", "via", "fdce:%d::1" % number)
        inside("a", "ip", "route", "add", "10.246.2.2/32", "via", "10.246.1.1")
        inside("a", "ip", "rule", "add", "from", "10.246.3.2/32", "table", "103")
        inside("a", "ip", "route", "add", "8.8.8.8/32", "via", "10.246.3.1", "dev", "cx_a2p", "table", "103")
        for number in [1, 2, 3]:
            inside("sink", "ip", "route", "add", "10.246.%d.0/30" % number, "via", "10.246.4.1")
            inside("sink", "ip", "-6", "route", "add", "fdce:%d::/64" % number, "via", "fdce:4::1")
        # Wait for actual native IPv6 readiness instead of racing link-local DAD
        # and treating an unresolved neighbor as an enforcement failure.
        deadline = time.monotonic() + 5
        while True:
            addresses = {"outer": json.loads(ip("-j", "-6", "addr", "show"))}
            addresses.update({name: json.loads(inside(name, "ip", "-j", "-6", "addr", "show")) for name in keepers})
            pending = [info for links in addresses.values() for link in links
                       for info in link["addr_info"] if info.get("tentative") or info.get("dadfailed")]
            if not pending:
                break
            if time.monotonic() > deadline:
                raise RuntimeError("native IPv6 address readiness deadline")
            time.sleep(0.05)
        result["ipv6AddressReadiness"] = {"tentativeAddresses": len(pending), "qualified": True}
        servers = {}
        for name in ["sink", "b"]:
            servers[name] = process(["nsenter", "--net=/proc/%d/ns/net" % keepers[name].pid,
                                     "--", "python3", __file__, "--sink", "--parent", args.parent,
                                     "--expected-netns", os.readlink("/proc/%d/ns/net" % keepers[name].pid)])
            if line(servers[name]) != {"ready": True}:
                raise RuntimeError("sink unavailable")
        servers["host"] = process(["python3", __file__, "--sink", "--parent", args.parent,
                                    "--expected-netns", outer])
        line(servers["host"])
        topology = json.loads(ip("-j", "link", "show"))
        observe("no physical uplink", sorted(item["ifname"] for item in topology)
                == ["cx_a", "cx_a2", "cx_b", "cx_sink", "lo"], topology)

        item = phase("transport")
        for address in ["8.8.8.8", "2606:4700:4700::1111"]:
            for port, transport in [(24, "tcp"), (26, "tcp"), (25, "udp")]:
                proc, connected = start_client("a", address, port, transport)
                marker = "positive-%s-%d-%s" % (address, port, transport)
                response = request(proc, {"marker": marker}) if connected.get("connected") else connected
                received = has_marker(servers["sink"], marker)
                observe(marker, response.get("echo") and received,
                        {"client": response, "receiverMarker": received})
        second, connected = start_client("a", bind="10.246.3.2")
        observe("tenant A second native endpoint positive", connected.get("connected")
                and connected.get("sourceAddress") == "10.246.3.2"
                and request(second, {"marker": "a-second-endpoint"}).get("echo"), connected)
        close_clients()
        for address, port, transport, server in [("8.8.8.8", 25, "tcp", "sink"),
                ("2606:4700:4700::1111", 25, "tcp", "sink"),
                ("169.254.169.254", 8080, "tcp", "sink"), ("10.99.0.1", 8080, "tcp", "sink"),
                ("fd00:dead::1", 8080, "tcp", "sink"), ("10.246.2.2", 8080, "tcp", "b"),
                ("10.246.1.1", 8080, "tcp", "host")]:
            proc, connected = start_client("a", address, port, transport)
            marker = "denied-%s-%d" % (address, port)
            response = request(proc, {"marker": marker}) if connected.get("connected") else connected
            observe(marker, not response.get("echo") and not has_marker(servers[server], marker), response)
        item["after"] = current()

        item = phase("connections")
        def open_parallel(number):
            return start_client("a", bind="10.246.3.2" if number % 2 else "10.246.1.2")
        with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
            opened = list(executor.map(open_parallel, range(10)))
        successes = [proc for proc, status in opened if status.get("connected")]
        observe("shared native TCP connection cap", len(successes) == 2,
                {"accepted": len(successes), "attempted": len(opened),
                 "acceptedSources": [status.get("sourceAddress") for _, status in opened if status.get("connected")]})
        other, status = start_client("b")
        observe("tenant B connection independent", status.get("connected") and request(other, {"marker": "b-cap-positive"}).get("echo"), status)
        close_clients()
        time.sleep(0.1)
        released, status = start_client("a")
        result["tcpSlotReleaseAfterClose"] = status.get("connected", False)
        item["after"] = current()

        item = phase("udp")
        responses = []
        for number in range(3):
            proc, status = start_client("a", port=25, transport="udp")
            responses.append(request(proc, {"marker": "udp-cap-%d" % number}).get("echo", False))
        observe("native UDP tuple cap", responses == [True, True, False], responses)
        close_clients()
        proc, _ = start_client("a", port=25, transport="udp")
        retained = not request(proc, {"marker": "udp-after-socket-close"}).get("echo")
        result["udpExpiry"] = {"slotRetainedAfterSocketClose": retained,
                               "waitedForConntrackExpiry": False, "qualifiedImmediateRelease": False}
        item["after"] = current()

        item = phase("quota")
        quota_clients = [start_client("a", port=25, transport="udp", bind=address)[0]
                         for address in ["10.246.1.2", "10.246.3.2"]]
        def send_quota(pair):
            number, proc = pair
            return [request(proc, {"marker": ("quota-%d-%d-" % (number, step)).ljust(99, "x")}).get("echo", False)
                    for step in range(4)]
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            responses = [allowed for batch in executor.map(send_quota, enumerate(quota_clients)) for allowed in batch]
        counters = current()
        accepted = next(value["counter"] for value in counters["nftables"] if "counter" in value
                        and value["counter"]["name"] == "accepted0")
        observe("native shared packet budget", 0 < sum(responses) < len(responses) and accepted["bytes"] <= 512,
                {"delivered": sum(responses), "acceptedCounter": accepted,
                 "concurrentEndpointSources": ["10.246.1.2", "10.246.3.2"]})
        other, _ = start_client("b", port=25, transport="udp")
        observe("tenant B budget independent", request(other, {"marker": "b-quota-positive"}).get("echo"), {})
        item["after"] = current()

        item = phase("kill")
        a_tcp, _ = start_client("a", port=26)
        a_udp, _ = start_client("a", port=25, transport="udp")
        b_tcp, _ = start_client("b", port=26)
        for proc, marker in [(a_tcp, "a-before-kill-tcp"), (a_udp, "a-before-kill-udp"), (b_tcp, "b-before-kill")]:
            observe(marker, request(proc, {"marker": marker}).get("echo"), {})
        run(["nft", "-f", "-"], compiled["killScript"])
        item["killed"] = True
        killed = current()
        for proc, marker in [(a_tcp, "a-after-kill-tcp"), (a_udp, "a-after-kill-udp")]:
            response = request(proc, {"marker": marker})
            observe(marker, not response.get("echo") and not has_marker(servers["sink"], marker), response)
        observe("tenant B existing flow survives kill", request(b_tcp, {"marker": "b-after-kill"}).get("echo"), {})
        item["after"] = current()
        handle = next(value["rule"]["handle"] for value in killed["nftables"] if "rule" in value
                      and value["rule"]["chain"] == "forward")
        run(["nft", "delete", "rule", "inet", "takos_cx_native", "forward", "handle", str(handle)])
        item["drifted"] = current()

        item = phase("false")
        for address in ["8.8.8.8", "2606:4700:4700::1111"]:
            for port, transport in [(24, "tcp"), (25, "udp")]:
                proc, status = start_client("a", address, port, transport)
                marker = "false-%s-%s" % (address, transport)
                response = request(proc, {"marker": marker}) if status.get("connected") else status
                observe(marker, not response.get("echo") and not has_marker(servers["sink"], marker), response)
        item["after"] = current()
        result["passed"] = True
    except BaseException as error:
        result["passed"] = False
        result["error"] = str(error)
        result["traceback"] = traceback.format_exc()
        if readbacks:
            result["failureNative"] = current()
            result["failureNeighbors"] = {"outer": json.loads(ip("-j", "-6", "neigh", "show"))}
            for name in keepers:
                result["failureNeighbors"][name] = json.loads(inside(name, "ip", "-j", "-6", "neigh", "show"))
            result["failureAddresses"] = {name: json.loads(inside(name, "ip", "-j", "-6", "addr", "show")) for name in keepers}
    finally:
        for proc in reversed(children):
            if proc.poll() is None:
                proc.terminate()
        for proc in reversed(children):
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=2)
            for stream in [proc.stdin, proc.stdout, proc.stderr]:
                if stream:
                    stream.close()
        result["cleanup"] = {"childrenReaped": all(proc.poll() is not None for proc in children),
                             "namespaceKeepersReaped": all(proc.poll() is not None for proc in keepers.values()),
                             "childCount": len(children), "childPids": [proc.pid for proc in children],
                             "openPipeHandles": sum(not stream.closed for proc in children
                                                    for stream in [proc.stdin, proc.stdout, proc.stderr] if stream),
                             "namespaceHandlesCreated": 0,
                             "outerNamespaceUnchanged": os.readlink("/proc/self/ns/net") == outer}
        emit(result)
    return 0 if result.get("passed") else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--sink", action="store_true")
    parser.add_argument("--client", action="store_true")
    parser.add_argument("--destination")
    parser.add_argument("--port", type=int)
    parser.add_argument("--transport", choices=["tcp", "udp"])
    parser.add_argument("--bind")
    parser.add_argument("--parent")
    parser.add_argument("--expected-netns")
    parser.add_argument("--compiler")
    parser.add_argument("--bun")
    arguments = parser.parse_args()
    if (arguments.sink or arguments.client) and (not arguments.parent or not arguments.expected_netns
            or os.readlink("/proc/self/ns/net") != arguments.expected_netns
            or arguments.expected_netns == arguments.parent):
        raise SystemExit("refuse non-fixture network namespace")
    def terminated(_signal, _frame):
        raise TimeoutError("bounded fixture terminated")
    signal.signal(signal.SIGTERM, terminated)
    if arguments.sink:
        sink()
    elif arguments.client:
        client(arguments)
    else:
        raise SystemExit(fixture(arguments))
