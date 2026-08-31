// Package credentialfile loads one run-scoped material set without following
// links or accepting a file another local user can read.
package credentialfile

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"golang.org/x/sys/unix"
)

const (
	FormatV1                = "takosumi.provider-credential-file@v1"
	MaterialSetCommitmentV1 = "takoserver.worker-runtime-input-material-set@v1"
	materialSetIDPrefix     = "material-set:v1:"
	materialSetNonceBytes   = 32
	maxFileBytes            = 128 * 1024
)

var (
	materialSetIDPattern = regexp.MustCompile(`^material-set:v1:[0-9a-f]{64}$`)
	bindingNamePattern   = regexp.MustCompile(`^[A-Z_][A-Z0-9_]{0,127}$`)
	targetValuePattern   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
)

// Target identifies the exact Worker realization to which a material set is
// scoped. It is included in the credential-file commitment and is never
// inferred from the file when the provider has a planned target.
type Target struct {
	Space             string `json:"space"`
	WorkerName        string `json:"workerName"`
	BundleName        string `json:"bundleName"`
	OriginResourceUID string `json:"originResourceUid"`
}

type commitmentBinding struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// materialSetCommitmentDocument is the versioned, fixed-order preimage for a
// materialSetId. Its UTF-8 canonical JSON is emitted without insignificant
// whitespace in this exact key order:
// format, materialSetNonce, target (space, workerName, bundleName,
// originResourceUid), canonicalPublicOrigin, bindings (sorted name/value
// pairs). The nonce is stored only in the 0600 credential file; it is
// deliberately never returned in state or sent to Takoserver. Bindings are a
// sorted slice rather than a map so encoding/json cannot introduce an order
// ambiguity in the commitment. The resulting ID is
// material-set:v1:<lowercase SHA-256 hex>.
type materialSetCommitmentDocument struct {
	Format                string              `json:"format"`
	MaterialSetNonce      string              `json:"materialSetNonce"`
	Target                Target              `json:"target"`
	CanonicalPublicOrigin string              `json:"canonicalPublicOrigin"`
	Bindings              []commitmentBinding `json:"bindings"`
}

// Envelope is the exact credential-file contract consumed by the Takoserver
// provider. Values deliberately have no String method so diagnostics cannot
// accidentally format the whole material set.
type Envelope struct {
	Format                string            `json:"format"`
	MaterialSetID         string            `json:"materialSetId"`
	MaterialSetNonce      string            `json:"materialSetNonce"`
	Target                Target            `json:"target"`
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
// file, and validates the closed envelope before returning any values. Callers
// that have a planned Worker target should use LoadForTarget so target drift is
// rejected before any material is sent to Takoserver.
func Load(path, expectedOrigin string, expectedNames []string) (Envelope, error) {
	return load(path, nil, expectedOrigin, expectedNames)
}

// LoadForTarget is Load with an exact planned Worker target check. The target
// is part of the material-set commitment, so changing it without changing the
// materialSetId is rejected locally before an HTTP request is made.
func LoadForTarget(path string, expectedTarget Target, expectedOrigin string, expectedNames []string) (Envelope, error) {
	return load(path, &expectedTarget, expectedOrigin, expectedNames)
}

func load(path string, expectedTarget *Target, expectedOrigin string, expectedNames []string) (Envelope, error) {
	if path == "" {
		return Envelope{}, errors.New("runtime input credential file is not configured")
	}

	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_NONBLOCK|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
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
	if stat.Mode&0o7777 != 0o600 {
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
	if !utf8.Valid(raw) {
		return Envelope{}, errors.New("runtime input credential file is not valid UTF-8 JSON")
	}

	var envelope Envelope
	if err := rejectDuplicateJSONKeys(raw); err != nil {
		return Envelope{}, err
	}
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
	if err := validateNonce(envelope.MaterialSetNonce); err != nil {
		return Envelope{}, err
	}
	if err := validateTarget(envelope.Target); err != nil {
		return Envelope{}, err
	}
	if expectedTarget != nil && envelope.Target != *expectedTarget {
		return Envelope{}, errors.New("runtime input credential file target does not match the planned target")
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
	if expectedID := computeMaterialSetID(envelope); envelope.MaterialSetID != expectedID {
		return Envelope{}, errors.New("runtime input credential file material set identity does not match its contents")
	}

	return envelope, nil
}

func rejectDuplicateJSONKeys(raw []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	var walk func() error
	walk = func() error {
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		switch delimiter := token.(type) {
		case json.Delim:
			switch delimiter {
			case '{':
				seen := make(map[string]struct{})
				for decoder.More() {
					key, err := decoder.Token()
					if err != nil {
						return err
					}
					name, ok := key.(string)
					if !ok {
						return errors.New("runtime input credential file is not the exact v1 JSON envelope")
					}
					if _, exists := seen[name]; exists {
						return errors.New("runtime input credential file contains duplicate JSON fields")
					}
					seen[name] = struct{}{}
					if err := walk(); err != nil {
						return err
					}
				}
				_, err = decoder.Token()
				return err
			case '[':
				for decoder.More() {
					if err := walk(); err != nil {
						return err
					}
				}
				_, err = decoder.Token()
				return err
			default:
				return errors.New("runtime input credential file is not the exact v1 JSON envelope")
			}
		default:
			return nil
		}
	}
	if err := walk(); err != nil {
		return errors.New("runtime input credential file is not the exact v1 JSON envelope")
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return errors.New("runtime input credential file contains trailing JSON")
	}
	return nil
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
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" || parsed.Opaque != "" || parsed.Path != "" || parsed.RawPath != "" || strings.HasSuffix(parsed.Host, ":") || nonCanonicalPort(parsed) {
		return errors.New("runtime input credential file has an invalid canonical public origin")
	}
	if parsed.Host != strings.ToLower(parsed.Host) || parsed.String() != value {
		return errors.New("runtime input credential file canonical public origin is not canonical")
	}
	return nil
}

func nonCanonicalPort(parsed *url.URL) bool {
	port := parsed.Port()
	if port == "" {
		return false
	}
	numeric, err := strconv.Atoi(port)
	return err != nil || numeric <= 0 || numeric > 65535 || strconv.Itoa(numeric) != port || numeric == 443
}

func validateNonce(value string) error {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(decoded) != materialSetNonceBytes || base64.RawURLEncoding.EncodeToString(decoded) != value {
		return errors.New("runtime input credential file has an invalid material set nonce")
	}
	return nil
}

func validateTarget(target Target) error {
	for name, value := range map[string]string{
		"space":             target.Space,
		"workerName":        target.WorkerName,
		"bundleName":        target.BundleName,
		"originResourceUid": target.OriginResourceUID,
	} {
		if !targetValuePattern.MatchString(value) {
			return fmt.Errorf("runtime input credential file target field %q is invalid", name)
		}
	}
	return nil
}

func computeMaterialSetID(envelope Envelope) string {
	names := envelope.Names()
	bindings := make([]commitmentBinding, 0, len(names))
	for _, name := range names {
		bindings = append(bindings, commitmentBinding{Name: name, Value: envelope.Values[name]})
	}
	document := materialSetCommitmentDocument{
		Format:                MaterialSetCommitmentV1,
		MaterialSetNonce:      envelope.MaterialSetNonce,
		Target:                envelope.Target,
		CanonicalPublicOrigin: envelope.CanonicalPublicOrigin,
		Bindings:              bindings,
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		return ""
	}
	digest := sha256.Sum256(encoded)
	return materialSetIDPrefix + hex.EncodeToString(digest[:])
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
