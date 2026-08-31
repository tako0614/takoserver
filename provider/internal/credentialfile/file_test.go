package credentialfile_test

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/tako0614/takoserver/provider/internal/credentialfile"
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
  "materialSetId": "material-set-01",
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
	if got.MaterialSetID != "material-set-01" {
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
      "materialSetId":"material-set-01",
      "canonicalPublicOrigin":"https://community.example.test",
      "values":{"../TOKEN":"placeholder-value"}
    }`), 0o600); err != nil {
		t.Fatalf("write credential fixture: %v", err)
	}

	if _, err := credentialfile.Load(path, "https://community.example.test", []string{"../TOKEN"}); err == nil {
		t.Fatal("Load() accepted a binding name outside the portable environment namespace")
	}
}
