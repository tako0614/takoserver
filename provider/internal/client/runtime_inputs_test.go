package client_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tako0614/takoserver/provider/internal/client"
)

func TestPutRuntimeInputPreparationUsesTheTakoserverControlBoundary(t *testing.T) {
	t.Parallel()

	var gotBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			t.Errorf("method = %s", r.Method)
		}
		if r.URL.EscapedPath() != "/v1/organizations/org-01/worker-runtime-input-preparations/op-01" {
			t.Errorf("path = %s", r.URL.EscapedPath())
		}
		if got := r.Header.Get("Authorization"); got != "Bearer provider-token" {
			t.Errorf("Authorization = %q", got)
		}
		if got := r.Header.Get("Cache-Control"); got != "no-store" {
			t.Errorf("Cache-Control = %q", got)
		}
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Fatalf("decode request: %v", err)
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{
          "format":"takoserver.worker-runtime-input-preparation@v1",
          "operationId":"op-01",
          "preparationId":"prep-01",
          "status":"prepared",
          "expiresAt":"2026-08-31T18:30:00Z",
          "target":{"space":"default","workerName":"yurucommu","bundleName":"bundle-01","originResourceUid":"uid-origin-01"},
          "canonicalPublicOrigin":"https://community.example.test",
          "bindingNames":["ENCRYPTION_KEY","TAKOSUMI_ACCOUNTS_CLIENT_ID"]
        }`))
	}))
	defer server.Close()

	api, err := client.New(server.URL, "provider-token", "org-01", server.Client())
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	result, err := api.PutRuntimeInputPreparation(context.Background(), "op-01", client.RuntimeInputPreparationInput{
		MaterialSetID:         "material-set:v1:5866abee0fff6a8765e02977561092a6f78cd3e97a5e2380a548aafbd030f4a3",
		Space:                 "default",
		WorkerName:            "yurucommu",
		BundleName:            "bundle-01",
		OriginResourceUID:     "uid-origin-01",
		CanonicalPublicOrigin: "https://community.example.test",
		Bindings: map[string]string{
			"ENCRYPTION_KEY":              "placeholder-encryption-value",
			"TAKOSUMI_ACCOUNTS_CLIENT_ID": "placeholder-client-id",
		},
	})
	if err != nil {
		t.Fatalf("PutRuntimeInputPreparation() error = %v", err)
	}

	if gotBody["format"] != "takoserver.worker-runtime-input-preparation@v1" {
		t.Fatalf("request format = %#v", gotBody["format"])
	}
	if gotBody["materialSetId"] != "material-set:v1:5866abee0fff6a8765e02977561092a6f78cd3e97a5e2380a548aafbd030f4a3" {
		t.Fatalf("materialSetId = %#v", gotBody["materialSetId"])
	}
	bindings, ok := gotBody["bindings"].(map[string]any)
	if !ok || bindings["ENCRYPTION_KEY"] != "placeholder-encryption-value" || bindings["TAKOSUMI_ACCOUNTS_CLIENT_ID"] != "placeholder-client-id" {
		t.Fatalf("bindings = %#v", gotBody["bindings"])
	}
	if result.OperationID != "op-01" || result.PreparationID != "prep-01" || result.Status != "prepared" {
		t.Fatalf("result identity/status = %#v", result)
	}
	if !result.ExpiresAt.Equal(time.Date(2026, 8, 31, 18, 30, 0, 0, time.UTC)) {
		t.Fatalf("expiresAt = %s", result.ExpiresAt)
	}
	if !reflect.DeepEqual(result.BindingNames, []string{"ENCRYPTION_KEY", "TAKOSUMI_ACCOUNTS_CLIENT_ID"}) {
		t.Fatalf("binding names = %#v", result.BindingNames)
	}
}

func TestGetRuntimeInputPreparationReturnsOnlyTheValueFreeProjection(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("method = %s", r.Method)
		}
		if r.URL.EscapedPath() != "/v1/organizations/org-01/worker-runtime-input-preparations/op-01" {
			t.Errorf("path = %s", r.URL.EscapedPath())
		}
		if got := r.Header.Get("Authorization"); got != "Bearer provider-token" {
			t.Errorf("Authorization = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
          "format":"takoserver.worker-runtime-input-preparation@v1",
          "operationId":"op-01",
          "preparationId":"prep-01",
          "status":"consumed",
          "expiresAt":"2026-08-31T18:30:00Z",
          "target":{"space":"default","workerName":"yurucommu","bundleName":"bundle-01","originResourceUid":"uid-origin-01"},
          "canonicalPublicOrigin":"https://community.example.test",
          "bindingNames":["ENCRYPTION_KEY","TAKOSUMI_ACCOUNTS_CLIENT_ID"]
        }`))
	}))
	defer server.Close()

	api, err := client.New(server.URL, "provider-token", "org-01", server.Client())
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	result, err := api.GetRuntimeInputPreparation(context.Background(), "op-01")
	if err != nil {
		t.Fatalf("GetRuntimeInputPreparation() error = %v", err)
	}
	if result.OperationID != "op-01" || result.PreparationID != "prep-01" || result.Status != "consumed" {
		t.Fatalf("result = %#v", result)
	}
}

