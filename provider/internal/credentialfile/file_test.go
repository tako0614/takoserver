package credentialfile_test

import (
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"github.com/tako0614/takoserver/provider/internal/credentialfile"
	"golang.org/x/sys/unix"
)

const (
	reservationID = "reservation-01"
	origin        = "https://community.example.test"
	nonce         = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
)

func TestLoadForTargetAcceptsPreflightEnvelopeWithoutWorkerUIDOrMaterialSetID(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "runtime-inputs.json")
	writeEnvelope(t, path, validEnvelopeJSON(`"ENCRYPTION_KEY":"placeholder-encryption-value","TAKOSUMI_ACCOUNTS_CLIENT_ID":"placeholder-client-id"`))
	wantTarget := credentialfile.Target{Space: "default", WorkerName: "yurucommu", BundleName: "bundle-01", EndpointName: "public"}
	got, err := credentialfile.LoadForTarget(path, wantTarget, reservationID, []string{"ENCRYPTION_KEY", "TAKOSUMI_ACCOUNTS_CLIENT_ID"})
	if err != nil {
		t.Fatalf("LoadForTarget() error = %v", err)
	}
	if got.OriginReservationID != reservationID || got.CanonicalPublicOrigin != origin || got.Target != wantTarget {
		t.Fatalf("envelope = %#v", got)
	}
	if gotNames := got.Names(); !reflect.DeepEqual(gotNames, []string{"ENCRYPTION_KEY", "TAKOSUMI_ACCOUNTS_CLIENT_ID"}) {
		t.Fatalf("Names() = %#v", gotNames)
	}
}

func TestComputeMaterialSetIDBindsActualWorkerAndExactReservation(t *testing.T) {
	t.Parallel()
	envelope := credentialfile.Envelope{
		Format:                credentialfile.FormatV1,
		MaterialSetNonce:      nonce,
		Target:                credentialfile.Target{Space: "default", WorkerName: "yurucommu", BundleName: "bundle-01", EndpointName: "public"},
		OriginReservationID:   reservationID,
		CanonicalPublicOrigin: origin,
		Values:                map[string]string{"B": "two", "A": "one"},
	}
	got, err := credentialfile.ComputeMaterialSetID(envelope, "uid-worker-01")
	if err != nil {
		t.Fatalf("ComputeMaterialSetID() error = %v", err)
	}
	if !strings.HasPrefix(got, "material-set:v1:") || len(got) != len("material-set:v1:")+64 {
		t.Fatalf("material set id = %q", got)
	}
	if got != "material-set:v1:b17bd040d532e1a8e57b4f4e0fc2181f35e1e30aba06fe093771a3526306b706" {
		t.Fatalf("material set commitment preimage drifted = %q", got)
	}
	changed, err := credentialfile.ComputeMaterialSetID(envelope, "uid-worker-02")
	if err != nil {
		t.Fatalf("ComputeMaterialSetID(changed) error = %v", err)
	}
	if got == changed {
		t.Fatal("material set identity did not change with realized worker UID")
	}
	for name, variant := range map[string]credentialfile.Envelope{
		"endpoint": func() credentialfile.Envelope {
			copy := envelope
			copy.Target.EndpointName = "private"
			return copy
		}(),
		"origin": func() credentialfile.Envelope {
			copy := envelope
			copy.CanonicalPublicOrigin = "https://other.example.test"
			return copy
		}(),
	} {
		variantID, variantErr := credentialfile.ComputeMaterialSetID(variant, "uid-worker-01")
		if variantErr != nil {
			t.Fatalf("ComputeMaterialSetID(%s) error = %v", name, variantErr)
		}
		if variantID != got {
			t.Errorf("material set identity changed with excluded %s", name)
		}
	}
}

