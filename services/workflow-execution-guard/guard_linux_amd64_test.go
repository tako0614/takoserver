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
	"sync"
	"testing"
	"time"
)

const testIdentity = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

// TestMain is the explicit, internal child injection seam. The guard still
// invokes this exact test binary as [binary, "serve", configPath], optionally
// with the fixed candidate switch; no general command or argv is exposed.
func TestMain(main *testing.M) {
	if len(os.Args) == 4 && os.Args[1] == "serve" && os.Args[3] == "--experimental" {
		if err := os.WriteFile(os.Args[2]+".experimental", []byte("enabled"), 0o600); err != nil {
			os.Exit(3)
		}
		if err := runTestChild(os.Args[2]); err != nil {
			os.Exit(3)
		}
		return
	}
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
	return newTestSessionWithOptions(t, Options{})
}

func newTestSessionWithOptions(t *testing.T, options Options) *testSession {
	t.Helper()
	inReader, input := io.Pipe()
	outReader, outWriter := io.Pipe()
	done := make(chan error, 1)
	executable := testExecutable(t)
	options.WorkerdBinary, options.In, options.Out = executable, inReader, outWriter
	go func() {
		err := Run(options)
		_ = outWriter.Close()
		done <- err
	}()
	return &testSession{input: input, output: bufio.NewReader(outReader), done: done}
}

func TestGuardExperimentalCandidateIsExplicitAndStillReaped(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		t.Run(strconv.FormatBool(enabled), func(t *testing.T) {
			marker := filepath.Join(t.TempDir(), "child.pid")
			session := newTestSessionWithOptions(t, Options{ExperimentalWorkerdCandidate: enabled})
			session.send(t, registrationFields(t, 5*time.Second, 10*time.Second))
			_ = session.reply(t)
			session.send(t, startFields(2, marker))
			if got := session.reply(t); got != (reply{ID: 2, Kind: "started"}) {
				t.Fatalf("start reply = %#v", got)
			}
			pid := waitForPID(t, marker)
			_, err := os.Stat(marker + ".experimental")
			if (enabled && err != nil) || (!enabled && !os.IsNotExist(err)) {
				t.Fatalf("experimental=%v marker error: %v", enabled, err)
			}
			session.send(t, map[string]any{"id": 3, "op": "stop", "identity": testIdentity})
			if got := session.reply(t); got != (reply{ID: 3, Kind: "stopped"}) {
				t.Fatalf("stop reply = %#v", got)
			}
			if err := session.wait(t); err != nil {
				t.Fatal(err)
			}
			if !waitForGone(pid) {
				t.Fatalf("child pid %d remains", pid)
			}
		})
	}
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

func TestDecodeRequestOptionalJournalTokenAndStrictRegisterFields(t *testing.T) {
	fields := registrationFields(t, 5*time.Second, 10*time.Second)
	fields["journalToken"] = testIdentity
	raw, err := json.Marshal(fields)
	if err != nil {
		t.Fatal(err)
	}
	request, err := decodeRequest(raw)
	if err != nil {
		t.Fatalf("journal registration rejected: %v", err)
	}
	if request.JournalToken != testIdentity {
		t.Fatalf("journal token = %q, want %q", request.JournalToken, testIdentity)
	}

	for _, invalid := range []string{"A" + testIdentity[1:], testIdentity + "0", strings.ToUpper(testIdentity)} {
		fields["journalToken"] = invalid
		raw, err := json.Marshal(fields)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := decodeRequest(raw); errorCode(err, "") != CodeInvalidFrame {
			t.Fatalf("journal token %q error = %v", invalid, err)
		}
	}

	fields["journalToken"] = testIdentity
	fields["extra"] = true
	raw, err = json.Marshal(fields)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decodeRequest(raw); errorCode(err, "") != CodeInvalidFrame {
		t.Fatalf("unknown register field error = %v", err)
	}

	start := startFields(2, "/tmp/workflow.capnp")
	start["journalToken"] = testIdentity
	raw, err = json.Marshal(start)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decodeRequest(raw); errorCode(err, "") != CodeInvalidFrame {
		t.Fatalf("journal token on start error = %v", err)
	}
}

