// Package credentialfile loads one run-scoped material set without following
// links or accepting a file another local user can read.
package credentialfile

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"regexp"
	"sort"

	"golang.org/x/sys/unix"
)

const (
	FormatV1     = "takosumi.provider-credential-file@v1"
	maxFileBytes = 128 * 1024
)

var (
	materialSetIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	bindingNamePattern   = regexp.MustCompile(`^[A-Z_][A-Z0-9_]{0,127}$`)
)

// Envelope is the exact credential-file contract consumed by the Takoserver
// provider. Values deliberately have no String method so diagnostics cannot
// accidentally format the whole material set.
type Envelope struct {
	Format                string            `json:"format"`
	MaterialSetID         string            `json:"materialSetId"`
	CanonicalPublicOrigin string            `json:"canonicalPublicOrigin"`
	Values                map[string]string `json:"values"`
}

// Names returns the sorted, non-secret binding names in this material set.
func (e Envelope) Names() []string {
	names := make([]string, 0, len(e.Values))
	for name := range e.Values {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// Load opens path without following a symlink, requires an owner-only regular
// file, and validates the closed envelope before returning any values.
func Load(path, expectedOrigin string, expectedNames []string) (Envelope, error) {
	if path == "" {
		return Envelope{}, errors.New("runtime input credential file is not configured")
	}

	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return Envelope{}, errors.New("runtime input credential file cannot be opened securely")
	}
	file := os.NewFile(uintptr(fd), "runtime-input-credential")
	if file == nil {
		_ = unix.Close(fd)
		return Envelope{}, errors.New("runtime input credential file cannot be opened securely")
	}
	defer file.Close()

	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		return Envelope{}, errors.New("runtime input credential file metadata cannot be read")
	}
	if stat.Mode&unix.S_IFMT != unix.S_IFREG {
		return Envelope{}, errors.New("runtime input credential file must be a regular file")
	}
	if stat.Mode&0o777 != 0o600 {
		return Envelope{}, errors.New("runtime input credential file mode must be 0600")
	}
	if stat.Uid != uint32(os.Geteuid()) {
		return Envelope{}, errors.New("runtime input credential file must be owned by the provider process user")
	}
	if stat.Size <= 0 || stat.Size > maxFileBytes {
		return Envelope{}, fmt.Errorf("runtime input credential file size must be between 1 and %d bytes", maxFileBytes)
	}

	raw, err := io.ReadAll(io.LimitReader(file, maxFileBytes+1))
	if err != nil {
		return Envelope{}, errors.New("runtime input credential file cannot be read")
	}
	if len(raw) > maxFileBytes {
		return Envelope{}, fmt.Errorf("runtime input credential file size must be at most %d bytes", maxFileBytes)
	}

	var envelope Envelope
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&envelope); err != nil {
		return Envelope{}, errors.New("runtime input credential file is not the exact v1 JSON envelope")
	}
	if err := requireJSONEOF(decoder); err != nil {
		return Envelope{}, err
	}
	if envelope.Format != FormatV1 {
		return Envelope{}, errors.New("runtime input credential file has an unsupported format")
	}
	if !materialSetIDPattern.MatchString(envelope.MaterialSetID) {
		return Envelope{}, errors.New("runtime input credential file has an invalid material set identity")
	}
	if err := validateOrigin(envelope.CanonicalPublicOrigin); err != nil {
		return Envelope{}, err
	}
	if envelope.CanonicalPublicOrigin != expectedOrigin {
		return Envelope{}, errors.New("runtime input credential file origin does not match the planned origin")
	}

	wantNames, err := normalizeExpectedNames(expectedNames)
	if err != nil {
		return Envelope{}, err
	}
	gotNames := envelope.Names()
	if !equalStrings(gotNames, wantNames) {
		return Envelope{}, errors.New("runtime input credential file binding names do not match the planned names")
	}
	for _, name := range gotNames {
		if envelope.Values[name] == "" {
			return Envelope{}, fmt.Errorf("runtime input credential file binding %q is empty", name)
		}
	}

	return envelope, nil
}

func requireJSONEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("runtime input credential file contains trailing JSON")
	}
	return nil
}

func validateOrigin(value string) error {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
		return errors.New("runtime input credential file has an invalid canonical public origin")
	}
	if parsed.String() != value {
		return errors.New("runtime input credential file canonical public origin is not canonical")
	}
	return nil
}

func normalizeExpectedNames(names []string) ([]string, error) {
	if len(names) == 0 {
		return nil, errors.New("at least one runtime input binding name is required")
	}
	normalized := append([]string(nil), names...)
	sort.Strings(normalized)
	for index, name := range normalized {
		if !bindingNamePattern.MatchString(name) {
			return nil, fmt.Errorf("runtime input binding name %q is outside the portable environment namespace", name)
		}
		if index > 0 && normalized[index-1] == name {
			return nil, fmt.Errorf("runtime input binding name %q is duplicated", name)
		}
	}
	return normalized, nil
}

func equalStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}
