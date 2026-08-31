package client_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tako0614/takoserver/provider/internal/client"
)

const (
	reservationID       = "reservation-01"
	endpointUID         = "uid-endpoint-01"
	runtimeInputNonce   = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	runtimeInputRef     = "rip1.prep-00000000000000000000000000000000.0000000000000000000000000000000000000000000000000000000000000000"
	prepResponse        = `{"format":"takoserver.worker-runtime-input-preparation@v1","operationId":"op-01","preparationId":"prep-00000000000000000000000000000000","runtimeInputReference":"rip1.prep-00000000000000000000000000000000.0000000000000000000000000000000000000000000000000000000000000000","status":"prepared","expiresAt":"2026-08-31T18:30:00Z","target":{"space":"default","workerName":"yurucommu","workerResourceUid":"uid-worker-01","bundleName":"bundle-01","originReservationId":"reservation-01"},"canonicalPublicOrigin":"https://community.example.test","bindingNames":["ENCRYPTION_KEY","TAKOSUMI_ACCOUNTS_CLIENT_ID"]}`
	reservationResponse = `{"format":"takoserver.worker-endpoint-origin-reservation.v1","reservationId":"reservation-01","canonicalPublicOrigin":"https://community.example.test","revision":"7","expiresAt":"2026-08-31T18:30:00Z","target":{"space":"default","workerName":"yurucommu","endpointName":"public"},"status":"bound","workerResourceUid":"uid-worker-01"}`
	activationResponse  = `{"format":"takoserver.worker-endpoint-origin-reservation.v1","reservationId":"reservation-01","canonicalPublicOrigin":"https://community.example.test","revision":"8","expiresAt":"2026-08-31T18:30:00Z","target":{"space":"default","workerName":"yurucommu","endpointName":"public"},"status":"activated","workerResourceUid":"uid-worker-01","endpointResourceUid":"uid-endpoint-01"}`
)

func TestPutRuntimeInputPreparationUsesReservationTargetAndSendsPreflightIdentity(t *testing.T) {
	t.Parallel()
	var gotBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut || r.URL.EscapedPath() != "/v1/organizations/org-01/worker-runtime-input-preparations/op-01" {
			t.Fatalf("request = %s %s", r.Method, r.URL.EscapedPath())
		}
		if got := r.Header.Get("Authorization"); got != "Bearer provider-token" {
			t.Fatalf("Authorization = %q", got)
		}
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, prepResponse)
	}))
	defer server.Close()

	api, err := client.New(server.URL, "provider-token", "org-01", server.Client())
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	result, err := api.PutRuntimeInputPreparation(context.Background(), "op-01", client.RuntimeInputPreparationInput{
		MaterialSetID:         "material-set:v1:5866abee0fff6a8765e02977561092a6f78cd3e97a5e2380a548aafbd030f4a3",
		MaterialSetNonce:      runtimeInputNonce,
		RuntimeInputReference: runtimeInputRef,
		Space:                 "default",
		WorkerName:            "yurucommu",
		WorkerResourceUID:     "uid-worker-01",
		BundleName:            "bundle-01",
		EndpointName:          "public",
		OriginReservationID:   reservationID,
		Bindings: map[string]string{
			"ENCRYPTION_KEY":              "placeholder-encryption-value",
			"TAKOSUMI_ACCOUNTS_CLIENT_ID": "placeholder-client-id",
		},
	})
	if err != nil {
		t.Fatalf("PutRuntimeInputPreparation() error = %v", err)
	}
	target, ok := gotBody["target"].(map[string]any)
	if !ok || target["originReservationId"] != reservationID || target["workerResourceUid"] != "uid-worker-01" {
		t.Fatalf("request target = %#v", gotBody["target"])
	}
	if gotBody["materialSetNonce"] != runtimeInputNonce || gotBody["runtimeInputReference"] != runtimeInputRef {
		t.Fatalf("request preflight identity = %#v", gotBody)
	}
	for _, forbidden := range []string{"originResourceUid", "canonicalPublicOrigin", "endpointName"} {
		if _, ok := gotBody[forbidden]; ok {
			t.Fatalf("request unexpectedly contains %q", forbidden)
		}
		if _, ok := target[forbidden]; ok {
			t.Fatalf("request target unexpectedly contains %q", forbidden)
		}
	}
	if result.OriginReservationID != reservationID || result.CanonicalPublicOrigin != "https://community.example.test" || result.EndpointName != "public" {
		t.Fatalf("result = %#v", result)
	}
}

