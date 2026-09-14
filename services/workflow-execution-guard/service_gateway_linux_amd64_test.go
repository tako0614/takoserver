//go:build linux && amd64

package guard

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

const testUnavailableToken = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"

func serviceGatewayFields(id int, listenPath, upstreamPath string) map[string]any {
	return map[string]any{
		"id":               id,
		"op":               "gateway",
		"identity":         testIdentity,
		"listenPath":       listenPath,
		"upstreamPath":     upstreamPath,
		"unavailableToken": testUnavailableToken,
	}
}

func privateGatewayRoot(t *testing.T) string {
	t.Helper()
	root, err := os.MkdirTemp("", "twg-")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(root, 0o700); err != nil {
		_ = os.RemoveAll(root)
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	return root
}

func privateGatewayConfig(t *testing.T, root string) string {
	t.Helper()
	path := filepath.Join(root, "workerd.capnp")
	if err := os.WriteFile(path, []byte("private test config"), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func upstreamGatewayPath(root string, marker byte) string {
	return filepath.Join(root, strings.Repeat(string(marker), 64)+".sock")
}

func gatewayDescriptor(listenPath, upstreamPath string) serviceGatewayDescriptor {
	return serviceGatewayDescriptor{
		listenPath:       listenPath,
		upstreamPath:     upstreamPath,
		unavailableToken: testUnavailableToken,
	}
}

func assertGatewayConnectionClosed(t *testing.T, name string, connection net.Conn) {
	t.Helper()
	if err := connection.SetReadDeadline(time.Now().Add(250 * time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	buffer := make([]byte, 1)
	if _, err := connection.Read(buffer); err == nil {
		t.Fatalf("%s remains readable after gateway cleanup", name)
	} else {
		var networkError net.Error
		if errors.As(err, &networkError) && networkError.Timeout() {
			t.Fatalf("%s remains open but stalled after gateway cleanup: %v", name, err)
		}
	}
}

func listenGatewayUpstream(t *testing.T, path string) *net.UnixListener {
	t.Helper()
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	listener.SetUnlinkOnClose(false)
	t.Cleanup(func() {
		_ = listener.Close()
		_ = os.Remove(path)
	})
	return listener
}

func configureGatewaySession(
	t *testing.T,
	configPath string,
	listenPath string,
	upstreamPath string,
) *testSession {
	t.Helper()
	session := newTestSession(t)
	session.send(t, registrationFields(t, 5*time.Second, 10*time.Second))
	if got := session.reply(t); got != (reply{ID: 1, Kind: "registered"}) {
		t.Fatalf("register reply = %#v", got)
	}
	session.send(t, serviceGatewayFields(2, listenPath, upstreamPath))
	if got := session.reply(t); got != (reply{ID: 2, Kind: "configured"}) {
		t.Fatalf("gateway reply = %#v", got)
	}
	return session
}

func startGatewaySession(
	t *testing.T,
	configPath string,
	listenPath string,
	upstreamPath string,
) (*testSession, int) {
	t.Helper()
	session := configureGatewaySession(t, configPath, listenPath, upstreamPath)
	session.send(t, startFields(3, configPath))
	if got := session.reply(t); got != (reply{ID: 3, Kind: "started"}) {
		t.Fatalf("start reply = %#v", got)
	}
	return session, waitForPID(t, configPath)
}

func TestDecodeServiceGatewayFrameIsStrictAndBounded(t *testing.T) {
	listenPath := "/tmp/s0.sock"
	upstreamPath := "/tmp/" + strings.Repeat("a", 64) + ".sock"
	fields := serviceGatewayFields(2, listenPath, upstreamPath)
	raw, err := json.Marshal(fields)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := decodeRequest(raw)
	if err != nil {
		t.Fatalf("valid gateway frame rejected: %v", err)
	}
	if decoded.ListenPath != listenPath || decoded.UpstreamPath != upstreamPath ||
		decoded.UnavailableToken != testUnavailableToken {
		t.Fatalf("decoded gateway = %#v", decoded)
	}

	invalid := []struct {
		name   string
		mutate func(map[string]any)
		code   Code
	}{
		{name: "relative-listener", mutate: func(value map[string]any) { value["listenPath"] = "s0.sock" }, code: CodeInvalidGateway},
		{name: "long-listener", mutate: func(value map[string]any) {
			value["listenPath"] = "/tmp/" + strings.Repeat("x", MaxUnixSocketPathBytes)
		}, code: CodeInvalidGateway},
		{name: "upstream-name", mutate: func(value map[string]any) { value["upstreamPath"] = "/tmp/router.sock" }, code: CodeInvalidGateway},
		{name: "token", mutate: func(value map[string]any) { value["unavailableToken"] = strings.ToUpper(testUnavailableToken) }, code: CodeInvalidGateway},
		{name: "extra", mutate: func(value map[string]any) { value["extra"] = true }, code: CodeInvalidFrame},
	}
	for _, testCase := range invalid {
		t.Run(testCase.name, func(t *testing.T) {
			candidate := serviceGatewayFields(2, listenPath, upstreamPath)
			testCase.mutate(candidate)
			raw, err := json.Marshal(candidate)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := decodeRequest(raw); errorCode(err, "") != testCase.code {
				t.Fatalf("decode error = %v, want %s", err, testCase.code)
			}
		})
	}
}

func TestControllerCapsServiceGatewaysAtManifestBound(t *testing.T) {
	controller := newController(testExecutable(t))
	controller.registered = true
	controller.identity = testIdentity
	for index := 0; index < MaxServiceGateways; index++ {
		err := controller.configureGateway(request{
			Identity:         testIdentity,
			ListenPath:       "/tmp/s" + strings.Repeat("x", index+1),
			UpstreamPath:     "/tmp/" + strings.Repeat("a", 64) + ".sock",
			UnavailableToken: testUnavailableToken,
		})
		if err != nil {
			t.Fatalf("gateway %d rejected: %v", index, err)
		}
	}
	err := controller.configureGateway(request{
		Identity:         testIdentity,
		ListenPath:       "/tmp/overflow.sock",
		UpstreamPath:     "/tmp/" + strings.Repeat("b", 64) + ".sock",
		UnavailableToken: testUnavailableToken,
	})
	if errorCode(err, "") != CodeInvalidGateway {
		t.Fatalf("overflow error = %v", err)
	}
}

func TestValidateServiceGatewaySetRejectsUnsafeRootsAndCollisions(t *testing.T) {
	executionRoot := privateGatewayRoot(t)
	upstreamRoot := privateGatewayRoot(t)
	configPath := privateGatewayConfig(t, executionRoot)
	listenPath := filepath.Join(executionRoot, "s0.sock")
	upstreamPath := upstreamGatewayPath(upstreamRoot, '9')
	valid := gatewayDescriptor(listenPath, upstreamPath)
	if _, err := validateServiceGatewaySet(configPath, []serviceGatewayDescriptor{valid}); err != nil {
		t.Fatalf("valid gateway rejected: %v", err)
	}

	unsafe := []struct {
		name        string
		descriptors []serviceGatewayDescriptor
	}{
		{name: "duplicate", descriptors: []serviceGatewayDescriptor{valid, valid}},
		{name: "run-socket", descriptors: []serviceGatewayDescriptor{{
			listenPath:       filepath.Join(executionRoot, "run.sock"),
			upstreamPath:     upstreamPath,
			unavailableToken: testUnavailableToken,
		}}},
		{name: "outside-execution-root", descriptors: []serviceGatewayDescriptor{{
			listenPath:       filepath.Join(upstreamRoot, "s0.sock"),
			upstreamPath:     upstreamPath,
			unavailableToken: testUnavailableToken,
		}}},
	}
	for _, testCase := range unsafe {
		t.Run(testCase.name, func(t *testing.T) {
			if _, err := validateServiceGatewaySet(configPath, testCase.descriptors); errorCode(err, "") != CodeInvalidGateway {
				t.Fatalf("unsafe gateway error = %v", err)
			}
		})
	}

	realRoot := privateGatewayRoot(t)
	symlinkRoot := filepath.Join(filepath.Dir(realRoot), filepath.Base(realRoot)+"-link")
	if err := os.Symlink(realRoot, symlinkRoot); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Remove(symlinkRoot) })
	symlinkConfig := filepath.Join(symlinkRoot, "workerd.capnp")
	if err := os.WriteFile(filepath.Join(realRoot, "workerd.capnp"), []byte("config"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := validateServiceGatewaySet(symlinkConfig, []serviceGatewayDescriptor{{
		listenPath:       filepath.Join(symlinkRoot, "s0.sock"),
		upstreamPath:     upstreamPath,
		unavailableToken: testUnavailableToken,
	}}); errorCode(err, "") != CodeInvalidGateway {
		t.Fatalf("symlink execution root error = %v", err)
	}

	if err := os.Chmod(upstreamRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := validateServiceGatewaySet(configPath, []serviceGatewayDescriptor{valid}); errorCode(err, "") != CodeInvalidGateway {
		t.Fatalf("non-private upstream root error = %v", err)
	}
}

func TestServiceGatewayReturnsAuthenticated530BeforeReadingARequest(t *testing.T) {
	executionRoot := privateGatewayRoot(t)
	upstreamRoot := privateGatewayRoot(t)
	configPath := privateGatewayConfig(t, executionRoot)
	listenPath := filepath.Join(executionRoot, "s0.sock")
	upstreamPath := upstreamGatewayPath(upstreamRoot, 'a')
	session, pid := startGatewaySession(t, configPath, listenPath, upstreamPath)

	client, err := net.DialUnix("unix", nil, &net.UnixAddr{Name: listenPath, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if err := client.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatal(err)
	}
	response, err := io.ReadAll(client)
	if err != nil {
		t.Fatal(err)
	}
	expected := "HTTP/1.1 530 Service Unavailable\r\n" +
		"x-takoserver-selfhost-service-unavailable: " + testUnavailableToken + "\r\n" +
		"Connection: close\r\n" +
		"Content-Length: 0\r\n\r\n"
	if string(response) != expected {
		t.Fatalf("unavailable response = %q, want %q", response, expected)
	}

	session.send(t, stopFields(4))
	if got := session.reply(t); got != (reply{ID: 4, Kind: "stopped"}) {
		t.Fatalf("stop reply = %#v", got)
	}
	if err := session.wait(t); err != nil {
		t.Fatalf("guard returned %v", err)
	}
	if !waitForGone(pid) {
		t.Fatalf("child pid %d remains after stop", pid)
	}
	if _, err := os.Lstat(listenPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("listener remains after stopped ACK: %v", err)
	}
}

func TestServiceUnavailablePreloadedRequestDoesNotResetResponse(t *testing.T) {
	root := privateGatewayRoot(t)
	listenerPath := filepath.Join(root, "preloaded.sock")
	listener := listenGatewayUpstream(t, listenerPath)
	accepted := make(chan *net.UnixConn, 1)
	acceptErrors := make(chan error, 1)
	go func() {
		connection, err := listener.AcceptUnix()
		if err != nil {
			acceptErrors <- err
			return
		}
		accepted <- connection
	}()
	client, err := net.DialUnix("unix", nil, &net.UnixAddr{Name: listenerPath, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	var server *net.UnixConn
	select {
	case server = <-accepted:
	case err := <-acceptErrors:
		t.Fatal(err)
	case <-time.After(2 * time.Second):
		t.Fatal("server did not accept preloaded request connection")
	}

	body := bytes.Repeat([]byte("x"), 32*1024)
	request := append(
		[]byte("POST /offline HTTP/1.1\r\nHost: service\r\nContent-Length: 32768\r\n\r\n"),
		body...,
	)
	if _, err := io.Copy(client, bytes.NewReader(request)); err != nil {
		t.Fatal(err)
	}
	if err := client.CloseWrite(); err != nil {
		t.Fatal(err)
	}

	writeServiceUnavailable(server, testUnavailableToken)
	if err := server.Close(); err != nil {
		t.Fatal(err)
	}
	if err := client.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatal(err)
	}
	response, err := io.ReadAll(client)
	if err != nil {
		t.Fatalf("unavailable response ended with %v after %d bytes; want clean EOF", err, len(response))
	}
	expected := "HTTP/1.1 530 Service Unavailable\r\n" +
		"x-takoserver-selfhost-service-unavailable: " + testUnavailableToken + "\r\n" +
		"Connection: close\r\n" +
		"Content-Length: 0\r\n\r\n"
	if string(response) != expected {
		t.Fatalf("unavailable response = %q, want %q", response, expected)
	}
}

func TestServiceGatewayCopiesRawHalfClosedStreamsWithoutRewriting(t *testing.T) {
	executionRoot := privateGatewayRoot(t)
	upstreamRoot := privateGatewayRoot(t)
	configPath := privateGatewayConfig(t, executionRoot)
	listenPath := filepath.Join(executionRoot, "s0.sock")
	upstreamPath := upstreamGatewayPath(upstreamRoot, 'b')
	listener := listenGatewayUpstream(t, upstreamPath)
	requestBytes := []byte("POST /stream HTTP/1.1\r\nHost: chosen.example\r\nContent-Length: 4\r\n\r\nping")
	responseBytes := []byte("HTTP/1.1 599 Exact\r\nX-Raw: preserved\r\nContent-Length: 4\r\n\r\npong")
	exchange := make(chan struct {
		request []byte
		err     error
	}, 1)
	go func() {
		connection, err := listener.AcceptUnix()
		if err != nil {
			exchange <- struct {
				request []byte
				err     error
			}{err: err}
			return
		}
		defer connection.Close()
		_ = connection.SetDeadline(time.Now().Add(2 * time.Second))
		request, err := io.ReadAll(connection)
		if err == nil {
			_, err = io.Copy(connection, bytes.NewReader(responseBytes))
		}
		if err == nil {
			err = connection.CloseWrite()
		}
		exchange <- struct {
			request []byte
			err     error
		}{request: request, err: err}
	}()

	session, _ := startGatewaySession(t, configPath, listenPath, upstreamPath)
	client, err := net.DialUnix("unix", nil, &net.UnixAddr{Name: listenPath, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	_ = client.SetDeadline(time.Now().Add(2 * time.Second))
	if _, err := client.Write(requestBytes); err != nil {
		t.Fatal(err)
	}
	if err := client.CloseWrite(); err != nil {
		t.Fatal(err)
	}
	response, err := io.ReadAll(client)
	_ = client.Close()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(response, responseBytes) {
		t.Fatalf("raw response = %q, want %q", response, responseBytes)
	}
	result := <-exchange
	if result.err != nil {
		t.Fatal(result.err)
	}
	if !bytes.Equal(result.request, requestBytes) {
		t.Fatalf("raw request = %q, want %q", result.request, requestBytes)
	}
	session.send(t, stopFields(4))
	if got := session.reply(t); got.Kind != "stopped" {
		t.Fatalf("stop reply = %#v", got)
	}
	if err := session.wait(t); err != nil {
		t.Fatal(err)
	}
}

func TestStoppedACKClosesAndJoinsAnActiveServiceTunnel(t *testing.T) {
	executionRoot := privateGatewayRoot(t)
	upstreamRoot := privateGatewayRoot(t)
	configPath := privateGatewayConfig(t, executionRoot)
	listenPath := filepath.Join(executionRoot, "s0.sock")
	upstreamPath := upstreamGatewayPath(upstreamRoot, 'c')
	listener := listenGatewayUpstream(t, upstreamPath)
	accepted := make(chan *net.UnixConn, 1)
	go func() {
		connection, err := listener.AcceptUnix()
		if err == nil {
			accepted <- connection
		}
	}()
	session, _ := startGatewaySession(t, configPath, listenPath, upstreamPath)
	client, err := net.DialUnix("unix", nil, &net.UnixAddr{Name: listenPath, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	var upstream *net.UnixConn
	select {
	case upstream = <-accepted:
	case <-time.After(2 * time.Second):
		t.Fatal("gateway did not dial upstream")
	}
	defer upstream.Close()
	defer client.Close()

	session.send(t, stopFields(4))
	if got := session.reply(t); got != (reply{ID: 4, Kind: "stopped"}) {
		t.Fatalf("stop reply = %#v", got)
	}
	if _, err := os.Lstat(listenPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("listener exists after stopped ACK: %v", err)
	}
	for name, connection := range map[string]net.Conn{"client": client, "upstream": upstream} {
		assertGatewayConnectionClosed(t, name, connection)
	}
	if err := session.wait(t); err != nil {
		t.Fatal(err)
	}
}

func TestEOFAndLeaseExpiryRemoveServiceListenersAndConnections(t *testing.T) {
	for _, mode := range []string{"eof", "lease"} {
		t.Run(mode, func(t *testing.T) {
			executionRoot := privateGatewayRoot(t)
			upstreamRoot := privateGatewayRoot(t)
			configPath := privateGatewayConfig(t, executionRoot)
			listenPath := filepath.Join(executionRoot, "s0.sock")
			upstreamPath := upstreamGatewayPath(upstreamRoot, 'd')
			listener := listenGatewayUpstream(t, upstreamPath)
			accepted := make(chan *net.UnixConn, 1)
			go func() {
				connection, err := listener.AcceptUnix()
				if err == nil {
					accepted <- connection
				}
			}()
			session := newTestSession(t)
			lease := 5 * time.Second
			if mode == "lease" {
				lease = time.Second
			}
			session.send(t, registrationFields(t, lease, 10*time.Second))
			_ = session.reply(t)
			session.send(t, serviceGatewayFields(2, listenPath, upstreamPath))
			_ = session.reply(t)
			session.send(t, startFields(3, configPath))
			if got := session.reply(t); got.Kind != "started" {
				t.Fatalf("start reply = %#v", got)
			}
			client, err := net.DialUnix("unix", nil, &net.UnixAddr{Name: listenPath, Net: "unix"})
			if err != nil {
				t.Fatal(err)
			}
			defer client.Close()
			var upstream *net.UnixConn
			select {
			case upstream = <-accepted:
			case <-time.After(2 * time.Second):
				t.Fatal("gateway did not dial upstream")
			}
			defer upstream.Close()
			if mode == "eof" {
				session.closeInput()
			} else if got := session.reply(t); got.Kind != "error" || got.Code != CodeLeaseExpired {
				t.Fatalf("lease expiry reply = %#v", got)
			}
			err = session.wait(t)
			if mode == "eof" && err != nil {
				t.Fatalf("EOF cleanup returned %v", err)
			}
			if mode == "lease" && errorCode(err, "") != CodeLeaseExpired {
				t.Fatalf("lease cleanup returned %v", err)
			}
			if _, err := os.Lstat(listenPath); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("listener remains after %s: %v", mode, err)
			}
			for name, connection := range map[string]net.Conn{"client": client, "upstream": upstream} {
				assertGatewayConnectionClosed(t, name+" after "+mode, connection)
			}
		})
	}
}

func TestServiceGatewayNeverStealsOrUnlinksAnotherSocket(t *testing.T) {
	executionRoot := privateGatewayRoot(t)
	upstreamRoot := privateGatewayRoot(t)
	configPath := privateGatewayConfig(t, executionRoot)
	listenPath := filepath.Join(executionRoot, "s0.sock")
	upstreamPath := upstreamGatewayPath(upstreamRoot, 'e')
	existing := listenGatewayUpstream(t, listenPath)
	session := configureGatewaySession(t, configPath, listenPath, upstreamPath)
	session.send(t, startFields(3, configPath))
	if got := session.reply(t); got.Kind != "error" || got.Code != CodeInvalidGateway {
		t.Fatalf("preexisting socket reply = %#v", got)
	}
	if errorCode(session.wait(t), "") != CodeInvalidGateway {
		t.Fatal("preexisting socket did not fail the guard")
	}
	probe, err := net.DialUnix("unix", nil, &net.UnixAddr{Name: listenPath, Net: "unix"})
	if err != nil {
		t.Fatalf("preexisting listener was stolen: %v", err)
	}
	_ = probe.Close()
	_ = existing.Close()
	if _, err := os.Lstat(listenPath); err != nil {
		t.Fatalf("preexisting socket was unlinked: %v", err)
	}
}

func TestServiceGatewayCleanupDoesNotUnlinkAReplacementSocket(t *testing.T) {
	executionRoot := privateGatewayRoot(t)
	upstreamRoot := privateGatewayRoot(t)
	configPath := privateGatewayConfig(t, executionRoot)
	listenPath := filepath.Join(executionRoot, "s0.sock")
	upstreamPath := upstreamGatewayPath(upstreamRoot, 'f')
	validated, err := validateServiceGatewaySet(
		configPath,
		[]serviceGatewayDescriptor{gatewayDescriptor(listenPath, upstreamPath)},
	)
	if err != nil {
		t.Fatal(err)
	}
	group := newServiceGatewayGroup(validated, nil)
	if err := group.start(); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(listenPath); err != nil {
		t.Fatal(err)
	}
	replacement := listenGatewayUpstream(t, listenPath)
	if err := group.stopAndWait(); err != nil {
		t.Fatal(err)
	}
	probe, err := net.DialUnix("unix", nil, &net.UnixAddr{Name: listenPath, Net: "unix"})
	if err != nil {
		t.Fatalf("replacement listener was unlinked: %v", err)
	}
	_ = probe.Close()
	_ = replacement.Close()
}

func TestServiceGatewayCapsActiveTunnelsAtManifestBound(t *testing.T) {
	executionRoot := privateGatewayRoot(t)
	upstreamRoot := privateGatewayRoot(t)
	configPath := privateGatewayConfig(t, executionRoot)
	listenPath := filepath.Join(executionRoot, "s0.sock")
	upstreamPath := upstreamGatewayPath(upstreamRoot, '2')
	listener := listenGatewayUpstream(t, upstreamPath)
	validated, err := validateServiceGatewaySet(
		configPath,
		[]serviceGatewayDescriptor{gatewayDescriptor(listenPath, upstreamPath)},
	)
	if err != nil {
		t.Fatal(err)
	}
	group := newServiceGatewayGroup(validated, nil)
	if err := group.start(); err != nil {
		t.Fatal(err)
	}
	clients := make([]*net.UnixConn, 0, MaxServiceGateways)
	upstreams := make([]*net.UnixConn, 0, MaxServiceGateways)
	t.Cleanup(func() {
		_ = group.stopAndWait()
		for _, connection := range append(clients, upstreams...) {
			_ = connection.Close()
		}
	})
	accepted := make(chan *net.UnixConn, MaxServiceGateways)
	acceptErrors := make(chan error, 1)
	go func() {
		for index := 0; index < MaxServiceGateways; index++ {
			connection, err := listener.AcceptUnix()
			if err != nil {
				acceptErrors <- err
				return
			}
			accepted <- connection
		}
	}()
	for index := 0; index < MaxServiceGateways; index++ {
		client, err := net.DialUnix("unix", nil, &net.UnixAddr{Name: listenPath, Net: "unix"})
		if err != nil {
			t.Fatal(err)
		}
		clients = append(clients, client)
		select {
		case upstream := <-accepted:
			upstreams = append(upstreams, upstream)
		case err := <-acceptErrors:
			t.Fatal(err)
		case <-time.After(2 * time.Second):
			t.Fatalf("gateway established only %d of %d bounded tunnels", index, MaxServiceGateways)
		}
	}

	overflow, err := net.DialUnix("unix", nil, &net.UnixAddr{Name: listenPath, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer overflow.Close()
	if err := overflow.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatal(err)
	}
	response, err := io.ReadAll(overflow)
	if err != nil {
		t.Fatal(err)
	}
	expected := "HTTP/1.1 530 Service Unavailable\r\n" +
		"x-takoserver-selfhost-service-unavailable: " + testUnavailableToken + "\r\n" +
		"Connection: close\r\n" +
		"Content-Length: 0\r\n\r\n"
	if string(response) != expected {
		t.Fatalf("overflow response = %q, want %q", response, expected)
	}
}

func TestServiceGatewayConcurrentStopJoinsAllConnections(t *testing.T) {
	executionRoot := privateGatewayRoot(t)
	upstreamRoot := privateGatewayRoot(t)
	configPath := privateGatewayConfig(t, executionRoot)
	listenPath := filepath.Join(executionRoot, "s0.sock")
	upstreamPath := upstreamGatewayPath(upstreamRoot, '1')
	listener := listenGatewayUpstream(t, upstreamPath)
	validated, err := validateServiceGatewaySet(
		configPath,
		[]serviceGatewayDescriptor{gatewayDescriptor(listenPath, upstreamPath)},
	)
	if err != nil {
		t.Fatal(err)
	}
	group := newServiceGatewayGroup(validated, nil)
	if err := group.start(); err != nil {
		t.Fatal(err)
	}
	const connectionCount = 16
	accepted := make(chan *net.UnixConn, connectionCount)
	acceptErrors := make(chan error, 1)
	go func() {
		for index := 0; index < connectionCount; index++ {
			connection, err := listener.AcceptUnix()
			if err != nil {
				acceptErrors <- err
				return
			}
			accepted <- connection
		}
	}()
	clients := make([]*net.UnixConn, 0, connectionCount)
	upstreams := make([]*net.UnixConn, 0, connectionCount)
	for index := 0; index < connectionCount; index++ {
		client, err := net.DialUnix("unix", nil, &net.UnixAddr{Name: listenPath, Net: "unix"})
		if err != nil {
			t.Fatal(err)
		}
		clients = append(clients, client)
		select {
		case upstream := <-accepted:
			upstreams = append(upstreams, upstream)
		case err := <-acceptErrors:
			t.Fatal(err)
		case <-time.After(2 * time.Second):
			t.Fatal("gateway did not establish all upstream connections")
		}
	}
	var stopped sync.WaitGroup
	errorsByStop := make(chan error, 8)
	for index := 0; index < 8; index++ {
		stopped.Add(1)
		go func() {
			defer stopped.Done()
			errorsByStop <- group.stopAndWait()
		}()
	}
	stopped.Wait()
	close(errorsByStop)
	for err := range errorsByStop {
		if err != nil {
			t.Fatal(err)
		}
	}
	for _, connection := range append(clients, upstreams...) {
		assertGatewayConnectionClosed(t, "connection after concurrent stop", connection)
		_ = connection.Close()
	}
	if _, err := os.Lstat(listenPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("listener remains after concurrent stop: %v", err)
	}
}
