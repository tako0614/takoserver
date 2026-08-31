package credentialfile_test

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/tako0614/takoserver/provider/internal/credentialfile"
	"golang.org/x/sys/unix"
)

func TestLoadAcceptsOneExactSecureMaterialSet(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	path := filepath.Join(dir, "runtime-inputs.json")
	wantNames := []string{
		"ENCRYPTION_KEY",
		"TAKOSUMI_ACCOUNTS_CLIENT_ID",
		"TAKOSUMI_ACCOUNTS_ISSUER_URL",
		"TAKOSUMI_ACCOUNTS_OWNER_SUB",
		"TAKOSUMI_ACCOUNTS_REDIRECT_URI",
	}
	contents := []byte(`{
  "format": "takosumi.provider-credential-file@v1",
  "materialSetId": "material-set:v1:caa5711aad0ba57684e8d97b2ba0bb6082382a6ac32422b88450fb8498c4fba5",
  "materialSetNonce": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "target": {
    "space": "default",
    "workerName": "yurucommu",
    "bundleName": "bundle-01",
    "originResourceUid": "uid-origin-01"
  },
  "canonicalPublicOrigin": "https://community.example.test",
  "values": {
    "ENCRYPTION_KEY": "placeholder-encryption-value",
    "TAKOSUMI_ACCOUNTS_CLIENT_ID": "placeholder-client-id",
    "TAKOSUMI_ACCOUNTS_ISSUER_URL": "https://accounts.example.test",
    "TAKOSUMI_ACCOUNTS_OWNER_SUB": "placeholder-owner-sub",
    "TAKOSUMI_ACCOUNTS_REDIRECT_URI": "https://community.example.test/auth/callback"
  }
}`)
	if err := os.WriteFile(path, contents, 0o600); err != nil {
		t.Fatalf("write credential fixture: %v", err)
	}

	got, err := credentialfile.Load(path, "https://community.example.test", wantNames)
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if got.Format != "takosumi.provider-credential-file@v1" {
		t.Fatalf("Format = %q", got.Format)
	}
	if got.MaterialSetID != "material-set:v1:caa5711aad0ba57684e8d97b2ba0bb6082382a6ac32422b88450fb8498c4fba5" {
		t.Fatalf("MaterialSetID = %q", got.MaterialSetID)
	}
	if got.CanonicalPublicOrigin != "https://community.example.test" {
		t.Fatalf("CanonicalPublicOrigin = %q", got.CanonicalPublicOrigin)
	}
	if gotNames := got.Names(); !reflect.DeepEqual(gotNames, wantNames) {
		t.Fatalf("Names() = %#v, want %#v", gotNames, wantNames)
	}
}

func TestLoadRejectsBindingNamesOutsideThePortableEnvironmentNamespace(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "runtime-inputs.json")
	if err := os.WriteFile(path, []byte(`{
      "format":"takosumi.provider-credential-file@v1",
      "materialSetId":"material-set:v1:0000000000000000000000000000000000000000000000000000000000000000",
      "materialSetNonce":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "target":{"space":"default","workerName":"yurucommu","bundleName":"bundle-01","originResourceUid":"uid-origin-01"},
      "canonicalPublicOrigin":"https://community.example.test",
      "values":{"../TOKEN":"placeholder-value"}
    }`), 0o600); err != nil {
		t.Fatalf("write credential fixture: %v", err)
	}

	if _, err := credentialfile.Load(path, "https://community.example.test", []string{"../TOKEN"}); err == nil {
		t.Fatal("Load() accepted a binding name outside the portable environment namespace")
	}
}

func TestLoadAcceptsCanonicalJSONWithReorderedValues(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "runtime-inputs.json")
	contents := validEnvelopeJSON(
		"material-set:v1:5866abee0fff6a8765e02977561092a6f78cd3e97a5e2380a548aafbd030f4a3",
		"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		"https://community.example.test",
		`"TAKOSUMI_ACCOUNTS_CLIENT_ID":"placeholder-client-id","ENCRYPTION_KEY":"placeholder-encryption-value"`,
	)
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatalf("write credential fixture: %v", err)
	}

	got, err := credentialfile.LoadForTarget(path, credentialfile.Target{
		Space:             "default",
		WorkerName:        "yurucommu",
		BundleName:        "bundle-01",
		OriginResourceUID: "uid-origin-01",
	}, "https://community.example.test", []string{"ENCRYPTION_KEY", "TAKOSUMI_ACCOUNTS_CLIENT_ID"})
	if err != nil {
		t.Fatalf("LoadForTarget() error = %v", err)
	}
	if got.MaterialSetID != "material-set:v1:5866abee0fff6a8765e02977561092a6f78cd3e97a5e2380a548aafbd030f4a3" || len(got.Values) != 2 {
		t.Fatalf("loaded envelope = %#v", got)
	}
}

