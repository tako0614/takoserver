//go:build linux && amd64

package guard

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

const testIdentity = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

// TestMain is the explicit, internal child injection seam. The guard still
// invokes this exact test binary as [binary, "serve", configPath]; no general
// command is exposed by the test or production CLI.
func TestMain(main *testing.M) {
	if len(os.Args) == 3 && os.Args[1] == "serve" {
		if err := runTestChild(os.Args[2]); err != nil {
			os.Exit(3)
		}
		return
	}
	os.Exit(main.Run())
}

func runTestChild(markerPath string) error {
	if !filepath.IsAbs(markerPath) {
		return errors.New("test child marker must be absolute")
	}
	if err := os.WriteFile(markerPath, []byte(strconv.Itoa(os.Getpid())), 0o600); err != nil {
		return err
	}
	for {
		runtime.Gosched()
	}
}

type testSession struct {
	input  *io.PipeWriter
	output *bufio.Reader
	done   chan error
}

func newTestSession(t *testing.T) *testSession {
	t.Helper()
	inReader, input := io.Pipe()
	outReader, outWriter := io.Pipe()
	done := make(chan error, 1)
	executable := testExecutable(t)
	go func() {
		err := Run(Options{WorkerdBinary: executable, In: inReader, Out: outWriter})
		_ = outWriter.Close()
		done <- err
	}()
	return &testSession{input: input, output: bufio.NewReader(outReader), done: done}
}

func testExecutable(t *testing.T) string {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return executable
}

func (session *testSession) send(t *testing.T, value any) {
	t.Helper()
	if err := json.NewEncoder(session.input).Encode(value); err != nil {
		t.Fatal(err)
	}
}

func (session *testSession) sendRaw(t *testing.T, raw string) {
	t.Helper()
	if _, err := io.WriteString(session.input, raw); err != nil {
		t.Fatal(err)
	}
}

func (session *testSession) reply(t *testing.T) reply {
	t.Helper()
	line, err := readWithTimeout(session.output, 2*time.Second)
	if err != nil {
		t.Fatalf("guard reply: %v", err)
	}
	var result reply
	if err := json.Unmarshal(line, &result); err != nil {
		t.Fatalf("decode guard reply %q: %v", line, err)
	}
	return result
}

func readWithTimeout(reader *bufio.Reader, timeout time.Duration) ([]byte, error) {
	result := make(chan struct {
		line []byte
		err  error
	}, 1)
	go func() {
		line, err := reader.ReadBytes('\n')
		result <- struct {
			line []byte
			err  error
		}{line: bytes.TrimSuffix(line, []byte{'\n'}), err: err}
	}()
	select {
	case value := <-result:
		return value.line, value.err
	case <-time.After(timeout):
		return nil, errors.New("timed out waiting for guard reply")
	}
}

func (session *testSession) closeInput() {
	_ = session.input.Close()
}

func (session *testSession) wait(t *testing.T) error {
	t.Helper()
	select {
	case err := <-session.done:
		return err
	case <-time.After(2 * time.Second):
		t.Fatal("guard did not exit")
		return nil
	}
}

func registrationFields(t *testing.T, lease, lifetime time.Duration) map[string]any {
	t.Helper()
	now := time.Now().UnixMilli()
	return map[string]any{
		"id":         1,
		"op":         "register",
		"identity":   testIdentity,
		"deadlineAt": now + lifetime.Milliseconds(),
		"until":      now + lease.Milliseconds(),
	}
}

func startFields(id int, configPath string) map[string]any {
	return map[string]any{"id": id, "op": "start", "identity": testIdentity, "configPath": configPath}
}

func stopFields(id int) map[string]any {
	return map[string]any{"id": id, "op": "stop", "identity": testIdentity}
}

func extendFields(id int, until int64) map[string]any {
	return map[string]any{"id": id, "op": "extend", "identity": testIdentity, "until": until}
}

func TestGuardStopBeforeStartDoesNotSpawnOrPermitRestart(t *testing.T) {
	session := newTestSession(t)
	session.send(t, registrationFields(t, 5*time.Second, 10*time.Second))
	if got := session.reply(t); got != (reply{ID: 1, Kind: "registered"}) {
		t.Fatalf("register reply = %#v", got)
	}
	session.send(t, stopFields(2))
	if got := session.reply(t); got != (reply{ID: 2, Kind: "stopped"}) {
		t.Fatalf("stop reply = %#v", got)
	}
	if err := session.wait(t); err != nil {
		t.Fatalf("guard stop returned %v", err)
	}
	// The one-use guard exits after a proven stop; there is no later channel
	// through which a start could resurrect a child.
}

