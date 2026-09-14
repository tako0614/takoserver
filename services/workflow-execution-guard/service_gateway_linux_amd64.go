//go:build linux && amd64

package guard

import (
	"context"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

const (
	// The manifest bounds descriptors, but has no separate portable request-
	// concurrency contract. Reuse that bound as this guard process's global
	// tunnel budget so one execution cannot grow goroutines and file descriptors
	// without limit.
	maxServiceGatewayConnections = MaxServiceGateways
	serviceGatewayDialTimeout    = 250 * time.Millisecond
	serviceGatewayWriteTimeout   = 250 * time.Millisecond
	serviceGatewayDrainTimeout   = 250 * time.Millisecond
	serviceGatewayStopTimeout    = time.Second
)

var errServiceGatewayStopTimeout = errors.New("service gateway did not stop before timeout")

type privateDirectory struct {
	path string
	dev  uint64
	ino  uint64
	uid  uint32
}

type serviceGatewayDescriptor struct {
	listenPath       string
	upstreamPath     string
	unavailableToken string
	listenRoot       privateDirectory
	upstreamRoot     privateDirectory
}

type ownedUnixSocket struct {
	path string
	dev  uint64
	ino  uint64
	uid  uint32
}

type serviceGatewayGroup struct {
	descriptors []serviceGatewayDescriptor
	context     context.Context
	cancel      context.CancelFunc
	onFailure   func()

	mu          sync.Mutex
	stopping    bool
	listeners   map[*net.UnixListener]ownedUnixSocket
	connections map[net.Conn]struct{}
	slots       chan struct{}
	waitGroup   sync.WaitGroup
	stopOnce    sync.Once
	waitOnce    sync.Once
	failureOnce sync.Once
	done        chan struct{}
	waitErrMu   sync.Mutex
	waitErr     error
}

func validateServiceGatewaySet(
	configPath string,
	descriptors []serviceGatewayDescriptor,
) ([]serviceGatewayDescriptor, error) {
	if len(descriptors) == 0 || len(descriptors) > MaxServiceGateways {
		return nil, guardError(CodeInvalidGateway, errors.New("service gateway count is invalid"))
	}
	if !filepath.IsAbs(configPath) || filepath.Clean(configPath) != configPath ||
		filepath.Base(configPath) == "." || filepath.Base(configPath) == string(filepath.Separator) {
		return nil, guardError(CodeInvalidConfigPath, errors.New("config path must be canonical"))
	}
	configRoot, err := validatePrivateDirectory(filepath.Dir(configPath))
	if err != nil {
		return nil, guardError(CodeInvalidGateway, err)
	}
	if err := validatePrivateConfig(configPath, configRoot); err != nil {
		return nil, guardError(CodeInvalidGateway, err)
	}

	validated := make([]serviceGatewayDescriptor, 0, len(descriptors))
	listenPaths := make(map[string]struct{}, len(descriptors))
	runSocketPath := filepath.Join(configRoot.path, "run.sock")
	for _, descriptor := range descriptors {
		if !validUnixSocketPath(descriptor.listenPath) ||
			!validUnixSocketPath(descriptor.upstreamPath) ||
			!validUpstreamSocketName(descriptor.upstreamPath) ||
			!validIdentity(descriptor.unavailableToken) {
			return nil, guardError(CodeInvalidGateway, errors.New("service gateway descriptor is invalid"))
		}
		if filepath.Dir(descriptor.listenPath) != configRoot.path ||
			descriptor.listenPath == configPath ||
			descriptor.listenPath == runSocketPath ||
			descriptor.listenPath == descriptor.upstreamPath {
			return nil, guardError(CodeInvalidGateway, errors.New("service gateway listener is outside its execution root or collides"))
		}
		if _, exists := listenPaths[descriptor.listenPath]; exists {
			return nil, guardError(CodeInvalidGateway, errors.New("duplicate service gateway listener"))
		}
		listenPaths[descriptor.listenPath] = struct{}{}
		if _, err := os.Lstat(descriptor.listenPath); err == nil {
			return nil, guardError(CodeInvalidGateway, errors.New("service gateway listener path already exists"))
		} else if !errors.Is(err, os.ErrNotExist) {
			return nil, guardError(CodeInvalidGateway, err)
		}
		upstreamRoot, err := validatePrivateDirectory(filepath.Dir(descriptor.upstreamPath))
		if err != nil {
			return nil, guardError(CodeInvalidGateway, err)
		}
		if err := validateExistingUpstreamSocket(descriptor.upstreamPath); err != nil {
			return nil, guardError(CodeInvalidGateway, err)
		}
		descriptor.listenRoot = configRoot
		descriptor.upstreamRoot = upstreamRoot
		validated = append(validated, descriptor)
	}
	return validated, nil
}

func validatePrivateDirectory(path string) (privateDirectory, error) {
	var result privateDirectory
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return result, errors.New("private socket root must be canonical and absolute")
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil || resolved != path {
		return result, errors.New("private socket root must exist without symlinks")
	}
	info, err := os.Lstat(path)
	if err != nil {
		return result, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() || info.Mode().Perm() != 0o700 || stat.Uid != uint32(os.Geteuid()) {
		return result, errors.New("private socket root must be current-uid mode 0700")
	}
	return privateDirectory{path: path, dev: uint64(stat.Dev), ino: stat.Ino, uid: stat.Uid}, nil
}

func validatePrivateConfig(path string, root privateDirectory) error {
	if filepath.Dir(path) != root.path {
		return errors.New("private config must be directly inside its execution root")
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 || stat.Uid != root.uid {
		return errors.New("private config must be a current-uid mode 0600 regular file")
	}
	return nil
}

func validateExistingUpstreamSocket(path string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || info.Mode()&os.ModeSocket == 0 || stat.Uid != uint32(os.Geteuid()) {
		return errors.New("existing upstream must be a current-uid Unix socket")
	}
	return nil
}

func samePrivateDirectory(expected privateDirectory) bool {
	current, err := validatePrivateDirectory(expected.path)
	return err == nil && current.dev == expected.dev && current.ino == expected.ino && current.uid == expected.uid
}

func identifyOwnedUnixSocket(path string) (ownedUnixSocket, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return ownedUnixSocket{}, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || info.Mode()&os.ModeSocket == 0 || stat.Uid != uint32(os.Geteuid()) {
		return ownedUnixSocket{}, errors.New("bound listener is not a current-uid Unix socket")
	}
	return ownedUnixSocket{path: path, dev: uint64(stat.Dev), ino: stat.Ino, uid: stat.Uid}, nil
}

func (socket ownedUnixSocket) removeIfOwned() error {
	info, err := os.Lstat(socket.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || info.Mode()&os.ModeSocket == 0 || uint64(stat.Dev) != socket.dev ||
		stat.Ino != socket.ino || stat.Uid != socket.uid {
		// A removed/replaced path is not ours to unlink.
		return nil
	}
	return os.Remove(socket.path)
}

func newServiceGatewayGroup(
	descriptors []serviceGatewayDescriptor,
	onFailure func(),
) *serviceGatewayGroup {
	groupContext, cancel := context.WithCancel(context.Background())
	return &serviceGatewayGroup{
		descriptors: append([]serviceGatewayDescriptor(nil), descriptors...),
		context:     groupContext,
		cancel:      cancel,
		onFailure:   onFailure,
		listeners:   make(map[*net.UnixListener]ownedUnixSocket, len(descriptors)),
		connections: make(map[net.Conn]struct{}),
		slots:       make(chan struct{}, maxServiceGatewayConnections),
		done:        make(chan struct{}),
	}
}

func (group *serviceGatewayGroup) start() error {
	for _, descriptor := range group.descriptors {
		if !samePrivateDirectory(descriptor.listenRoot) {
			return group.failStart(errors.New("service gateway execution root changed"))
		}
		listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: descriptor.listenPath, Net: "unix"})
		if err != nil {
			return group.failStart(err)
		}
		// net.ListenUnix otherwise removes its pathname on Close. Disable that
		// behavior and unlink only the exact inode created by this listener.
		listener.SetUnlinkOnClose(false)
		owned, err := identifyOwnedUnixSocket(descriptor.listenPath)
		if err == nil {
			err = os.Chmod(descriptor.listenPath, 0o600)
		}
		if err != nil {
			_ = listener.Close()
			_ = owned.removeIfOwned()
			return group.failStart(err)
		}
		group.mu.Lock()
		if group.stopping {
			group.mu.Unlock()
			_ = listener.Close()
			_ = owned.removeIfOwned()
			return guardError(CodeStopped, nil)
		}
		group.listeners[listener] = owned
		group.waitGroup.Add(1)
		group.mu.Unlock()
		go group.accept(descriptor, listener)
	}
	group.mu.Lock()
	stopping := group.stopping
	group.mu.Unlock()
	if stopping {
		return guardError(CodeStopped, nil)
	}
	return nil
}

func (group *serviceGatewayGroup) failStart(cause error) error {
	group.stop()
	if err := group.wait(); err != nil {
		return guardError(CodeServiceGateway, err)
	}
	return guardError(CodeServiceGateway, cause)
}

func (group *serviceGatewayGroup) accept(
	descriptor serviceGatewayDescriptor,
	listener *net.UnixListener,
) {
	defer group.waitGroup.Done()
	for {
		connection, err := listener.AcceptUnix()
		if err != nil {
			if !group.isStopping() {
				group.failureOnce.Do(func() {
					if group.onFailure != nil {
						group.onFailure()
					}
				})
			}
			return
		}
		group.admit(descriptor, connection)
	}
}

func (group *serviceGatewayGroup) admit(
	descriptor serviceGatewayDescriptor,
	client *net.UnixConn,
) {
	group.mu.Lock()
	if group.stopping {
		group.mu.Unlock()
		_ = client.Close()
		return
	}
	select {
	case group.slots <- struct{}{}:
		group.connections[client] = struct{}{}
		group.waitGroup.Add(1)
		group.mu.Unlock()
		go group.forward(descriptor, client)
	default:
		group.mu.Unlock()
		// Admission is bounded globally. An overflow is a Host-side pre-connect
		// unavailability and uses the same authenticated empty response.
		writeServiceUnavailable(client, descriptor.unavailableToken)
		_ = client.Close()
	}
}

func (group *serviceGatewayGroup) forward(
	descriptor serviceGatewayDescriptor,
	client *net.UnixConn,
) {
	var upstream net.Conn
	defer func() {
		_ = client.Close()
		if upstream != nil {
			_ = upstream.Close()
		}
		group.mu.Lock()
		delete(group.connections, client)
		if upstream != nil {
			delete(group.connections, upstream)
		}
		<-group.slots
		group.mu.Unlock()
		group.waitGroup.Done()
	}()

	if !samePrivateDirectory(descriptor.upstreamRoot) || validateExistingUpstreamSocket(descriptor.upstreamPath) != nil {
		if !group.isStopping() {
			writeServiceUnavailable(client, descriptor.unavailableToken)
		}
		return
	}
	dialer := net.Dialer{Timeout: serviceGatewayDialTimeout}
	connected, err := dialer.DialContext(group.context, "unix", descriptor.upstreamPath)
	if err != nil {
		if !group.isStopping() {
			writeServiceUnavailable(client, descriptor.unavailableToken)
		}
		return
	}
	upstream = connected
	group.mu.Lock()
	if group.stopping {
		group.mu.Unlock()
		return
	}
	group.connections[upstream] = struct{}{}
	group.mu.Unlock()

	// No client bytes are read until the upstream connection exists. After that
	// point both streams are copied without HTTP parsing or reconstruction. Each
	// EOF half-closes only the opposite write side, preserving streaming and
	// upgraded/WebSocket connections until their peer or STOP closes them.
	copied := make(chan struct{}, 2)
	go copyAndHalfClose(upstream, client, copied)
	go copyAndHalfClose(client, upstream, copied)
	<-copied
	<-copied
}

func copyAndHalfClose(destination net.Conn, source net.Conn, done chan<- struct{}) {
	_, _ = io.Copy(destination, source)
	if half, ok := destination.(interface{ CloseWrite() error }); ok {
		_ = half.CloseWrite()
	}
	done <- struct{}{}
}

func writeServiceUnavailable(connection net.Conn, token string) {
	_ = connection.SetWriteDeadline(time.Now().Add(serviceGatewayWriteTimeout))
	response := []byte("HTTP/1.1 530 Service Unavailable\r\n" +
		"x-takoserver-selfhost-service-unavailable: " + token + "\r\n" +
		"Connection: close\r\n" +
		"Content-Length: 0\r\n\r\n")
	for len(response) > 0 {
		written, err := connection.Write(response)
		if err != nil || written <= 0 {
			break
		}
		response = response[written:]
	}
	if half, ok := connection.(interface{ CloseWrite() error }); ok {
		_ = half.CloseWrite()
	}

	// Linux reports ECONNRESET to the peer when a Unix stream is fully closed
	// with unread receive data. Half-close after the fixed response, then drain
	// raw request bytes for a short absolute interval so the authenticated 530
	// remains visible without parsing or waiting indefinitely for a keep-alive
	// client. STOP closes admitted connections and interrupts this read.
	deadline := time.Now().Add(serviceGatewayDrainTimeout)
	if err := connection.SetReadDeadline(deadline); err != nil {
		return
	}
	buffer := make([]byte, 32*1024)
	for time.Now().Before(deadline) {
		if _, err := connection.Read(buffer); err != nil {
			return
		}
	}
}

func (group *serviceGatewayGroup) isStopping() bool {
	group.mu.Lock()
	defer group.mu.Unlock()
	return group.stopping
}

func (group *serviceGatewayGroup) stop() {
	group.stopOnce.Do(func() {
		group.mu.Lock()
		group.stopping = true
		group.cancel()
		listeners := make([]*net.UnixListener, 0, len(group.listeners))
		sockets := make([]ownedUnixSocket, 0, len(group.listeners))
		for listener, socket := range group.listeners {
			listeners = append(listeners, listener)
			sockets = append(sockets, socket)
		}
		connections := make([]net.Conn, 0, len(group.connections))
		for connection := range group.connections {
			connections = append(connections, connection)
		}
		group.mu.Unlock()

		for _, listener := range listeners {
			_ = listener.Close()
		}
		for _, connection := range connections {
			_ = connection.Close()
		}
		go func() {
			group.waitGroup.Wait()
			for _, socket := range sockets {
				group.setWaitError(socket.removeIfOwned())
			}
			close(group.done)
		}()
	})
}

func (group *serviceGatewayGroup) wait() error {
	group.stop()
	group.waitOnce.Do(func() {
		select {
		case <-group.done:
		case <-time.After(serviceGatewayStopTimeout):
			group.setWaitError(errServiceGatewayStopTimeout)
		}
	})
	return group.waitErrorValue()
}

func (group *serviceGatewayGroup) stopAndWait() error {
	group.stop()
	return group.wait()
}

func (group *serviceGatewayGroup) setWaitError(err error) {
	if err == nil {
		return
	}
	group.waitErrMu.Lock()
	if group.waitErr == nil {
		group.waitErr = err
	}
	group.waitErrMu.Unlock()
}

func (group *serviceGatewayGroup) waitErrorValue() error {
	group.waitErrMu.Lock()
	defer group.waitErrMu.Unlock()
	return group.waitErr
}