func TestLoadRejectsHighValueCredentialFileHazards(t *testing.T) {
	t.Parallel()

	const materialSetID = "material-set:v1:5866abee0fff6a8765e02977561092a6f78cd3e97a5e2380a548aafbd030f4a3"
	const nonce = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	tests := []struct {
		name  string
		setup func(t *testing.T, path string)
	}{
		{
			name: "symlink",
			setup: func(t *testing.T, path string) {
				t.Helper()
				target := filepath.Join(t.TempDir(), "target.json")
				if err := os.WriteFile(target, []byte(validEnvelopeJSON(materialSetID, nonce, "https://community.example.test", `"ENCRYPTION_KEY":"placeholder-encryption-value","TAKOSUMI_ACCOUNTS_CLIENT_ID":"placeholder-client-id"`)), 0o600); err != nil {
					t.Fatalf("write symlink target: %v", err)
				}
				if err := os.Symlink(target, path); err != nil {
					t.Fatalf("create symlink: %v", err)
				}
			},
		},
		{
			name: "world-readable mode",
			setup: func(t *testing.T, path string) {
				t.Helper()
				writeValidEnvelope(t, path, materialSetID, nonce)
				if err := os.Chmod(path, 0o644); err != nil {
					t.Fatalf("chmod credential fixture: %v", err)
				}
			},
		},
		{
			name: "directory",
			setup: func(t *testing.T, path string) {
				t.Helper()
				if err := os.Mkdir(path, 0o700); err != nil {
					t.Fatalf("mkdir credential path: %v", err)
				}
			},
		},
		{
			name: "fifo",
			setup: func(t *testing.T, path string) {
				t.Helper()
				if err := unix.Mkfifo(path, 0o600); err != nil {
					t.Fatalf("mkfifo credential path: %v", err)
				}
			},
		},
		{
			name: "empty",
			setup: func(t *testing.T, path string) {
				t.Helper()
				if err := os.WriteFile(path, nil, 0o600); err != nil {
					t.Fatalf("write empty credential fixture: %v", err)
				}
			},
		},
		{
			name: "oversize",
			setup: func(t *testing.T, path string) {
				t.Helper()
				if err := os.WriteFile(path, []byte(strings.Repeat("x", 128*1024+1)), 0o600); err != nil {
					t.Fatalf("write oversize credential fixture: %v", err)
				}
			},
		},
		{
			name: "unknown field",
			setup: func(t *testing.T, path string) {
				t.Helper()
				contents := validEnvelopeJSON(materialSetID, nonce, "https://community.example.test", `"ENCRYPTION_KEY":"placeholder-encryption-value","TAKOSUMI_ACCOUNTS_CLIENT_ID":"placeholder-client-id"`)
				contents = strings.TrimSuffix(contents, "\n}") + ",\n  \"unknown\":\"rejected\"\n}\n"
				if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
					t.Fatalf("write unknown-field fixture: %v", err)
				}
			},
		},
		{
			name: "trailing JSON",
			setup: func(t *testing.T, path string) {
				t.Helper()
				contents := validEnvelopeJSON(materialSetID, nonce, "https://community.example.test", `"ENCRYPTION_KEY":"placeholder-encryption-value","TAKOSUMI_ACCOUNTS_CLIENT_ID":"placeholder-client-id"`) + "{}"
				if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
					t.Fatalf("write trailing-json fixture: %v", err)
				}
			},
		},
		{
			name: "origin name mismatch",
			setup: func(t *testing.T, path string) {
				t.Helper()
				writeValidEnvelope(t, path, materialSetID, nonce)
			},
		},
		{
			name: "non-canonical origin",
			setup: func(t *testing.T, path string) {
				t.Helper()
				contents := validEnvelopeJSON(materialSetID, nonce, "https://community.example.test/", `"ENCRYPTION_KEY":"placeholder-encryption-value","TAKOSUMI_ACCOUNTS_CLIENT_ID":"placeholder-client-id"`)
				if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
					t.Fatalf("write origin fixture: %v", err)
				}
			},
		},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			path := filepath.Join(t.TempDir(), "runtime-inputs.json")
			test.setup(t, path)
			_, err := credentialfile.Load(path, "https://other.example.test", []string{"ENCRYPTION_KEY", "TAKOSUMI_ACCOUNTS_CLIENT_ID"})
			if err == nil {
				t.Fatal("Load() accepted an invalid credential file")
			}
		})
	}
}

func validEnvelopeJSON(materialSetID, nonce, origin, values string) string {
	return fmt.Sprintf(`{
  "format":"takosumi.provider-credential-file@v1",
  "materialSetId":%q,
  "materialSetNonce":%q,
  "target":{"space":"default","workerName":"yurucommu","bundleName":"bundle-01","originResourceUid":"uid-origin-01"},
  "canonicalPublicOrigin":%q,
  "values":{%s}
}
`, materialSetID, nonce, origin, values)
}

func writeValidEnvelope(t *testing.T, path, materialSetID, nonce string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(validEnvelopeJSON(materialSetID, nonce, "https://community.example.test", `"ENCRYPTION_KEY":"placeholder-encryption-value","TAKOSUMI_ACCOUNTS_CLIENT_ID":"placeholder-client-id"`)), 0o600); err != nil {
		t.Fatalf("write valid credential fixture: %v", err)
	}
}