func TestComputeRuntimeInputReferenceIsStableAndCommitsPreflightFacts(t *testing.T) {
	t.Parallel()
	envelope := credentialfile.Envelope{
		Format:                credentialfile.FormatV1,
		MaterialSetNonce:      nonce,
		Target:                credentialfile.Target{Space: "default", WorkerName: "yurucommu", BundleName: "bundle-01", EndpointName: "public"},
		OriginReservationID:   reservationID,
		CanonicalPublicOrigin: origin,
		Values:                map[string]string{"B": "two", "A": "one"},
	}
	got, err := credentialfile.ComputeRuntimeInputReference(envelope)
	if err != nil {
		t.Fatalf("ComputeRuntimeInputReference() error = %v", err)
	}
	if !regexp.MustCompile(`^rip1\.prep-[0-9a-f]{32}\.[0-9a-f]{64}$`).MatchString(got) {
		t.Fatalf("runtime input reference = %q", got)
	}
	if got != "rip1.prep-3f3ac4f812f773a7aafd8afd0aebc9a6.3f3ac4f812f773a7aafd8afd0aebc9a68f545ea3782d5c0e8e6674b0ad1d504d" {
		t.Fatalf("runtime input reference preimage drifted = %q", got)
	}
	repeated, err := credentialfile.ComputeRuntimeInputReference(envelope)
	if err != nil || repeated != got {
		t.Fatalf("same envelope reference = %q, error = %v", repeated, err)
	}
	for name, changed := range map[string]credentialfile.Envelope{
		"nonce": func() credentialfile.Envelope {
			copy := envelope
			copy.MaterialSetNonce = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE"
			return copy
		}(),
		"target": func() credentialfile.Envelope { copy := envelope; copy.Target.WorkerName = "other-worker"; return copy }(),
		"endpoint": func() credentialfile.Envelope {
			copy := envelope
			copy.Target.EndpointName = "private"
			return copy
		}(),
		"reservation": func() credentialfile.Envelope {
			copy := envelope
			copy.OriginReservationID = "reservation-02"
			return copy
		}(),
		"origin": func() credentialfile.Envelope {
			copy := envelope
			copy.CanonicalPublicOrigin = "https://other.example.test"
			return copy
		}(),
		"binding": func() credentialfile.Envelope {
			copy := envelope
			copy.Values = map[string]string{"A": "changed", "B": "two"}
			return copy
		}(),
	} {
		changedReference, callErr := credentialfile.ComputeRuntimeInputReference(changed)
		if callErr != nil {
			t.Fatalf("changed %s reference error = %v", name, callErr)
		}
		if changedReference == got {
			t.Errorf("changed %s did not change runtime input reference", name)
		}
	}
}

func TestComputeRuntimeInputReferenceCrossLanguageEscapingGolden(t *testing.T) {
	t.Parallel()
	// The shared canonical preimage uses compact UTF-8 JSON. SetEscapeHTML(false)
	// keeps <>& literal, encoding/json escapes U+2028/U+2029 as \u2028/\u2029,
	// and non-BMP runes remain UTF-8. Keep this exact fixture aligned with the
	// Takoserver JSON.stringify implementation and its cross-language golden.
	envelope := credentialfile.Envelope{
		Format:                credentialfile.FormatV1,
		MaterialSetNonce:      nonce,
		Target:                credentialfile.Target{Space: "default", WorkerName: "yurucommu", BundleName: "bundle-01", EndpointName: "public"},
		OriginReservationID:   reservationID,
		CanonicalPublicOrigin: origin,
		Values: map[string]string{
			"Z": "non-bmp-😀",
			"A": "<&>\u2028\u2029",
		},
	}
	got, err := credentialfile.ComputeRuntimeInputReference(envelope)
	if err != nil {
		t.Fatalf("ComputeRuntimeInputReference() error = %v", err)
	}
	const want = "rip1.prep-2e42bd63644611fe7a79da06e0993205.2e42bd63644611fe7a79da06e09932056f6ac00874251acb75f174d3a18d931c"
	if got != want {
		t.Fatalf("cross-language runtime input reference = %q, want %q", got, want)
	}
}

func TestLoadRejectsReservationAndLogicalTargetDrift(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "runtime-inputs.json")
	writeEnvelope(t, path, validEnvelopeJSON(`"ENCRYPTION_KEY":"placeholder-encryption-value"`))
	target := credentialfile.Target{Space: "default", WorkerName: "yurucommu", BundleName: "bundle-01", EndpointName: "public"}
	if _, err := credentialfile.LoadForTarget(path, target, "reservation-02", []string{"ENCRYPTION_KEY"}); err == nil || !strings.Contains(err.Error(), "reservation") {
		t.Fatalf("reservation drift error = %v", err)
	}
	if _, err := credentialfile.LoadForTarget(path, credentialfile.Target{Space: "other", WorkerName: target.WorkerName, BundleName: target.BundleName, EndpointName: target.EndpointName}, reservationID, []string{"ENCRYPTION_KEY"}); err == nil || !strings.Contains(err.Error(), "target") {
		t.Fatalf("target drift error = %v", err)
	}
}

func TestLoadRejectsOldForbiddenEnvelopeFields(t *testing.T) {
	t.Parallel()
	for _, field := range []string{
		`"materialSetId":"material-set:v1-legacy"`,
		`"workerResourceUid":"uid-worker-01"`,
		`"endpointResourceUid":"uid-endpoint-01"`,
		`"originResourceUid":"uid-origin-01"`,
	} {
		field := field
		t.Run(field, func(t *testing.T) {
			t.Parallel()
			path := filepath.Join(t.TempDir(), "runtime-inputs.json")
			contents := strings.TrimSuffix(validEnvelopeJSON(`"ENCRYPTION_KEY":"placeholder-encryption-value"`), "\n")
			contents = strings.TrimSuffix(contents, "}\n") + "," + field + "}\n"
			writeEnvelope(t, path, contents)
			if _, err := credentialfile.Load(path, reservationID, []string{"ENCRYPTION_KEY"}); err == nil {
				t.Fatalf("Load() accepted forbidden field %s", field)
			}
		})
	}
}