func TestGuardStartIsAcknowledgedOnlyAfterChildAndRejectsRestart(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "child.pid")
	session := newTestSession(t)
	session.send(t, registrationFields(t, 5*time.Second, 10*time.Second))
	_ = session.reply(t)
	session.send(t, startFields(2, marker))
	if got := session.reply(t); got != (reply{ID: 2, Kind: "started"}) {
		t.Fatalf("start reply = %#v", got)
	}
	pid := waitForPID(t, marker)
	session.send(t, startFields(3, marker))
	if got := session.reply(t); got.ID != 3 || got.Kind != "error" || got.Code != CodeAlreadyStarted {
		t.Fatalf("restart reply = %#v", got)
	}
	if err := session.wait(t); errorCode(err, "") != CodeAlreadyStarted {
		t.Fatalf("restart returned %v", err)
	}
	if !waitForGone(pid) {
		t.Fatalf("child pid %d remains after restart rejection", pid)
	}
}

func TestGuardRejectsBadIdentityFrameAndID(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		code Code
	}{
		{name: "identity", raw: `{"id":1,"op":"register","identity":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","deadlineAt":4102444800000,"until":4102444799000}` + "\n", code: CodeInvalidIdentity},
		{name: "frame", raw: `{"id":1,"op":"register","identity":"` + testIdentity + `","deadlineAt":4102444800000,"until":4102444799000,"extra":true}` + "\n", code: CodeInvalidFrame},
		{name: "id", raw: `{"id":2,"op":"register","identity":"` + testIdentity + `","deadlineAt":4102444800000,"until":4102444799000}` + "\n", code: CodeInvalidID},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			session := newTestSession(t)
			session.sendRaw(t, testCase.raw)
			got := session.reply(t)
			if got.Kind != "error" || got.Code != testCase.code {
				t.Fatalf("bad input reply = %#v, want %s", got, testCase.code)
			}
			if err := session.wait(t); errorCode(err, "") != testCase.code {
				t.Fatalf("bad input returned %v", err)
			}
		})
	}
}

func TestGuardRejectsLateAndOverLifetimeRenewal(t *testing.T) {
	t.Run("over-lifetime", func(t *testing.T) {
		session := newTestSession(t)
		session.send(t, registrationFields(t, 5*time.Second, 10*time.Second))
		_ = session.reply(t)
		now := time.Now().UnixMilli()
		session.send(t, extendFields(2, now+11_000))
		got := session.reply(t)
		if got.Code != CodeInvalidLease {
			t.Fatalf("over-lifetime reply = %#v", got)
		}
		if err := session.wait(t); errorCode(err, "") != CodeInvalidLease {
			t.Fatalf("over-lifetime returned %v", err)
		}
	})

	t.Run("late", func(t *testing.T) {
		controller := newController(testExecutable(t))
		controller.registered = true
		controller.identity = testIdentity
		controller.deadlineMono = time.Now().Add(time.Second)
		controller.leaseMono = time.Now().Add(-time.Millisecond)
		controller.deadlineAt = time.Now().Add(time.Second).UnixMilli()
		controller.until = time.Now().UnixMilli() - 1
		err := controller.extend(request{ID: 2, Identity: testIdentity, Until: controller.until})
		if errorCode(err, "") != CodeLeaseExpired {
			t.Fatalf("late renewal error = %v", err)
		}
		if controller.terminalCode() != CodeLeaseExpired {
			t.Fatalf("late renewal terminal = %s", controller.terminalCode())
		}
	})
}

func TestGuardStopReapsCPUChildAndControllerEOFReapsCPUChild(t *testing.T) {
	for _, mode := range []string{"stop", "eof"} {
		t.Run(mode, func(t *testing.T) {
			marker := filepath.Join(t.TempDir(), "child.pid")
			session := newTestSession(t)
			session.send(t, registrationFields(t, 5*time.Second, 10*time.Second))
			_ = session.reply(t)
			session.send(t, startFields(2, marker))
			_ = session.reply(t)
			pid := waitForPID(t, marker)
			if mode == "stop" {
				session.send(t, stopFields(3))
				if got := session.reply(t); got.Kind != "stopped" {
					t.Fatalf("stop reply = %#v", got)
				}
			} else {
				session.closeInput()
			}
			if err := session.wait(t); err != nil {
				t.Fatalf("guard %s returned %v", mode, err)
			}
			if !waitForGone(pid) {
				t.Fatalf("child pid %d remains after %s", pid, mode)
			}
		})
	}
}

func waitForPID(t *testing.T, path string) int {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		value, err := os.ReadFile(path)
		if err == nil {
			pid, parseErr := strconv.Atoi(strings.TrimSpace(string(value)))
			if parseErr == nil && pid > 0 {
				return pid
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("child pid marker %s did not appear", path)
	return 0
}

func waitForGone(pid int) bool {
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(fmt.Sprintf("/proc/%d", pid)); errors.Is(err, os.ErrNotExist) {
			return true
		}
		time.Sleep(5 * time.Millisecond)
	}
	return false
}
