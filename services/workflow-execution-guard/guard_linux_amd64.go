//go:build linux && amd64

package guard

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

const (
	maxSafeInteger      int64 = 9_007_199_254_740_991
	replyQueueCapacity        = 8
	replyWriteTimeout         = 250 * time.Millisecond
	clockRealtime             = 0
	tfdNonblock               = 0x800
	tfdCloexec                = 0x80000
	tfdTimerAbstime           = 1
	tfdTimerCancelOnSet       = 2
)

var (
	errClockChanged         = errors.New("realtime clock changed")
	errTimerClosed          = errors.New("realtime timer closed")
	errReapTimeout          = errors.New("child reap did not complete before timeout")
	errJournalReaderTimeout = errors.New("journal reader did not complete before timeout")
)

type request struct {
	ID               int64
	Op               string
	Identity         string
	DeadlineAt       int64
	Until            int64
	ConfigPath       string
	JournalToken     string
	ListenPath       string
	UpstreamPath     string
	UnavailableToken string
}

type reply struct {
	ID   int64  `json:"id"`
	Kind string `json:"kind"`
	Code Code   `json:"code,omitempty"`
}

type journalReply struct {
	Kind     string `json:"kind"`
	Sequence int64  `json:"sequence"`
}

type inputEvent struct {
	raw  []byte
	err  error
	code Code
}

type replyFrame struct {
	data []byte
	done chan error
}

type lifecycleFailure struct {
	code Code
}

type startResult struct {
	id  int64
	err error
}

func Run(options Options) error {
	if options.In == nil || options.Out == nil || options.WorkerdBinary == "" {
		return guardError(CodeInvalidInput, errors.New("input, output, and workerd binary are required"))
	}
	if err := validateExecutable(options.WorkerdBinary); err != nil {
		return guardError(CodeInvalidInput, err)
	}

	controller := newController(options.WorkerdBinary)
	writer := newReplyWriter(options.Out, controller.signalWriterFailure)
	controller.setJournalWriter(writer)
	writer.start()

	inputEvents := make(chan inputEvent, 1)
	stopInput := make(chan struct{})
	go readInput(options.In, inputEvents, stopInput)

	defer func() {
		close(stopInput)
		if closer, ok := options.In.(io.Closer); ok {
			_ = closer.Close()
		}
		_ = controller.stopAndReap(CodeStopped)
		writer.stop()
	}()

	for {
		select {
		case event, ok := <-inputEvents:
			if !ok {
				cleanupErr := controller.stopAndReap(CodeStopped)
				if terminal := controller.terminalCode(); terminal != "" && terminal != CodeStopped {
					return guardError(terminal, nil)
				}
				return cleanupErr
			}
			if event.err != nil {
				code := event.code
				if code == "" {
					code = CodeInvalidFrame
				}
				cleanupErr := controller.stopAndReap(code)
				if cleanupErr != nil {
					return cleanupErr
				}
				_ = writer.sendAndWait(reply{ID: 0, Kind: "error", Code: code})
				return guardError(code, event.err)
			}

			request, err := decodeRequest(event.raw)
			if err != nil {
				code := errorCode(err, CodeInvalidFrame)
				cleanupErr := controller.stopAndReap(code)
				if cleanupErr != nil {
					return cleanupErr
				}
				_ = writer.sendAndWait(reply{ID: request.ID, Kind: "error", Code: code})
				return err
			}
			if err := controller.acceptID(request.ID); err != nil {
				code := errorCode(err, CodeInvalidID)
				cleanupErr := controller.stopAndReap(code)
				if cleanupErr != nil {
					return cleanupErr
				}
				_ = writer.sendAndWait(reply{ID: request.ID, Kind: "error", Code: code})
				return err
			}

			switch request.Op {
			case "register":
				err = controller.register(request)
				if err == nil {
					err = writer.send(reply{ID: request.ID, Kind: "registered"})
				}
			case "start":
				err = controller.start(request)
				// A start is acknowledged only from startResults, after the
				// child has been created and the STOP/EOF race is resolved.
			case "gateway":
				err = controller.configureGateway(request)
				if err == nil {
					err = writer.send(reply{ID: request.ID, Kind: "configured"})
				}
			case "extend":
				err = controller.extend(request)
				if err == nil {
					err = writer.send(reply{ID: request.ID, Kind: "extended"})
				}
			case "stop":
				err = controller.stop(request)
				if err == nil {
					err = writer.sendAndWait(reply{ID: request.ID, Kind: "stopped"})
					if err == nil {
						return nil
					}
				}
			default:
				err = guardError(CodeInvalidFrame, errors.New("unsupported operation"))
			}
			if err != nil {
				code := errorCode(err, CodeInvalidFrame)
				cleanupErr := controller.stopAndReap(code)
				if cleanupErr != nil {
					return cleanupErr
				}
				if writerErr := writer.sendAndWait(reply{ID: request.ID, Kind: "error", Code: code}); writerErr != nil {
					return writerErr
				}
				return err
			}

		case failure := <-controller.failures:
			cleanupErr := controller.stopAndReap(failure.code)
			if writerErr := writer.sendAndWait(reply{ID: controller.lastIDValue(), Kind: "error", Code: failure.code}); writerErr != nil {
				if cleanupErr != nil {
					return cleanupErr
				}
				return writerErr
			}
			if cleanupErr != nil {
				return cleanupErr
			}
			return guardError(failure.code, nil)

		case started := <-controller.startResults:
			if started.err != nil {
				code := errorCode(started.err, CodeChildStartFailed)
				cleanupErr := controller.stopAndReap(code)
				if cleanupErr != nil {
					return cleanupErr
				}
				if writerErr := writer.sendAndWait(reply{ID: started.id, Kind: "error", Code: code}); writerErr != nil {
					return writerErr
				}
				return started.err
			}
			if terminal := controller.terminalCode(); terminal != "" {
				cleanupErr := controller.stopAndReap(terminal)
				if cleanupErr != nil {
					return cleanupErr
				}
				if writerErr := writer.sendAndWait(reply{ID: started.id, Kind: "error", Code: terminal}); writerErr != nil {
					return writerErr
				}
				return guardError(terminal, nil)
			}
			if err := writer.send(reply{ID: started.id, Kind: "started"}); err != nil {
				code := errorCode(err, CodeProtocolOutput)
				_ = controller.stopAndReap(code)
				return err
			}
		}
	}
}

