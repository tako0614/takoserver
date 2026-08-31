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
	maxJSONDepth            = 64
	maxBindings             = 64
)

var (
	bindingNamePattern = regexp.MustCompile(`^[A-Z_][A-Z0-9_]{0,127}$`)
	targetValuePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
	opaqueIDPattern    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
)

const runtimeInputPreflightFormatV1 = "takoserver.worker-runtime-input-preflight.v1"

// Target identifies the logical Worker endpoint to which a material set is
// scoped. The realized Worker UID is deliberately absent because the
// credential file is created before the ordinary OpenTofu apply. The provider
// binds that UID into the material-set commitment after the Worker exists.
type Target struct {
	Space        string `json:"space"`
	WorkerName   string `json:"workerName"`
	BundleName   string `json:"bundleName"`
	EndpointName string `json:"endpointName"`
}

type commitmentBinding struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// materialSetCommitmentDocument is the versioned, fixed-order preimage for a
// materialSetId. Its UTF-8 canonical JSON is emitted without insignificant
// whitespace in this exact key order:
// format, materialSetNonce, target (space, workerName, workerResourceUid,
// bundleName, originReservationId), bindings (sorted name/value pairs). The
// endpoint name and canonical origin are checked against the closed reservation
// projection but are deliberately not included in this server commitment.
// The nonce is stored only in the 0600 credential file and is never returned
// in provider state. It is sent only in the exact runtime preparation request
// after the closed reservation projection has been validated. Bindings are a
// sorted slice rather than a map so encoding/json cannot introduce an order
// ambiguity in the commitment. The resulting ID is
// material-set:v1:<lowercase SHA-256 hex>.
type materialSetCommitmentDocument struct {
	Format           string              `json:"format"`
	MaterialSetNonce string              `json:"materialSetNonce"`
	Target           commitmentTarget    `json:"target"`
	Bindings         []commitmentBinding `json:"bindings"`
}

type commitmentTarget struct {
	Space               string `json:"space"`
	WorkerName          string `json:"workerName"`
	WorkerResourceUID   string `json:"workerResourceUid"`
	BundleName          string `json:"bundleName"`
	OriginReservationID string `json:"originReservationId"`
}

type runtimeInputPreflightDocument struct {
	Format           string                      `json:"format"`
	MaterialSetNonce string                      `json:"materialSetNonce"`
	Target           runtimeInputPreflightTarget `json:"target"`
	Bindings         map[string]string           `json:"bindings"`
}

type runtimeInputPreflightTarget struct {
	Space                 string `json:"space"`
	WorkerName            string `json:"workerName"`
	BundleName            string `json:"bundleName"`
	EndpointName          string `json:"endpointName"`
	OriginReservationID   string `json:"originReservationId"`
	CanonicalPublicOrigin string `json:"canonicalPublicOrigin"`
}

