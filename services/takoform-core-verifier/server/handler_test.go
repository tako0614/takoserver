package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/tako0614/takoserver/services/takoform-core-verifier/verifier"
)

func TestHandlerExposesIdentityAndNoGeneralSurface(t *testing.T) {
	service := verifier.New(noopCore{}, verifier.Identity{ArtifactDigest: digest("a")})
	handler := NewHandler(service)

	identity := httptest.NewRecorder()
	handler.ServeHTTP(identity, httptest.NewRequest(http.MethodGet, "/v1/identity", nil))
	if identity.Code != http.StatusOK {
		t.Fatalf("identity status = %d", identity.Code)
	}
	var observed verifier.Identity
	if err := json.Unmarshal(identity.Body.Bytes(), &observed); err != nil {
		t.Fatal(err)
	}
	if observed.ArtifactDigest != digest("a") || observed.CoreVersion != verifier.CoreVersion {
		t.Fatalf("identity = %#v", observed)
	}

	missing := httptest.NewRecorder()
	handler.ServeHTTP(missing, httptest.NewRequest(http.MethodGet, "/", nil))
	if missing.Code != http.StatusNotFound {
		t.Fatalf("root status = %d, want 404", missing.Code)
	}
}

func TestHandlerRequiresExactJSONAndBoundsBody(t *testing.T) {
	service := verifier.New(noopCore{}, verifier.Identity{ArtifactDigest: digest("a")})
	handler := NewHandler(service)

	wrongType := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/v1/verify-set", bytes.NewReader([]byte(`{}`)))
	handler.ServeHTTP(wrongType, request)
	if wrongType.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("wrong content type status = %d", wrongType.Code)
	}

	oversized := httptest.NewRecorder()
	largeJSON := append([]byte(`{"publisherPolicy":"`), bytes.Repeat([]byte("a"), MaxRequestBytes)...)
	request = httptest.NewRequest(http.MethodPost, "/v1/verify-set", bytes.NewReader(largeJSON))
	request.Header.Set("Content-Type", "application/json")
	handler.ServeHTTP(oversized, request)
	if oversized.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized status = %d", oversized.Code)
	}
}

type noopCore struct{}

func (noopCore) Verify(verifier.CoreInput) (verifier.CoreResult, error) {
	return verifier.CoreResult{}, context.Canceled
}

func digest(character string) string {
	value := "sha256:"
	for range 64 {
		value += character
	}
	return value
}
