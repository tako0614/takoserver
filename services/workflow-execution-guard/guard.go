// Package guard owns one private workflow execution and one exact workerd
// child. It is intentionally a narrow controller protocol, not a public API
// or a general subprocess runner. Its safety boundary covers ordinary user
// process faults and the direct child only; privileged SIGSTOP/kernel
// suspension and arbitrary descendant-tree containment are outside scope.
package guard

import (
	"errors"
	"io"
)

const (
	// MaxFrameBytes bounds one JSONL request or reply, excluding its newline.
	MaxFrameBytes = 16 * 1024
	// MaxLifetimeMilliseconds is the one-year absolute execution ceiling.
	MaxLifetimeMilliseconds int64 = 31_536_000_000
)

// Options configures one guard process. In and Out are the private JSONL
// controller pipe; the child never receives either descriptor.
type Options struct {
	WorkerdBinary string
	In            io.Reader
	Out           io.Writer
}

// Code is a bounded internal failure classification emitted on the private
// control pipe. These codes are deliberately not JavaScript-facing errors.
type Code string

const (
	CodeInvalidInput         Code = "invalid_input"
	CodeInvalidFrame         Code = "invalid_frame"
	CodeFrameTooLarge        Code = "frame_too_large"
	CodeInvalidID            Code = "invalid_id"
	CodeInvalidIdentity      Code = "invalid_identity"
	CodeInvalidDeadline      Code = "invalid_deadline"
	CodeInvalidLease         Code = "invalid_lease"
	CodeInvalidConfigPath    Code = "invalid_config_path"
	CodeNotRegistered        Code = "not_registered"
	CodeAlreadyRegistered    Code = "already_registered"
	CodeAlreadyStarted       Code = "already_started"
	CodeStopped              Code = "stopped"
	CodeLeaseExpired         Code = "lease_expired"
	CodeDeadlineExpired      Code = "deadline_expired"
	CodeClockChanged         Code = "clock_changed"
	CodeChildStartFailed     Code = "child_start_failed"
	CodeChildExited          Code = "child_exited"
	CodeStopFailed           Code = "stop_failed"
	CodeProtocolOutput       Code = "protocol_output"
	CodeProtocolBackpressure Code = "protocol_backpressure"
	CodeUnsupported          Code = "unsupported_platform"
)

// Error is returned when the guard cannot continue. Code is intentionally
// bounded so callers do not receive child command output or host internals.
type Error struct {
	Code  Code
	Cause error
}

func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	if e.Cause == nil {
		return string(e.Code)
	}
	return string(e.Code) + ": " + e.Cause.Error()
}

func (e *Error) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Cause
}

func guardError(code Code, cause error) error {
	return &Error{Code: code, Cause: cause}
}

var errUnsupported = errors.New("workflow execution guard requires linux/amd64")