func TestGetWorkerEndpointOriginReservationReturnsClosedProjection(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.EscapedPath() != "/v1/worker-endpoint-origin-reservations/"+reservationID {
			t.Fatalf("request = %s %s", r.Method, r.URL.EscapedPath())
		}
		if r.URL.RawQuery != "" {
			t.Fatalf("reservation request unexpectedly carries query organization scope: %q", r.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, reservationResponse)
	}))
	defer server.Close()
	api, err := client.New(server.URL, "provider-token", "org-01", server.Client())
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	result, err := api.GetWorkerEndpointOriginReservation(context.Background(), reservationID)
	if err != nil {
		t.Fatalf("GetWorkerEndpointOriginReservation() error = %v", err)
	}
	if result.ReservationID != reservationID || result.Status != "bound" || result.Revision != "7" || result.WorkerResourceUID != "uid-worker-01" || result.EndpointResourceUID != "" {
		t.Fatalf("reservation = %#v", result)
	}
}

func TestGetWorkerEndpointOriginReservationRejectsActivationFormat(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, strings.Replace(activationResponse, `"format":"takoserver.worker-endpoint-origin-reservation.v1"`, `"format":"takoserver.worker-endpoint-origin-reservation-activation.v1"`, 1))
	}))
	defer server.Close()
	api, err := client.New(server.URL, "provider-token", "org-01", server.Client())
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	if _, err := api.GetWorkerEndpointOriginReservation(context.Background(), reservationID); err == nil || !strings.Contains(err.Error(), "unsupported format") {
		t.Fatalf("reservation read error = %v, want strict reservation format rejection", err)
	}
}

func TestGetWorkerEndpointOriginReservationRejectsBoundProjectionWithoutWorkerUID(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, strings.Replace(reservationResponse, `,"workerResourceUid":"uid-worker-01"`, "", 1))
	}))
	defer server.Close()
	api, err := client.New(server.URL, "provider-token", "org-01", server.Client())
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	if _, err := api.GetWorkerEndpointOriginReservation(context.Background(), reservationID); err == nil || !strings.Contains(err.Error(), "incomplete projection") {
		t.Fatalf("reservation read error = %v, want bound worker identity rejection", err)
	}
}

func TestGetWorkerEndpointOriginReservationRejectsNullOptionalUID(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, strings.Replace(reservationResponse, `"workerResourceUid":"uid-worker-01"`, `"workerResourceUid":null`, 1))
	}))
	defer server.Close()
	api, err := client.New(server.URL, "provider-token", "org-01", server.Client())
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	if _, err := api.GetWorkerEndpointOriginReservation(context.Background(), reservationID); err == nil || !strings.Contains(err.Error(), "incomplete projection") {
		t.Fatalf("reservation read error = %v, want null optional UID rejection", err)
	}
}

func TestRuntimeInputAndReservationReadsRejectDuplicateKeysAndDeepJSON(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name string
		body string
	}{
		{name: "duplicate", body: `{"reservationId":"reservation-01","reservationId":"secret"}`},
		{name: "deep", body: strings.Repeat(`[`, 65) + `"secret"` + strings.Repeat(`]`, 65)},
	} {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, test.body)
			}))
			defer server.Close()
			api, err := client.New(server.URL, "provider-token", "org-01", server.Client())
			if err != nil {
				t.Fatalf("New() error = %v", err)
			}
			_, err = api.GetWorkerEndpointOriginReservation(context.Background(), reservationID)
			if err == nil || strings.Contains(err.Error(), "secret") {
				t.Fatalf("reservation read error = %v", err)
			}
		})
	}
}