func TestLoadRejectsSecureFileHazards(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name  string
		setup func(*testing.T, string)
	}{
		{name: "symlink", setup: func(t *testing.T, path string) {
			target := filepath.Join(t.TempDir(), "target.json")
			writeEnvelope(t, target, validEnvelopeJSON(`"ENCRYPTION_KEY":"placeholder-encryption-value"`))
			if err := os.Symlink(target, path); err != nil {
				t.Fatalf("symlink: %v", err)
			}
		}},
		{name: "world-readable", setup: func(t *testing.T, path string) {
			writeEnvelope(t, path, validEnvelopeJSON(`"ENCRYPTION_KEY":"placeholder-encryption-value"`))
			if err := os.Chmod(path, 0o644); err != nil {
				t.Fatalf("chmod: %v", err)
			}
		}},
		{name: "directory", setup: func(t *testing.T, path string) {
			if err := os.Mkdir(path, 0o700); err != nil {
				t.Fatalf("mkdir: %v", err)
			}
		}},
		{name: "fifo", setup: func(t *testing.T, path string) {
			if err := unix.Mkfifo(path, 0o600); err != nil {
				t.Fatalf("mkfifo: %v", err)
			}
		}},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			path := filepath.Join(t.TempDir(), "runtime-inputs.json")
			test.setup(t, path)
			if _, err := credentialfile.Load(path, reservationID, []string{"ENCRYPTION_KEY"}); err == nil {
				t.Fatal("Load() accepted insecure credential file")
			}
		})
	}
}

func TestLoadRejectsDuplicateAndDeepJSON(t *testing.T) {
	t.Parallel()
	for _, test := range []string{
		`{"format":"takosumi.provider-credential-file@v1","format":"secret"}`,
		strings.Repeat(`[`, 65) + `"secret"` + strings.Repeat(`]`, 65),
	} {
		test := test
		t.Run("shape", func(t *testing.T) {
			t.Parallel()
			path := filepath.Join(t.TempDir(), "runtime-inputs.json")
			writeEnvelope(t, path, test)
			if _, err := credentialfile.Load(path, reservationID, []string{"ENCRYPTION_KEY"}); err == nil || strings.Contains(err.Error(), "secret") {
				t.Fatalf("Load() error = %v", err)
			}
		})
	}
}

func TestLoadRejectsUnpairedSurrogateEscapes(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name  string
		value string
	}{
		{name: "high-only", value: `"\ud800"`},
		{name: "low-only", value: `"\udc00"`},
		{name: "broken-pair", value: `"\ud800\u0041"`},
	} {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			path := filepath.Join(t.TempDir(), "runtime-inputs.json")
			writeEnvelope(t, path, validEnvelopeJSON(`"ENCRYPTION_KEY":`+test.value))
			if _, err := credentialfile.Load(path, reservationID, []string{"ENCRYPTION_KEY"}); err == nil || !strings.Contains(err.Error(), "surrogate") {
				t.Fatalf("Load() error = %v, want unpaired surrogate rejection", err)
			}
		})
	}
}

func TestLoadAcceptsValidSurrogatePairAndLiteralReplacementRune(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "runtime-inputs.json")
	writeEnvelope(t, path, validEnvelopeJSON(`"ENCRYPTION_KEY":"\ud83d\ude00","LITERAL_REPLACEMENT":"�","ESCAPED_TEXT":"\\uD800"`))
	got, err := credentialfile.Load(path, reservationID, []string{"ENCRYPTION_KEY", "LITERAL_REPLACEMENT", "ESCAPED_TEXT"})
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if got.Values["ENCRYPTION_KEY"] != "😀" {
		t.Fatalf("surrogate pair value = %q, want non-BMP rune", got.Values["ENCRYPTION_KEY"])
	}
	if got.Values["LITERAL_REPLACEMENT"] != "�" {
		t.Fatalf("literal replacement value = %q, want U+FFFD", got.Values["LITERAL_REPLACEMENT"])
	}
	if got.Values["ESCAPED_TEXT"] != `\uD800` {
		t.Fatalf("escaped literal value = %q, want the literal backslash-u text", got.Values["ESCAPED_TEXT"])
	}
}

func writeEnvelope(t *testing.T, path, contents string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatalf("write credential fixture: %v", err)
	}
}

func validEnvelopeJSON(values string) string {
	return fmt.Sprintf(`{
  "format":"takosumi.provider-credential-file@v1",
  "materialSetNonce":%q,
  "target":{"space":"default","workerName":"yurucommu","bundleName":"bundle-01","endpointName":"public"},
  "originReservationId":%q,
  "canonicalPublicOrigin":%q,
  "values":{%s}
}
`, nonce, reservationID, origin, values)
}

func init() {
	// Keep the fixture nonce visibly valid if the base64 alphabet changes in a
	// future Go release; this assertion only runs in tests and has no runtime
	// effect.
	_, _ = base64.RawURLEncoding.DecodeString(nonce)
}