func TestJournalMarkerStreamAcceptsOnlyConsecutiveTrustedMarkers(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		want     []int64
		wantCode Code
	}{
		{name: "accepted", input: journalMarkerPrefix + testIdentity + ":1\n" + journalMarkerPrefix + testIdentity + ":2\n", want: []int64{1, 2}},
		{name: "wrong-token-is-ordinary", input: journalMarkerPrefix + strings.Repeat("f", 64) + ":9\n" + journalMarkerPrefix + testIdentity + ":1\n", want: []int64{1}},
		{name: "embedded-marker-is-ordinary", input: "application log " + journalMarkerPrefix + testIdentity + ":9\n" + journalMarkerPrefix + testIdentity + ":1\n", want: []int64{1}},
		{name: "long-ordinary-before-marker", input: strings.Repeat("x", 4*MaxFrameBytes) + "\n" + journalMarkerPrefix + testIdentity + ":1\n", want: []int64{1}},
		{name: "long-wrong-token-before-marker", input: journalMarkerPrefix + strings.Repeat("f", 64) + ":" + strings.Repeat("x", 4*MaxFrameBytes) + "\n" + journalMarkerPrefix + testIdentity + ":1\n", want: []int64{1}},
		{name: "long-ordinary-without-newline", input: strings.Repeat("x", 4*MaxFrameBytes)},
		{name: "sequence-gap", input: journalMarkerPrefix + testIdentity + ":2\n", wantCode: CodeProtocolJournal},
		{name: "truncated", input: journalMarkerPrefix + testIdentity + ":1", wantCode: CodeProtocolJournal},
		{name: "missing-sequence", input: journalMarkerPrefix + testIdentity + "\n", wantCode: CodeProtocolJournal},
		{name: "noncanonical-sequence", input: journalMarkerPrefix + testIdentity + ":01\n", wantCode: CodeProtocolJournal},
		{name: "oversized-trusted-marker", input: journalMarkerPrefix + testIdentity + ":" + strings.Repeat("1", MaxFrameBytes) + "\n", wantCode: CodeProtocolJournal},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			reader, writer, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			defer reader.Close()
			defer writer.Close()
			var output bytes.Buffer
			replyWriter := newReplyWriter(&output, nil)
			replyWriter.start()
			controller := newController(testExecutable(t))
			stream := newJournalStream(testIdentity, reader)
			go stream.run(controller, replyWriter)
			if _, err := io.WriteString(writer, testCase.input); err != nil && testCase.wantCode == "" {
				t.Fatal(err)
			}
			_ = writer.Close()
			select {
			case <-stream.done:
			case <-time.After(2 * time.Second):
				t.Fatal("journal reader did not finish")
			}
			if got := controller.terminalCode(); got != testCase.wantCode {
				t.Fatalf("terminal code = %s, want %s", got, testCase.wantCode)
			}
			// Enqueue a barrier to ensure accepted journal frames reached the
			// bounded writer before inspecting the output bytes.
			if err := replyWriter.sendAndWait(reply{ID: 1, Kind: "barrier"}); err != nil {
				t.Fatal(err)
			}
			replyWriter.stop()
			lines := bytes.Split(bytes.TrimSpace(output.Bytes()), []byte{'\n'})
			var got []int64
			for _, line := range lines {
				var frame journalReply
				if json.Unmarshal(line, &frame) == nil && frame.Kind == "journal" {
					got = append(got, frame.Sequence)
				}
			}
			if fmt.Sprint(got) != fmt.Sprint(testCase.want) {
				t.Fatalf("journal sequence = %v, want %v", got, testCase.want)
			}
		})
	}
}

func TestJournalLineUsesTheControllerFrameBound(t *testing.T) {
	input := []byte(journalMarkerPrefix + testIdentity + ":" + strings.Repeat("1", MaxFrameBytes) + "\n")
	_, _, err := readJournalLine(bufio.NewReader(bytes.NewReader(input)), testIdentity)
	if !errors.Is(err, errFrameTooLarge) {
		t.Fatalf("oversized journal line error = %v", err)
	}
}

func TestReplyWriterAfterStopRejectsLateJournal(t *testing.T) {
	writer := newReplyWriter(io.Discard, nil)
	writer.start()
	writer.stop()
	if err := writer.sendJournal(1); errorCode(err, "") != CodeProtocolOutput {
		t.Fatalf("late journal error = %v, want protocol_output", err)
	}
	if err := writer.sendAndWait(reply{ID: 1, Kind: "stopped"}); errorCode(err, "") != CodeProtocolOutput {
		t.Fatalf("closed writer must not acknowledge stop: %v", err)
	}
}

func TestReplyWriterConcurrentStopAndJournal(t *testing.T) {
	for attempt := 0; attempt < 64; attempt++ {
		writer := newReplyWriter(io.Discard, nil)
		writer.start()
		start := make(chan struct{})
		var pending sync.WaitGroup
		pending.Add(2)
		go func() { defer pending.Done(); <-start; writer.stop() }()
		go func() { defer pending.Done(); <-start; _ = writer.sendJournal(1) }()
		close(start)
		pending.Wait()
		if err := writer.sendJournal(2); errorCode(err, "") != CodeProtocolOutput {
			t.Fatalf("attempt %d accepted a marker after close: %v", attempt, err)
		}
	}
}

func TestJournalTimeoutCannotBecomeStopProofAfterLateEOF(t *testing.T) {
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	defer writer.Close()
	controller := newController(testExecutable(t))
	stream := newJournalStream(testIdentity, reader)
	controller.journal = stream
	// Model a reader stalled beyond both bounded joins, then a late completion.
	first := controller.waitJournal(stream)
	if errorCode(first, "") != CodeProtocolJournal {
		t.Fatalf("missing EOF was accepted: %v", first)
	}
	close(stream.done)
	if second := controller.waitJournal(stream); second != first {
		t.Fatalf("late EOF replaced failure: %v", second)
	}
	if stopped := controller.stopAndReap(CodeStopped); stopped != first {
		t.Fatalf("late EOF became stop proof: %v", stopped)
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