// Envelope is the exact credential-file contract consumed by the Takoserver
// provider. Values deliberately have no String method so diagnostics cannot
// accidentally format the whole material set.
type Envelope struct {
	Format                string            `json:"format"`
	MaterialSetNonce      string            `json:"materialSetNonce"`
	Target                Target            `json:"target"`
	OriginReservationID   string            `json:"originReservationId"`
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
// that have a planned logical Worker target should use LoadForTarget so target
// drift is rejected before any material is sent to Takoserver.
func Load(path, expectedReservationID string, expectedNames []string) (Envelope, error) {
	return load(path, nil, expectedReservationID, expectedNames)
}

// LoadForTarget is Load with an exact planned logical Worker target check. The
// target and reservation identity are part of the material-set commitment, so
// changing either requires a fresh preflight credential file.
func LoadForTarget(path string, expectedTarget Target, expectedReservationID string, expectedNames []string) (Envelope, error) {
	return load(path, &expectedTarget, expectedReservationID, expectedNames)
}

func load(path string, expectedTarget *Target, expectedReservationID string, expectedNames []string) (Envelope, error) {
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
	if err := rejectUnpairedSurrogateEscapes(raw); err != nil {
		return Envelope{}, err
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
	if err := validateNonce(envelope.MaterialSetNonce); err != nil {
		return Envelope{}, err
	}
	if err := validateTarget(envelope.Target); err != nil {
		return Envelope{}, err
	}
	if expectedTarget != nil && envelope.Target != *expectedTarget {
		return Envelope{}, errors.New("runtime input credential file target does not match the planned target")
	}
	if !opaqueIDPattern.MatchString(envelope.OriginReservationID) || (expectedReservationID != "" && envelope.OriginReservationID != expectedReservationID) {
		return Envelope{}, errors.New("runtime input credential file origin reservation does not match the planned reservation")
	}
	if err := validateOrigin(envelope.CanonicalPublicOrigin); err != nil {
		return Envelope{}, err
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

func rejectDuplicateJSONKeys(raw []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	var walk func(int) error
	walk = func(depth int) error {
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		switch delimiter := token.(type) {
		case json.Delim:
			switch delimiter {
			case '{':
				if depth >= maxJSONDepth {
					return errors.New("runtime input credential file JSON nesting is too deep")
				}
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
					if err := walk(depth + 1); err != nil {
						return err
					}
				}
				_, err = decoder.Token()
				return err
			case '[':
				if depth >= maxJSONDepth {
					return errors.New("runtime input credential file JSON nesting is too deep")
				}
				for decoder.More() {
					if err := walk(depth + 1); err != nil {
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
	if err := walk(0); err != nil {
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

var errUnpairedSurrogateEscape = errors.New("runtime input credential file contains an unpaired UTF-16 surrogate escape")

// rejectUnpairedSurrogateEscapes checks JSON string escapes before
// encoding/json decodes them. encoding/json replaces a lone UTF-16 surrogate
// escape with U+FFFD, which would otherwise produce a different preflight
// commitment from the TypeScript implementation. Valid high/low pairs are
// left untouched and ordinary literal U+FFFD remains valid UTF-8.
func rejectUnpairedSurrogateEscapes(raw []byte) error {
	for index := 0; index < len(raw); index++ {
		if raw[index] != '"' {
			continue
		}
	stringScan:
		for index++; index < len(raw); index++ {
			switch raw[index] {
			case '"':
				// End of this JSON string; continue scanning for the next one.
				break stringScan
			case '\\':
				if index+1 >= len(raw) {
					continue
				}
				if raw[index+1] != 'u' || index+6 > len(raw) {
					index++
					continue
				}
				code, ok := parseHexQuad(raw[index+2 : index+6])
				if !ok {
					index++
					continue
				}
				switch {
				case code >= 0xD800 && code <= 0xDBFF:
					if index+12 > len(raw) || raw[index+6] != '\\' || raw[index+7] != 'u' {
						return errUnpairedSurrogateEscape
					}
					low, lowOK := parseHexQuad(raw[index+8 : index+12])
					if !lowOK || low < 0xDC00 || low > 0xDFFF {
						return errUnpairedSurrogateEscape
					}
					// Consume the complete high/low pair. The loop increment
					// advances to the first byte after the low escape.
					index += 11
				case code >= 0xDC00 && code <= 0xDFFF:
					return errUnpairedSurrogateEscape
				default:
					index += 5
				}
			}
		}
	}
	return nil
}

func parseHexQuad(raw []byte) (uint16, bool) {
	if len(raw) != 4 {
		return 0, false
	}
	var value uint16
	for _, digit := range raw {
		value <<= 4
		switch {
		case digit >= '0' && digit <= '9':
			value += uint16(digit - '0')
		case digit >= 'a' && digit <= 'f':
			value += uint16(digit-'a') + 10
		case digit >= 'A' && digit <= 'F':
			value += uint16(digit-'A') + 10
		default:
			return 0, false
		}
	}
	return value, true
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
		"space":        target.Space,
		"workerName":   target.WorkerName,
		"bundleName":   target.BundleName,
		"endpointName": target.EndpointName,
	} {
		if !targetValuePattern.MatchString(value) {
			return fmt.Errorf("runtime input credential file target field %q is invalid", name)
		}
	}
	return nil
}

// ComputeMaterialSetID binds the preflight envelope to the actual realized
// Worker UID. It is intentionally computed only after the provider has read
// the closed Takoserver reservation projection; callers must not supply an ID
// from HCL or the credential file.
func ComputeMaterialSetID(envelope Envelope, workerResourceUID string) (string, error) {
	if !opaqueIDPattern.MatchString(workerResourceUID) {
		return "", errors.New("worker resource identity is invalid")
	}
	if envelope.Format != FormatV1 {
		return "", errors.New("runtime input credential envelope is incomplete")
	}
	if err := validateNonce(envelope.MaterialSetNonce); err != nil {
		return "", errors.New("runtime input credential envelope has an invalid material set nonce")
	}
	if err := validateTarget(envelope.Target); err != nil {
		return "", errors.New("runtime input credential envelope has an invalid logical target")
	}
	if !opaqueIDPattern.MatchString(envelope.OriginReservationID) {
		return "", errors.New("runtime input credential envelope has an invalid origin reservation identity")
	}
	if err := validateOrigin(envelope.CanonicalPublicOrigin); err != nil {
		return "", errors.New("runtime input credential envelope has an invalid canonical public origin")
	}
	names := envelope.Names()
	if len(names) == 0 || len(names) > maxBindings {
		return "", errors.New("runtime input credential envelope has an invalid binding set")
	}
	bindings := make([]commitmentBinding, 0, len(names))
	for _, name := range names {
		if !bindingNamePattern.MatchString(name) || envelope.Values[name] == "" || !utf8.ValidString(envelope.Values[name]) {
			return "", errors.New("runtime input credential envelope has an invalid binding set")
		}
		bindings = append(bindings, commitmentBinding{Name: name, Value: envelope.Values[name]})
	}
	document := materialSetCommitmentDocument{
		Format:           MaterialSetCommitmentV1,
		MaterialSetNonce: envelope.MaterialSetNonce,
		Target: commitmentTarget{
			Space:               envelope.Target.Space,
			WorkerName:          envelope.Target.WorkerName,
			WorkerResourceUID:   workerResourceUID,
			BundleName:          envelope.Target.BundleName,
			OriginReservationID: envelope.OriginReservationID,
		},
		Bindings: bindings,
	}
	encoded, err := canonicalJSON(document)
	if err != nil {
		return "", errors.New("runtime input material set commitment cannot be encoded")
	}
	digest := sha256.Sum256(encoded)
	return materialSetIDPrefix + hex.EncodeToString(digest[:]), nil
}

// ComputeRuntimeInputReference derives the deterministic, value-free
// preparation reference that is safe to place in a Terraform plan. Unlike
// ComputeMaterialSetID, this preflight commitment is deliberately independent
// of the Worker resource UID because that UID does not exist until the ordinary
// apply starts. The reference carries the deterministic preparation ID and the
// full lowercase digest: rip1.prep-<first-32-hex>.<full-64-hex>.
func ComputeRuntimeInputReference(envelope Envelope) (string, error) {
	if envelope.Format != FormatV1 {
		return "", errors.New("runtime input credential envelope is incomplete")
	}
	if err := validateNonce(envelope.MaterialSetNonce); err != nil {
		return "", errors.New("runtime input credential envelope has an invalid material set nonce")
	}
	if err := validateTarget(envelope.Target); err != nil {
		return "", errors.New("runtime input credential envelope has an invalid logical target")
	}
	if !opaqueIDPattern.MatchString(envelope.OriginReservationID) {
		return "", errors.New("runtime input credential envelope has an invalid origin reservation identity")
	}
	if err := validateOrigin(envelope.CanonicalPublicOrigin); err != nil {
		return "", errors.New("runtime input credential envelope has an invalid canonical public origin")
	}
	names := envelope.Names()
	if len(names) == 0 || len(names) > maxBindings {
		return "", errors.New("runtime input credential envelope has an invalid binding set")
	}
	bindings := make(map[string]string, len(names))
	for _, name := range names {
		if !bindingNamePattern.MatchString(name) || envelope.Values[name] == "" || !utf8.ValidString(envelope.Values[name]) {
			return "", errors.New("runtime input credential envelope has an invalid binding set")
		}
		bindings[name] = envelope.Values[name]
	}
	document := runtimeInputPreflightDocument{
		Format:           runtimeInputPreflightFormatV1,
		MaterialSetNonce: envelope.MaterialSetNonce,
		Target: runtimeInputPreflightTarget{
			Space:                 envelope.Target.Space,
			WorkerName:            envelope.Target.WorkerName,
			BundleName:            envelope.Target.BundleName,
			EndpointName:          envelope.Target.EndpointName,
			OriginReservationID:   envelope.OriginReservationID,
			CanonicalPublicOrigin: envelope.CanonicalPublicOrigin,
		},
		Bindings: bindings,
	}
	encoded, err := canonicalJSON(document)
	if err != nil {
		return "", errors.New("runtime input preflight commitment cannot be encoded")
	}
	digest := sha256.Sum256(encoded)
	hexDigest := hex.EncodeToString(digest[:])
	preparationID := "prep-" + hexDigest[:32]
	return "rip1." + preparationID + "." + hexDigest, nil
}

// canonicalJSON emits the compact UTF-8 JSON used by the server commitment
// algorithms. Encoder.SetEscapeHTML(false) is required because Takoserver's
// reference implementation uses JSON.stringify; default Go marshaling would
// turn characters such as '&' into a different preimage.
func canonicalJSON(value any) ([]byte, error) {
	var encoded bytes.Buffer
	encoder := json.NewEncoder(&encoded)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	data := encoded.Bytes()
	if len(data) == 0 || data[len(data)-1] != '\n' {
		return nil, errors.New("canonical JSON encoder returned an invalid result")
	}
	return data[:len(data)-1], nil
}

func normalizeExpectedNames(names []string) ([]string, error) {
	if len(names) == 0 || len(names) > maxBindings {
		return nil, fmt.Errorf("runtime input binding name set must contain between 1 and %d names", maxBindings)
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