func TestPutWorkerEndpointOriginActivationIsIdempotentAndDeleteIsExact(t *testing.T) {
	t.Parallel()
	var puts atomic.Int64
	var deletes atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.EscapedPath() != "/v1/worker-endpoint-origin-reservations/"+reservationID+"/activation" {
			t.Fatalf("path = %s", r.URL.EscapedPath())
		}
		if r.Method == http.MethodPut {
			puts.Add(1)
		} else if r.Method == http.MethodDelete {
			deletes.Add(1)
		} else {
			t.Fatalf("method = %s", r.Method)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		if body["format"] != "takoserver.worker-endpoint-origin-reservation-activation.v1" || body["endpointResourceUid"] != endpointUID {
			t.Fatalf("activation body = %#v", body)
		}
		if r.Method == http.MethodPut {
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, activationResponse)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, strings.Replace(activationResponse, `"status":"activated"`, `"status":"bound"`, 1))
	}))
	defer server.Close()
	api, err := client.New(server.URL, "provider-token", "org-01", server.Client())
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	for range 2 {
		projection, callErr := api.PutWorkerEndpointOriginActivation(context.Background(), reservationID, endpointUID)
		if callErr != nil || projection.Status != "activated" || projection.EndpointResourceUID != endpointUID {
			t.Fatalf("activation = %#v, error = %v", projection, callErr)
		}
	}
	if err := api.DeleteWorkerEndpointOriginActivation(context.Background(), reservationID, endpointUID); err != nil {
		t.Fatalf("delete activation error = %v", err)
	}
	if puts.Load() != 2 || deletes.Load() != 1 {
		t.Fatalf("puts=%d deletes=%d", puts.Load(), deletes.Load())
	}
}

func TestDeleteWorkerEndpointOriginActivationRejectsMissingEndpointProjection(t *testing.T) {
	t.Parallel()
	boundProjection := strings.Replace(activationResponse, `"status":"activated"`, `"status":"bound"`, 1)
	for _, test := range []struct {
		name string
		body string
	}{
		{name: "omitted", body: strings.Replace(boundProjection, `,"endpointResourceUid":"uid-endpoint-01"`, "", 1)},
		{name: "null", body: strings.Replace(boundProjection, `"endpointResourceUid":"uid-endpoint-01"`, `"endpointResourceUid":null`, 1)},
	} {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodDelete || r.URL.EscapedPath() != "/v1/worker-endpoint-origin-reservations/"+reservationID+"/activation" {
					t.Fatalf("request = %s %s", r.Method, r.URL.EscapedPath())
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, test.body)
			}))
			defer server.Close()
			api, err := client.New(server.URL, "provider-token", "org-01", server.Client())
			if err != nil {
				t.Fatalf("New() error = %v", err)
			}
			if err := api.DeleteWorkerEndpointOriginActivation(context.Background(), reservationID, endpointUID); err == nil || !strings.Contains(err.Error(), "mismatched identity or state") {
				t.Fatalf("delete activation error = %v, want non-null exact endpoint projection rejection", err)
			}
		})
	}
}

func TestPutWorkerEndpointOriginActivationRejectsMismatchedProjection(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, strings.Replace(activationResponse, `"endpointResourceUid":"uid-endpoint-01"`, `"endpointResourceUid":"uid-endpoint-02"`, 1))
	}))
	defer server.Close()
	api, err := client.New(server.URL, "provider-token", "org-01", server.Client())
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	if _, err := api.PutWorkerEndpointOriginActivation(context.Background(), reservationID, endpointUID); err == nil || !strings.Contains(err.Error(), "mismatched identity") {
		t.Fatalf("activation error = %v, want exact endpoint identity rejection", err)
	}
}

func TestRuntimeInputClientRejectsRedirectWithoutLeakingBody(t *testing.T) {
	t.Parallel()
	const secret = "redirect-body-must-not-appear-in-error"
	var requests atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		w.Header().Set("Location", "https://example.test/redirected")
		w.WriteHeader(http.StatusFound)
		_, _ = io.WriteString(w, secret)
	}))
	defer server.Close()
	api, err := client.New(server.URL, "provider-token", "org-01", server.Client())
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	_, err = api.GetWorkerEndpointOriginReservation(context.Background(), reservationID)
	if err == nil || strings.Contains(err.Error(), secret) || requests.Load() != 1 {
		t.Fatalf("redirect error = %v requests = %d", err, requests.Load())
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
		_, callErr := api.GetWorkerEndpointOriginReservation(ctx, reservationID)
		result <- callErr
	}()
	<-started
	cancel()
	select {
	case callErr := <-result:
		if callErr == nil {
			t.Fatal("reservation read succeeded after context cancellation")
		}
	case <-time.After(time.Second):
		t.Fatal("reservation read did not honor context cancellation")
	}
}

func TestOriginReservationProjectionKeepsOnlyValueFreeFields(t *testing.T) {
	t.Parallel()
	var projection client.WorkerEndpointOriginReservation
	if !reflect.DeepEqual(projection, client.WorkerEndpointOriginReservation{}) {
		t.Fatal("zero projection changed unexpectedly")
	}
}