func validateExecutable(path string) error {
	if !filepath.IsAbs(path) || strings.IndexByte(path, 0) >= 0 {
		return errors.New("workerd binary must be an absolute path")
	}
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
		return errors.New("workerd binary must be a regular executable")
	}
	return nil
}

func readInput(input io.Reader, events chan<- inputEvent, stop <-chan struct{}) {
	defer close(events)
	reader := bufio.NewReaderSize(input, 4096)
	for {
		frame, err := readFrame(reader)
		if err != nil {
			code := CodeInvalidFrame
			if errors.Is(err, errFrameTooLarge) {
				code = CodeFrameTooLarge
			}
			select {
			case events <- inputEvent{err: err, code: code}:
			case <-stop:
			}
			return
		}
		if frame == nil {
			return
		}
		select {
		case events <- inputEvent{raw: frame}:
		case <-stop:
			return
		}
	}
}

var errFrameTooLarge = errors.New("input frame exceeds limit")

func readFrame(reader *bufio.Reader) ([]byte, error) {
	frame := make([]byte, 0, 4096)
	for {
		part, err := reader.ReadSlice('\n')
		frame = append(frame, part...)
		if len(frame) > MaxFrameBytes+1 {
			return nil, errFrameTooLarge
		}
		if err == nil {
			frame = frame[:len(frame)-1]
			if len(frame) > MaxFrameBytes {
				return nil, errFrameTooLarge
			}
			return append([]byte(nil), frame...), nil
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if errors.Is(err, io.EOF) {
			if len(frame) == 0 {
				return nil, nil
			}
			if len(frame) > MaxFrameBytes {
				return nil, errFrameTooLarge
			}
			return append([]byte(nil), frame...), nil
		}
		return nil, err
	}
}

func decodeRequest(raw []byte) (request, error) {
	var result request
	if len(raw) == 0 || len(raw) > MaxFrameBytes {
		return result, guardError(CodeInvalidFrame, errors.New("empty or oversized frame"))
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	var fields map[string]json.RawMessage
	if err := decoder.Decode(&fields); err != nil || fields == nil {
		return result, guardError(CodeInvalidFrame, errors.New("frame must be one JSON object"))
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return result, guardError(CodeInvalidFrame, errors.New("frame has trailing data"))
	}
	for key := range fields {
		if !isFrameField(key) {
			return result, guardError(CodeInvalidFrame, errors.New("unknown frame field"))
		}
	}

	idRaw, ok := fields["id"]
	if !ok {
		return result, guardError(CodeInvalidID, errors.New("id is required"))
	}
	id, err := parseSafeInteger(idRaw)
	if err != nil || id <= 0 {
		return result, guardError(CodeInvalidID, errors.New("id must be a positive safe integer"))
	}
	result.ID = id

	op, err := parseString(fields["op"])
	if err != nil {
		return result, guardError(CodeInvalidFrame, errors.New("op is required"))
	}
	result.Op = op
	if err := requireFrameFields(fields, op); err != nil {
		return result, err
	}
	identity, err := parseString(fields["identity"])
	if err != nil || !validIdentity(identity) {
		return result, guardError(CodeInvalidIdentity, errors.New("identity must be 64 lowercase hexadecimal characters"))
	}
	result.Identity = identity

	switch op {
	case "register":
		result.DeadlineAt, err = parseSafeInteger(fields["deadlineAt"])
		if err != nil || result.DeadlineAt <= 0 {
			return result, guardError(CodeInvalidDeadline, errors.New("deadlineAt must be a positive safe integer"))
		}
		result.Until, err = parseSafeInteger(fields["until"])
		if err != nil || result.Until <= 0 {
			return result, guardError(CodeInvalidLease, errors.New("until must be a positive safe integer"))
		}
		if journalTokenRaw, ok := fields["journalToken"]; ok {
			result.JournalToken, err = parseString(journalTokenRaw)
			if err != nil || !validIdentity(result.JournalToken) {
				return result, guardError(CodeInvalidFrame, errors.New("journalToken must be 64 lowercase hexadecimal characters"))
			}
		}
	case "extend":
		result.Until, err = parseSafeInteger(fields["until"])
		if err != nil || result.Until <= 0 {
			return result, guardError(CodeInvalidLease, errors.New("until must be a positive safe integer"))
		}
	case "start":
		result.ConfigPath, err = parseString(fields["configPath"])
		if err != nil || !filepath.IsAbs(result.ConfigPath) || strings.IndexByte(result.ConfigPath, 0) >= 0 {
			return result, guardError(CodeInvalidConfigPath, errors.New("configPath must be an absolute path"))
		}
	case "gateway":
		result.ListenPath, err = parseString(fields["listenPath"])
		if err != nil || !validUnixSocketPath(result.ListenPath) {
			return result, guardError(CodeInvalidGateway, errors.New("listenPath must be a canonical bounded absolute path"))
		}
		result.UpstreamPath, err = parseString(fields["upstreamPath"])
		if err != nil || !validUnixSocketPath(result.UpstreamPath) || !validUpstreamSocketName(result.UpstreamPath) {
			return result, guardError(CodeInvalidGateway, errors.New("upstreamPath must name a bounded private router socket"))
		}
		result.UnavailableToken, err = parseString(fields["unavailableToken"])
		if err != nil || !validIdentity(result.UnavailableToken) {
			return result, guardError(CodeInvalidGateway, errors.New("unavailableToken must be 64 lowercase hexadecimal characters"))
		}
	case "stop":
	default:
		return result, guardError(CodeInvalidFrame, errors.New("unsupported operation"))
	}
	return result, nil
}

func isFrameField(field string) bool {
	switch field {
	case "id", "op", "identity", "deadlineAt", "until", "configPath", "journalToken", "listenPath", "upstreamPath", "unavailableToken":
		return true
	default:
		return false
	}
}

func requireFrameFields(fields map[string]json.RawMessage, op string) error {
	want := map[string]bool{"id": true, "op": true, "identity": true}
	switch op {
	case "register":
		want["deadlineAt"], want["until"] = true, true
	case "extend":
		want["until"] = true
	case "start":
		want["configPath"] = true
	case "gateway":
		want["listenPath"], want["upstreamPath"], want["unavailableToken"] = true, true, true
	case "stop":
	default:
		return guardError(CodeInvalidFrame, errors.New("unsupported operation"))
	}
	expectedFields := len(want)
	if op == "register" {
		if _, ok := fields["journalToken"]; ok {
			expectedFields++
		}
	}
	if len(fields) != expectedFields {
		return guardError(CodeInvalidFrame, errors.New("wrong frame fields"))
	}
	for key := range want {
		if _, ok := fields[key]; !ok {
			return guardError(CodeInvalidFrame, errors.New("missing frame field"))
		}
	}
	return nil
}

func parseString(raw json.RawMessage) (string, error) {
	var value string
	if len(raw) == 0 || json.Unmarshal(raw, &value) != nil {
		return "", errors.New("string required")
	}
	return value, nil
}

func parseSafeInteger(raw json.RawMessage) (int64, error) {
	value := strings.TrimSpace(string(raw))
	if value == "" {
		return 0, errors.New("number required")
	}
	for index, character := range value {
		if index == 0 && character == '-' {
			if len(value) == 1 {
				return 0, errors.New("invalid number")
			}
			continue
		}
		if character < '0' || character > '9' {
			return 0, errors.New("integer required")
		}
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed < 0 || parsed > maxSafeInteger {
		return 0, errors.New("safe integer required")
	}
	return parsed, nil
}

func validIdentity(identity string) bool {
	if len(identity) != 64 {
		return false
	}
	for _, character := range identity {
		if !((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f')) {
			return false
		}
	}
	return true
}

func validUnixSocketPath(path string) bool {
	return filepath.IsAbs(path) &&
		filepath.Clean(path) == path &&
		strings.IndexByte(path, 0) < 0 &&
		len(path) <= MaxUnixSocketPathBytes
}

func validUpstreamSocketName(path string) bool {
	name := filepath.Base(path)
	const suffix = ".sock"
	return strings.HasSuffix(name, suffix) && validIdentity(strings.TrimSuffix(name, suffix))
}

func errorCode(err error, fallback Code) Code {
	var typed *Error
	if errors.As(err, &typed) && typed.Code != "" {
		return typed.Code
	}
	return fallback
}

type replyWriter struct {
	out       io.Writer
	queue     chan replyFrame
	done      chan struct{}
	closeOnce sync.Once
	failOnce  sync.Once
	mu        sync.Mutex
	err       error
	closed    bool
	onFailure func(Code, error)
}

func newReplyWriter(out io.Writer, onFailure func(Code, error)) *replyWriter {
	return &replyWriter{
		out:       out,
		queue:     make(chan replyFrame, replyQueueCapacity),
		done:      make(chan struct{}),
		onFailure: onFailure,
	}
}

func (writer *replyWriter) start() {
	go writer.loop()
}

func (writer *replyWriter) loop() {
	defer close(writer.done)
	for frame := range writer.queue {
		timedOut := make(chan struct{})
		timer := time.AfterFunc(replyWriteTimeout, func() {
			close(timedOut)
			writer.fail(CodeProtocolBackpressure, errors.New("reply writer blocked"))
		})
		written, err := writer.out.Write(frame.data)
		if !timer.Stop() {
			select {
			case <-timedOut:
			default:
			}
		}
		if err != nil {
			writer.fail(CodeProtocolOutput, err)
			if frame.done != nil {
				frame.done <- err
			}
			return
		}
		if written != len(frame.data) {
			writer.fail(CodeProtocolOutput, io.ErrShortWrite)
			if frame.done != nil {
				frame.done <- io.ErrShortWrite
			}
			return
		}
		if frame.done != nil {
			frame.done <- nil
		}
	}
}

func (writer *replyWriter) send(value reply) error {
	return writer.enqueue(value, nil)
}

func (writer *replyWriter) sendJournal(sequence int64) error {
	return writer.enqueueValue(journalReply{Kind: "journal", Sequence: sequence}, nil)
}

func (writer *replyWriter) sendAndWait(value reply) error {
	done := make(chan error, 1)
	if err := writer.enqueue(value, done); err != nil {
		return err
	}
	select {
	case err := <-done:
		if err != nil {
			return guardError(CodeProtocolOutput, err)
		}
		return nil
	case <-time.After(replyWriteTimeout):
		failure := errors.New("reply was not written before timeout")
		writer.fail(CodeProtocolBackpressure, failure)
		return guardError(CodeProtocolBackpressure, failure)
	}
}

func (writer *replyWriter) enqueue(value reply, done chan error) error {
	return writer.enqueueValue(value, done)
}

func (writer *replyWriter) enqueueValue(value any, done chan error) error {
	frame, err := json.Marshal(value)
	if err != nil {
		return guardError(CodeProtocolOutput, err)
	}
	if len(frame) > MaxFrameBytes {
		writer.fail(CodeProtocolOutput, errors.New("reply exceeds frame limit"))
		return guardError(CodeProtocolOutput, errors.New("reply exceeds frame limit"))
	}
	frame = append(frame, '\n')
	writer.mu.Lock()
	if writer.err != nil {
		err = writer.err
		writer.mu.Unlock()
		return err
	}
	if writer.closed {
		writer.mu.Unlock()
		return guardError(CodeProtocolOutput, errors.New("reply writer closed"))
	}
	// Nonblocking enqueue and channel close share this lock. A journal reader
	// may outlive a failed EOF barrier, but can never send on a closed queue.
	select {
	case writer.queue <- replyFrame{data: frame, done: done}:
		writer.mu.Unlock()
		return nil
	default:
		writer.mu.Unlock()
		failure := errors.New("reply queue full")
		writer.fail(CodeProtocolBackpressure, failure)
		return guardError(CodeProtocolBackpressure, failure)
	}
}

func (writer *replyWriter) fail(code Code, cause error) {
	writer.failOnce.Do(func() {
		writer.mu.Lock()
		writer.err = guardError(code, cause)
		writer.mu.Unlock()
		if writer.onFailure != nil {
			writer.onFailure(code, cause)
		}
	})
}

func (writer *replyWriter) stop() {
	writer.closeOnce.Do(func() {
		writer.mu.Lock()
		writer.closed = true
		close(writer.queue)
		writer.mu.Unlock()
	})
	select {
	case <-writer.done:
	case <-time.After(replyWriteTimeout):
	}
}

type spawnAttempt struct {
	result  chan error
	done    chan struct{}
	mu      sync.Mutex
	killErr error
	waitErr error
}

func newSpawnAttempt() *spawnAttempt {
	return &spawnAttempt{result: make(chan error, 1), done: make(chan struct{})}
}

func (attempt *spawnAttempt) setKillError(err error) {
	attempt.mu.Lock()
	attempt.killErr = err
	attempt.mu.Unlock()
}

func (attempt *spawnAttempt) killErrorValue() error {
	attempt.mu.Lock()
	defer attempt.mu.Unlock()
	return attempt.killErr
}

func (attempt *spawnAttempt) setWaitError(err error) {
	attempt.mu.Lock()
	attempt.waitErr = err
	attempt.mu.Unlock()
}

func (attempt *spawnAttempt) waitErrorValue() error {
	attempt.mu.Lock()
	defer attempt.mu.Unlock()
	return attempt.waitErr
}

type journalStream struct {
	token     string
	stderr    *os.File
	done      chan struct{}
	closeOnce sync.Once
	waitOnce  sync.Once
	waitErr   error
	errMu     sync.Mutex
	err       error
}

func newJournalStream(token string, stderr *os.File) *journalStream {
	return &journalStream{token: token, stderr: stderr, done: make(chan struct{})}
}

func (stream *journalStream) setError(err error) {
	if err == nil {
		return
	}
	stream.errMu.Lock()
	if stream.err == nil {
		stream.err = err
	}
	stream.errMu.Unlock()
}

func (stream *journalStream) errorValue() error {
	stream.errMu.Lock()
	defer stream.errMu.Unlock()
	return stream.err
}

func (stream *journalStream) close() {
	stream.closeOnce.Do(func() {
		if stream.stderr != nil {
			_ = stream.stderr.Close()
		}
	})
}

func (stream *journalStream) run(controller *controller, writer *replyWriter) {
	defer stream.close()
	defer close(stream.done)
	reader := bufio.NewReaderSize(stream.stderr, 4096)
	expected := int64(1)
	for {
		line, terminated, err := readJournalLine(reader, stream.token)
		if err != nil {
			stream.fail(controller, guardError(CodeProtocolJournal, err))
			return
		}
		if line == nil {
			return
		}
		sequence, matched, markerErr := parseJournalMarker(line, stream.token)
		if !matched {
			// Child diagnostics are intentionally discarded. Only an exact
			// token-qualified marker belongs to this private stream.
			continue
		}
		if !terminated {
			markerErr = errors.New("journal marker was truncated before newline")
		}
		if markerErr != nil {
			stream.fail(controller, guardError(CodeProtocolJournal, markerErr))
			return
		}
		if sequence != expected {
			stream.fail(controller, guardError(CodeProtocolJournal, errors.New("journal sequence is not consecutive")))
			return
		}
		if writer == nil {
			stream.fail(controller, guardError(CodeProtocolJournal, errors.New("journal writer unavailable")))
			return
		}
		if err := writer.sendJournal(sequence); err != nil {
			stream.fail(controller, err)
			return
		}
		expected++
	}
}

func (stream *journalStream) fail(controller *controller, err error) {
	stream.setError(err)
	controller.signal(errorCode(err, CodeProtocolJournal))
}

func readJournalLine(reader *bufio.Reader, token string) ([]byte, bool, error) {
	trustedPrefix := []byte(journalMarkerPrefix + token)
	line := make([]byte, 0, len(trustedPrefix)+32)
	discarding := false
	for {
		part, err := reader.ReadSlice('\n')
		if err == nil {
			part = part[:len(part)-1]
		}
		if !discarding {
			for _, value := range part {
				index := len(line)
				if (index < len(trustedPrefix) && value != trustedPrefix[index]) ||
					(index == len(trustedPrefix) && value != ':') {
					// Arbitrarily long ordinary diagnostics use constant memory.
					// Never reinterpret an embedded marker later in that line.
					discarding = true
					line = line[:0]
					break
				}
				if index >= MaxFrameBytes {
					return nil, false, errFrameTooLarge
				}
				line = append(line, value)
			}
		}
		if err == nil {
			if discarding || len(line) < len(trustedPrefix) {
				discarding = false
				line = line[:0]
				continue
			}
			return line, true, nil
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if errors.Is(err, io.EOF) {
			if discarding || len(line) < len(trustedPrefix) {
				return nil, false, nil
			}
			return line, false, nil
		}
		return nil, false, err
	}
}

const journalMarkerPrefix = "TAKOSERVER_WORKFLOW_JOURNAL:"

func parseJournalMarker(line []byte, token string) (int64, bool, error) {
	prefix := []byte(journalMarkerPrefix)
	if !bytes.HasPrefix(line, prefix) {
		return 0, false, nil
	}
	rest := line[len(prefix):]
	tokenEnd := bytes.IndexByte(rest, ':')
	if tokenEnd < 0 {
		if string(rest) == token {
			return 0, true, errors.New("journal marker sequence was truncated")
		}
		return 0, false, nil
	}
	if string(rest[:tokenEnd]) != token {
		return 0, false, nil
	}
	sequenceText := rest[tokenEnd+1:]
	sequence, err := parseSafeInteger(json.RawMessage(sequenceText))
	if err != nil || sequence <= 0 || strconv.FormatInt(sequence, 10) != string(sequenceText) {
		return 0, true, errors.New("journal marker sequence must be a positive safe integer")
	}
	return sequence, true, nil
}

type controller struct {
	mu sync.Mutex

	binary string

	registered    bool
	terminal      bool
	terminalError Code
	identity      string
	journalToken  string
	journalWriter *replyWriter
	journal       *journalStream
	lastID        int64
	deadlineAt    int64
	until         int64
	deadlineMono  time.Time
	leaseMono     time.Time

	timer         *realtimeTimer
	deadlineTimer *time.Timer
	leaseTimer    *time.Timer
	startIssued   bool
	child         *os.Process
	spawn         *spawnAttempt
	gateways      []serviceGatewayDescriptor
	gatewayGroup  *serviceGatewayGroup
	failures      chan lifecycleFailure
	startResults  chan startResult
}

func newController(binary string) *controller {
	return &controller{
		binary:       binary,
		failures:     make(chan lifecycleFailure, 1),
		startResults: make(chan startResult, 1),
	}
}

func (controller *controller) setJournalWriter(writer *replyWriter) {
	controller.mu.Lock()
	controller.journalWriter = writer
	controller.mu.Unlock()
}

func (controller *controller) signalWriterFailure(code Code, cause error) {
	controller.signal(code)
}

func (controller *controller) signal(code Code) {
	controller.mu.Lock()
	if controller.terminal {
		controller.mu.Unlock()
		return
	}
	controller.terminal = true
	controller.terminalError = code
	controller.mu.Unlock()
	select {
	case controller.failures <- lifecycleFailure{code: code}:
	default:
	}
}

func (controller *controller) markTerminal(code Code) {
	controller.mu.Lock()
	if !controller.terminal {
		controller.terminal = true
		controller.terminalError = code
	}
	controller.mu.Unlock()
}

func (controller *controller) terminalCode() Code {
	controller.mu.Lock()
	defer controller.mu.Unlock()
	return controller.terminalError
}

func (controller *controller) lastIDValue() int64 {
	controller.mu.Lock()
	defer controller.mu.Unlock()
	return controller.lastID
}

func (controller *controller) acceptID(id int64) error {
	controller.mu.Lock()
	defer controller.mu.Unlock()
	if id <= 0 || id > maxSafeInteger || (controller.lastID != 0 && id <= controller.lastID) {
		return guardError(CodeInvalidID, errors.New("id must increase strictly"))
	}
	if !controller.registered && id != 1 {
		return guardError(CodeInvalidID, errors.New("register must use id 1"))
	}
	controller.lastID = id
	return nil
}

func (controller *controller) register(request request) error {
	now := time.Now()
	nowMS := now.UnixMilli()
	if request.DeadlineAt <= nowMS || request.DeadlineAt-nowMS > MaxLifetimeMilliseconds {
		return guardError(CodeInvalidDeadline, errors.New("deadline is outside lifetime ceiling"))
	}
	if request.Until <= nowMS || request.Until > request.DeadlineAt {
		return guardError(CodeInvalidLease, errors.New("lease is outside deadline"))
	}
	timer, err := newRealtimeTimer()
	if err != nil {
		return guardError(CodeClockChanged, err)
	}
	if err := timer.arm(request.Until); err != nil {
		_ = timer.close()
		return guardError(timerErrorCode(err), err)
	}
	deadlineTimer := time.AfterFunc(time.Until(now.Add(time.Duration(request.DeadlineAt-nowMS)*time.Millisecond)), func() {
		controller.signal(CodeDeadlineExpired)
	})

	controller.mu.Lock()
	if controller.terminal {
		controller.mu.Unlock()
		deadlineTimer.Stop()
		_ = timer.close()
		return guardError(controller.terminalError, nil)
	}
	if controller.registered {
		controller.mu.Unlock()
		deadlineTimer.Stop()
		_ = timer.close()
		return guardError(CodeAlreadyRegistered, errors.New("register already accepted"))
	}
	controller.registered = true
	controller.identity = request.Identity
	controller.journalToken = request.JournalToken
	controller.deadlineAt = request.DeadlineAt
	controller.until = request.Until
	controller.deadlineMono = now.Add(time.Duration(request.DeadlineAt-nowMS) * time.Millisecond)
	controller.leaseMono = now.Add(time.Duration(request.Until-nowMS) * time.Millisecond)
	controller.timer = timer
	controller.deadlineTimer = deadlineTimer
	controller.leaseTimer = time.AfterFunc(time.Until(controller.leaseMono), controller.leaseExpired)
	controller.mu.Unlock()
	go controller.watchTimer(timer)
	return nil
}

func (controller *controller) start(request request) error {
	if !filepath.IsAbs(request.ConfigPath) {
		return guardError(CodeInvalidConfigPath, errors.New("config path must be absolute"))
	}
	controller.mu.Lock()
	if !controller.registered {
		controller.mu.Unlock()
		return guardError(CodeNotRegistered, errors.New("register is required"))
	}
	if request.Identity != controller.identity {
		controller.mu.Unlock()
		return guardError(CodeInvalidIdentity, errors.New("identity does not match registration"))
	}
	if controller.terminal {
		code := controller.terminalError
		controller.mu.Unlock()
		return guardError(code, nil)
	}
	if controller.startIssued {
		controller.mu.Unlock()
		return guardError(CodeAlreadyStarted, errors.New("start already requested"))
	}
	if expired := controller.expiredLocked(time.Now()); expired != "" {
		controller.terminal = true
		controller.terminalError = expired
		controller.mu.Unlock()
		return guardError(expired, nil)
	}
	descriptors := append([]serviceGatewayDescriptor(nil), controller.gateways...)
	var gatewayGroup *serviceGatewayGroup
	if len(descriptors) > 0 {
		validated, err := validateServiceGatewaySet(request.ConfigPath, descriptors)
		if err != nil {
			controller.mu.Unlock()
			return err
		}
		gatewayGroup = newServiceGatewayGroup(validated, func() {
			controller.signal(CodeServiceGateway)
		})
	}
	attempt := newSpawnAttempt()
	controller.startIssued = true
	controller.spawn = attempt
	controller.gatewayGroup = gatewayGroup
	controller.mu.Unlock()
	go controller.spawnChild(request.ConfigPath, attempt, gatewayGroup)

	go func() {
		controller.startResults <- startResult{id: request.ID, err: <-attempt.result}
	}()
	return nil
}

func (controller *controller) configureGateway(request request) error {
	descriptor := serviceGatewayDescriptor{
		listenPath:       request.ListenPath,
		upstreamPath:     request.UpstreamPath,
		unavailableToken: request.UnavailableToken,
	}
	controller.mu.Lock()
	defer controller.mu.Unlock()
	if !controller.registered {
		return guardError(CodeNotRegistered, errors.New("register is required"))
	}
	if request.Identity != controller.identity {
		return guardError(CodeInvalidIdentity, errors.New("identity does not match registration"))
	}
	if controller.terminal {
		return guardError(controller.terminalError, nil)
	}
	if controller.startIssued {
		return guardError(CodeAlreadyStarted, errors.New("gateway cannot be configured after start"))
	}
	if len(controller.gateways) >= MaxServiceGateways {
		return guardError(CodeInvalidGateway, errors.New("too many service gateways"))
	}
	for _, existing := range controller.gateways {
		if existing.listenPath == descriptor.listenPath {
			return guardError(CodeInvalidGateway, errors.New("duplicate service gateway listener"))
		}
	}
	controller.gateways = append(controller.gateways, descriptor)
	return nil
}

func (controller *controller) extend(request request) error {
	controller.mu.Lock()
	if !controller.registered {
		controller.mu.Unlock()
		return guardError(CodeNotRegistered, errors.New("register is required"))
	}
	if request.Identity != controller.identity {
		controller.mu.Unlock()
		return guardError(CodeInvalidIdentity, errors.New("identity does not match registration"))
	}
	if controller.terminal {
		code := controller.terminalError
		controller.mu.Unlock()
		return guardError(code, nil)
	}
	if request.Until < controller.until || request.Until > controller.deadlineAt {
		controller.mu.Unlock()
		return guardError(CodeInvalidLease, errors.New("lease must be nondecreasing and within deadline"))
	}
	now := time.Now()
	if expired := controller.expiredLocked(now); expired != "" || now.UnixMilli() >= controller.until {
		if expired == "" {
			expired = CodeLeaseExpired
		}
		controller.terminal = true
		controller.terminalError = expired
		controller.mu.Unlock()
		return guardError(expired, nil)
	}
	timer := controller.timer
	oldUntil := controller.until
	if timer == nil {
		controller.terminal = true
		controller.terminalError = CodeClockChanged
		controller.mu.Unlock()
		return guardError(CodeClockChanged, errors.New("lease timer unavailable"))
	}
	if err := timer.arm(request.Until); err != nil {
		code := timerErrorCode(err)
		controller.terminal = true
		controller.terminalError = code
		controller.mu.Unlock()
		return guardError(code, err)
	}
	// Keep the timerfd rearm and journaled lease update under one lifecycle
	// lock. A renewal that crossed the old lease while the syscall ran fails
	// closed instead of replacing an already-expired deadline.
	now = time.Now()
	if expired := controller.expiredLocked(now); expired != "" || now.UnixMilli() >= oldUntil || now.UnixMilli() >= request.Until {
		if expired == "" {
			expired = CodeLeaseExpired
		}
		controller.terminal = true
		controller.terminalError = expired
		controller.mu.Unlock()
		return guardError(expired, nil)
	}
	nowMS := now.UnixMilli()
	leaseMono := now.Add(time.Duration(request.Until-nowMS) * time.Millisecond)
	controller.until = request.Until
	controller.leaseMono = leaseMono
	if controller.leaseTimer != nil {
		controller.leaseTimer.Reset(time.Until(leaseMono))
	}
	controller.mu.Unlock()
	return nil
}

func (controller *controller) stop(request request) error {
	controller.mu.Lock()
	if !controller.registered {
		controller.mu.Unlock()
		return guardError(CodeNotRegistered, errors.New("register is required"))
	}
	if request.Identity != controller.identity {
		controller.mu.Unlock()
		return guardError(CodeInvalidIdentity, errors.New("identity does not match registration"))
	}
	if controller.terminal && controller.terminalError != CodeStopped {
		code := controller.terminalError
		controller.mu.Unlock()
		return guardError(code, nil)
	}
	controller.terminal = true
	controller.terminalError = CodeStopped
	controller.mu.Unlock()
	return controller.stopAndReap(CodeStopped)
}

func (controller *controller) expiredLocked(now time.Time) Code {
	if !now.Before(controller.deadlineMono) {
		return CodeDeadlineExpired
	}
	if !now.Before(controller.leaseMono) {
		return CodeLeaseExpired
	}
	return ""
}

func (controller *controller) leaseExpired() {
	controller.mu.Lock()
	if controller.terminal {
		controller.mu.Unlock()
		return
	}
	now := time.Now()
	if expired := controller.expiredLocked(now); expired != "" {
		controller.terminal = true
		controller.terminalError = expired
		controller.mu.Unlock()
		select {
		case controller.failures <- lifecycleFailure{code: expired}:
		default:
		}
		return
	}
	if controller.leaseTimer != nil {
		controller.leaseTimer.Reset(time.Until(controller.leaseMono))
	}
	controller.mu.Unlock()
}

func (controller *controller) watchTimer(timer *realtimeTimer) {
	for {
		err := timer.wait()
		if err != nil {
			controller.mu.Lock()
			terminal := controller.terminal
			controller.mu.Unlock()
			if terminal {
				return
			}
			if errors.Is(err, errClockChanged) || errors.Is(err, syscall.ECANCELED) {
				controller.signal(CodeClockChanged)
			} else {
				controller.signal(CodeClockChanged)
			}
			return
		}
		controller.mu.Lock()
		terminal := controller.terminal
		now := time.Now()
		expiredCode := controller.expiredLocked(now)
		until := controller.until
		controller.mu.Unlock()
		if terminal {
			return
		}
		if expiredCode != "" {
			controller.signal(expiredCode)
			return
		}
		if now.UnixMilli() >= until {
			controller.signal(CodeLeaseExpired)
			return
		}
		if err := timer.arm(until); err != nil {
			controller.signal(timerErrorCode(err))
			return
		}
	}
}

func (controller *controller) spawnChild(
	configPath string,
	attempt *spawnAttempt,
	gateways *serviceGatewayGroup,
) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	childOwnsGateways := false
	defer func() {
		if gateways != nil && !childOwnsGateways {
			_ = gateways.stopAndWait()
		}
	}()
	if gateways != nil {
		if err := gateways.start(); err != nil {
			wrapped := guardError(errorCode(err, CodeServiceGateway), err)
			attempt.result <- wrapped
			controller.markTerminal(errorCode(wrapped, CodeServiceGateway))
			close(attempt.done)
			return
		}
	}
	if terminal := controller.terminalCode(); terminal != "" {
		attempt.result <- guardError(terminal, nil)
		close(attempt.done)
		return
	}

	command := exec.Command(controller.binary, "serve", configPath)
	command.Env = []string{}
	command.ExtraFiles = nil
	command.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
	controller.mu.Lock()
	journalToken := controller.journalToken
	journalWriter := controller.journalWriter
	controller.mu.Unlock()
	stdin, err := os.OpenFile(os.DevNull, os.O_RDONLY, 0)
	if err != nil {
		attempt.result <- guardError(CodeChildStartFailed, err)
		controller.markTerminal(CodeChildStartFailed)
		close(attempt.done)
		return
	}
	defer stdin.Close()
	stdout, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err != nil {
		attempt.result <- guardError(CodeChildStartFailed, err)
		controller.markTerminal(CodeChildStartFailed)
		close(attempt.done)
		return
	}
	defer stdout.Close()
	var stderrReader, stderrWriter *os.File
	if journalToken != "" {
		stderrReader, stderrWriter, err = os.Pipe()
	} else {
		stderrWriter, err = os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	}
	if err != nil {
		attempt.result <- guardError(CodeChildStartFailed, err)
		controller.markTerminal(CodeChildStartFailed)
		close(attempt.done)
		return
	}
	if journalToken == "" {
		defer stderrWriter.Close()
	}
	command.Stdin, command.Stdout, command.Stderr = stdin, stdout, stderrWriter

	if err := command.Start(); err != nil {
		if journalToken != "" {
			_ = stderrReader.Close()
			_ = stderrWriter.Close()
		}
		wrapped := guardError(CodeChildStartFailed, err)
		attempt.result <- wrapped
		controller.markTerminal(CodeChildStartFailed)
		close(attempt.done)
		return
	}

	if journalToken == "" {
		controller.mu.Lock()
		stopped := controller.terminal
		if !stopped {
			controller.child = command.Process
		}
		controller.mu.Unlock()
		if stopped {
			killErr := killAndWait(command.Process)
			attempt.setKillError(killErr)
			if killErr != nil {
				attempt.result <- guardError(CodeStopFailed, killErr)
			} else {
				attempt.result <- guardError(CodeStopped, nil)
			}
			close(attempt.done)
			return
		}
		childOwnsGateways = true
		attempt.result <- nil
		waitErr := command.Wait()
		controller.mu.Lock()
		if controller.child == command.Process {
			controller.child = nil
		}
		wasTerminal := controller.terminal
		controller.mu.Unlock()
		attempt.setWaitError(waitErr)
		close(attempt.done)
		if !wasTerminal {
			controller.signal(CodeChildExited)
		}
		return
	}

	// Close the parent's copy so the reader observes EOF after the child (and
	// any direct descendants retaining the descriptor) releases its stderr.
	_ = stderrWriter.Close()
	stream := newJournalStream(journalToken, stderrReader)
	controller.mu.Lock()
	stopped := controller.terminal
	controller.journal = stream
	if !stopped {
		controller.child = command.Process
	}
	controller.mu.Unlock()
	go stream.run(controller, journalWriter)
	if stopped {
		killErr := killAndWait(command.Process)
		attempt.setKillError(killErr)
		if killErr != nil {
			attempt.result <- guardError(CodeStopFailed, killErr)
		} else {
			attempt.result <- guardError(CodeStopped, nil)
		}
		close(attempt.done)
		return
	}
	childOwnsGateways = true
	attempt.result <- nil
	waitErr := command.Wait()
	controller.mu.Lock()
	if controller.child == command.Process {
		controller.child = nil
	}
	wasTerminal := controller.terminal
	controller.mu.Unlock()
	attempt.setWaitError(waitErr)
	close(attempt.done)
	if !wasTerminal {
		if journalErr := controller.waitJournal(stream); journalErr != nil {
			controller.signal(errorCode(journalErr, CodeProtocolJournal))
		} else {
			controller.signal(CodeChildExited)
		}
	}
}

func killAndWait(process *os.Process) error {
	if process == nil {
		return nil
	}
	err := process.Kill()
	if err != nil && !errors.Is(err, os.ErrProcessDone) {
		return err
	}
	_, waitErr := process.Wait()
	if waitErrorRequiresStopFailure(waitErr) {
		return waitErr
	}
	return nil
}

func (controller *controller) journalStreamValue() *journalStream {
	controller.mu.Lock()
	defer controller.mu.Unlock()
	return controller.journal
}

func (controller *controller) waitJournal(stream *journalStream) error {
	stream.waitOnce.Do(func() {
		select {
		case <-stream.done:
			stream.waitErr = stream.errorValue()
		case <-time.After(replyWriteTimeout):
			// A child or direct descendant retaining stderr can keep the pipe
			// open forever. Closing our read side bounds STOP latency; the
			// missing EOF remains a private protocol failure and can never
			// produce STOPACK.
			stream.close()
			stream.waitErr = guardError(CodeProtocolJournal, errJournalReaderTimeout)
			// Closing the descriptor normally releases the reader immediately.
			// Bound cleanup as well, retaining the original failed EOF proof.
			select {
			case <-stream.done:
			case <-time.After(replyWriteTimeout):
			}
		}
	})
	return stream.waitErr
}

func (controller *controller) stopAndReap(defaultCode Code) error {
	controller.mu.Lock()
	if !controller.terminal {
		controller.terminal = true
		controller.terminalError = defaultCode
	}
	process := controller.child
	attempt := controller.spawn
	gateways := controller.gatewayGroup
	controller.child = nil
	timer := controller.timer
	deadlineTimer := controller.deadlineTimer
	leaseTimer := controller.leaseTimer
	controller.mu.Unlock()

	var killErr error
	if process != nil {
		killErr = process.Kill()
		if errors.Is(killErr, os.ErrProcessDone) {
			killErr = nil
		}
	}
	if gateways != nil {
		gateways.stop()
	}
	if attempt != nil {
		// STOP can win while a gateway listener is bound but not yet registered
		// with the group. The spawn barrier proves that listener was closed and
		// inode-safely unlinked before a stopped ACK is possible.
		select {
		case <-attempt.done:
		case <-time.After(replyWriteTimeout):
			if killErr == nil {
				killErr = errReapTimeout
			}
		}
		select {
		case <-attempt.done:
			if attemptErr := attempt.killErrorValue(); killErr == nil && attemptErr != nil {
				killErr = attemptErr
			}
			if killErr == nil {
				if waitErr := attempt.waitErrorValue(); waitErrorRequiresStopFailure(waitErr) {
					killErr = waitErr
				}
			}
		default:
		}
	}
	var gatewayErr error
	if gateways != nil {
		gatewayErr = gateways.wait()
	}
	var journalErr error
	if stream := controller.journalStreamValue(); stream != nil {
		journalErr = controller.waitJournal(stream)
	}
	if timer != nil {
		if err := timer.close(); killErr == nil && err != nil && !errors.Is(err, os.ErrClosed) {
			killErr = err
		}
	}
	if deadlineTimer != nil {
		deadlineTimer.Stop()
	}
	if leaseTimer != nil {
		leaseTimer.Stop()
	}
	if killErr != nil {
		return guardError(CodeStopFailed, killErr)
	}
	if gatewayErr != nil {
		return guardError(CodeStopFailed, gatewayErr)
	}
	if journalErr != nil {
		return journalErr
	}
	return nil
}

// exec.ExitError with a ProcessState proves that Wait reaped the direct
// child, including the expected SIGKILL path. Only a Wait failure without a
// ProcessState is an unproven reap and therefore blocks a stopped ACK.
func waitErrorRequiresStopFailure(err error) bool {
	if err == nil || errors.Is(err, os.ErrProcessDone) {
		return false
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) && exitErr.ProcessState != nil {
		return false
	}
	return true
}

func timerErrorCode(err error) Code {
	if errors.Is(err, errClockChanged) || errors.Is(err, syscall.ECANCELED) {
		return CodeClockChanged
	}
	return CodeClockChanged
}

type timerfdSpec struct {
	interval syscall.Timespec
	value    syscall.Timespec
}

type realtimeTimer struct {
	mu     sync.Mutex
	fd     uintptr
	file   *os.File
	closed bool
}

func newRealtimeTimer() (*realtimeTimer, error) {
	fd, _, errno := syscall.Syscall(syscall.SYS_TIMERFD_CREATE, uintptr(clockRealtime), uintptr(tfdCloexec|tfdNonblock), 0)
	if errno != 0 {
		return nil, errno
	}
	return &realtimeTimer{fd: fd, file: os.NewFile(fd, "workflow-execution-lease")}, nil
}

func (timer *realtimeTimer) arm(untilMS int64) error {
	seconds := untilMS / 1000
	nanoseconds := (untilMS % 1000) * int64(time.Millisecond)
	spec := timerfdSpec{value: syscall.Timespec{Sec: seconds, Nsec: nanoseconds}}
	timer.mu.Lock()
	defer timer.mu.Unlock()
	if timer.closed || timer.file == nil {
		return errTimerClosed
	}
	_, _, errno := syscall.Syscall6(
		syscall.SYS_TIMERFD_SETTIME,
		timer.fd,
		uintptr(tfdTimerAbstime|tfdTimerCancelOnSet),
		uintptr(unsafe.Pointer(&spec)),
		0,
		0,
		0,
	)
	if errno != 0 {
		if errors.Is(errno, syscall.ECANCELED) {
			return errClockChanged
		}
		return errno
	}
	return nil
}

func (timer *realtimeTimer) wait() error {
	timer.mu.Lock()
	file := timer.file
	closed := timer.closed
	timer.mu.Unlock()
	if closed || file == nil {
		return errTimerClosed
	}
	var expirations [8]byte
	for {
		_, err := io.ReadFull(file, expirations[:])
		if errors.Is(err, syscall.EINTR) {
			continue
		}
		if err != nil {
			if errors.Is(err, syscall.ECANCELED) {
				return errClockChanged
			}
			if errors.Is(err, os.ErrClosed) {
				return errTimerClosed
			}
			return err
		}
		_ = binary.LittleEndian.Uint64(expirations[:])
		return nil
	}
}

func (timer *realtimeTimer) close() error {
	timer.mu.Lock()
	if timer.closed {
		timer.mu.Unlock()
		return nil
	}
	timer.closed = true
	file := timer.file
	timer.fd = 0
	timer.file = nil
	timer.mu.Unlock()
	if file == nil {
		return nil
	}
	return file.Close()
}