func TestDeleteRuntimeInputPreparationIsIdempotent(t *testing.T) {
	t.Parallel()

	for _, status := range []int{http.StatusNoContent, http.StatusNotFound} {
		status := status
		t.Run(http.StatusText(status), func(t *testing.T) {
			t.Parallel()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodDelete {
					t.Errorf("method = %s", r.Method)
				}
				if r.URL.EscapedPath() != "/v1/organizations/org-01/worker-runtime-input-preparations/op-01" {
					t.Errorf("path = %s", r.URL.EscapedPath())
				}
				w.WriteHeader(status)
			}))
			defer server.Close()

			api, err := client.New(server.URL, "provider-token", "org-01", server.Client())
			if err != nil {
				t.Fatalf("New() error = %v", err)
			}
			if err := api.DeleteRuntimeInputPreparation(context.Background(), "op-01"); err != nil {
				t.Fatalf("DeleteRuntimeInputPreparation() error = %v", err)
			}
		})
	}
}

func TestNewRequiresOneCanonicalEndpointOrigin(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.NotFoundHandler())
	defer server.Close()

	for _, endpoint := range []string{server.URL + "/", "https://EXAMPLE.test", "https://example.test/", "https://example.test?query=1", "https://example.test:443"} {
		endpoint := endpoint
		t.Run(endpoint, func(t *testing.T) {
			t.Parallel()
			if _, err := client.New(endpoint, "provider-token", "org-01", server.Client()); err == nil {
				t.Fatalf("New(%q) accepted a non-canonical endpoint origin", endpoint)
			}
		})
	}
}

func TestRuntimeInputClientDoesNotFollowRedirectsOrLeakResponseBody(t *testing.T) {
	t.Parallel()
	const secret = "redirect-body-must-not-appear-in-error"
	var requests atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		w.Header().Set("Location", "https://example.test/redirected")
		w.WriteHeader(http.StatusFound)
		_, _ = w.Write([]byte(secret))
	}))
	defer server.Close()

	api, err := client.New(server.URL, "provider-token", "org-01", server.Client())
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	_, err = api.PutRuntimeInputPreparation(context.Background(), "op-01", client.RuntimeInputPreparationInput{
		MaterialSetID:         "material-set:v1:5866abee0fff6a8765e02977561092a6f78cd3e97a5e2380a548aafbd030f4a3",
		Space:                 "default",
		WorkerName:            "yurucommu",
		BundleName:            "bundle-01",
		OriginResourceUID:     "uid-origin-01",
		CanonicalPublicOrigin: "https://community.example.test",
		Bindings:              map[string]string{"ENCRYPTION_KEY": "placeholder-encryption-value"},
	})
	if err == nil {
		t.Fatal("PutRuntimeInputPreparation() accepted a redirect response")
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatalf("redirect response body leaked through error: %v", err)
	}
	if got := requests.Load(); got != 1 {
		t.Fatalf("HTTP requests = %d, want one request without redirect", got)
	}
}

func TestRuntimeInputClientHonorsContextCancellation(t *testing.T) {
	t.Parallel()
	started := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done()
		w.WriteHeader(http.StatusGatewayTimeout)
	}))
	defer server.Close()

	api, err := client.New(server.URL, "provider-token", "org-01", server.Client())
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	go func() {
		_, callErr := api.GetRuntimeInputPreparation(ctx, "op-01")
		result <- callErr
	}()
	<-started
	cancel()
	select {
	case callErr := <-result:
		if callErr == nil {
			t.Fatal("GetRuntimeInputPreparation() succeeded after context cancellation")
		}
	case <-time.After(time.Second):
		t.Fatal("GetRuntimeInputPreparation() did not honor context cancellation")
	}
}
