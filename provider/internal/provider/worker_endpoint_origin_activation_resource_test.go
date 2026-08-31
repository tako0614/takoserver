package provider

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/path"
	frameworkresource "github.com/hashicorp/terraform-plugin-framework/resource"
	resourceschema "github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/tfsdk"
	"github.com/hashicorp/terraform-plugin-framework/types"
	"github.com/hashicorp/terraform-plugin-go/tftypes"

	"github.com/tako0614/takoserver/provider/internal/client"
)

func TestWorkerEndpointOriginActivationCreateReadDeleteExact(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	var puts, gets, deletes atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		wantPath := "/v1/worker-endpoint-origin-reservations/" + reservationID
		if r.Method == http.MethodPut || r.Method == http.MethodDelete {
			wantPath += "/activation"
		}
		if r.URL.EscapedPath() != wantPath || r.URL.RawQuery != "" {
			t.Fatalf("activation route = %s query=%q", r.URL.EscapedPath(), r.URL.RawQuery)
		}
		switch r.Method {
		case http.MethodPut:
			puts.Add(1)
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatalf("decode activation body: %v", err)
			}
			if body["format"] != "takoserver.worker-endpoint-origin-reservation-activation.v1" || body["endpointResourceUid"] != "uid-endpoint-01" {
				t.Fatalf("activation body = %#v", body)
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, activationProjectionJSON("8", "activated"))
		case http.MethodGet:
			gets.Add(1)
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, activationProjectionJSON("8", "activated"))
		case http.MethodDelete:
			deletes.Add(1)
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatalf("decode delete body: %v", err)
			}
			if body["format"] != "takoserver.worker-endpoint-origin-reservation-activation.v1" || body["endpointResourceUid"] != "uid-endpoint-01" {
				t.Fatalf("delete body = %#v", body)
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, activationProjectionJSON("9", "bound"))
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()
	api, err := client.New(server.URL, "provider-token", "org-01", server.Client())
	if err != nil {
		t.Fatalf("client.New() error = %v", err)
	}
	candidate := &workerEndpointOriginActivationResource{data: &providerData{client: api}}
	schema := activationSchema(t, candidate)
	plan := newActivationPlan(t, ctx, schema)
	create := frameworkresource.CreateResponse{State: emptyState(ctx, schema)}
	candidate.Create(ctx, frameworkresource.CreateRequest{Plan: plan}, &create)
	if create.Diagnostics.HasError() {
		t.Fatalf("Create() diagnostics = %v", create.Diagnostics)
	}
	state := create.State
	read := frameworkresource.ReadResponse{State: state}
	candidate.Read(ctx, frameworkresource.ReadRequest{State: state}, &read)
	if read.Diagnostics.HasError() {
		t.Fatalf("Read() diagnostics = %v", read.Diagnostics)
	}
	deleteResponse := frameworkresource.DeleteResponse{}
	candidate.Delete(ctx, frameworkresource.DeleteRequest{State: state}, &deleteResponse)
	if deleteResponse.Diagnostics.HasError() {
		t.Fatalf("Delete() diagnostics = %v", deleteResponse.Diagnostics)
	}
	if puts.Load() != 1 || gets.Load() != 1 || deletes.Load() != 1 {
		t.Fatalf("puts=%d gets=%d deletes=%d", puts.Load(), gets.Load(), deletes.Load())
	}
}

func TestWorkerEndpointOriginActivationReadFailsClosedOnEndpointDrift(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.EscapedPath() != "/v1/worker-endpoint-origin-reservations/"+reservationID || r.URL.RawQuery != "" {
			t.Fatalf("reservation route = %s query=%q", r.URL.EscapedPath(), r.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, activationProjectionJSON("8", "activated"))
	}))
	defer server.Close()
	api, err := client.New(server.URL, "provider-token", "org-01", server.Client())
	if err != nil {
		t.Fatalf("client.New() error = %v", err)
	}
	candidate := &workerEndpointOriginActivationResource{data: &providerData{client: api}}
	schema := activationSchema(t, candidate)
	state := seededActivationState(t, ctx, schema)
	// A different endpoint is returned by the server, proving that Read does
	// not silently adopt a replacement binding.
	setStateAttribute(t, ctx, &state, "endpoint_resource_uid", types.StringValue("uid-endpoint-02"))
	response := frameworkresource.ReadResponse{State: state}
	candidate.Read(ctx, frameworkresource.ReadRequest{State: state}, &response)
	if !response.Diagnostics.HasError() {
		t.Fatal("Read() accepted endpoint identity drift")
	}
}

func TestWorkerEndpointOriginActivationReadClosesLostDeleteAcknowledgement(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.EscapedPath() != "/v1/worker-endpoint-origin-reservations/"+reservationID || r.URL.RawQuery != "" {
			t.Fatalf("reservation request = %s %s query=%q", r.Method, r.URL.EscapedPath(), r.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, activationProjectionJSON("9", "bound"))
	}))
	defer server.Close()
	api, err := client.New(server.URL, "provider-token", "org-01", server.Client())
	if err != nil {
		t.Fatalf("client.New() error = %v", err)
	}
	candidate := &workerEndpointOriginActivationResource{data: &providerData{client: api}}
	schema := activationSchema(t, candidate)
	state := seededActivationState(t, ctx, schema)
	response := frameworkresource.ReadResponse{State: state}
	candidate.Read(ctx, frameworkresource.ReadRequest{State: state}, &response)
	if response.Diagnostics.HasError() {
		t.Fatalf("Read() diagnostics = %v", response.Diagnostics)
	}
	if !response.State.Raw.IsNull() {
		t.Fatal("Read() retained an activation that Takoserver had already deactivated")
	}
}

func activationSchema(t *testing.T, candidate frameworkresource.Resource) resourceschema.Schema {
	t.Helper()
	var response frameworkresource.SchemaResponse
	candidate.Schema(context.Background(), frameworkresource.SchemaRequest{}, &response)
	if response.Diagnostics.HasError() {
		t.Fatalf("schema diagnostics = %v", response.Diagnostics)
	}
	return response.Schema
}

func newActivationPlan(t *testing.T, ctx context.Context, schema resourceschema.Schema) tfsdk.Plan {
	t.Helper()
	plan := tfsdk.Plan{Schema: schema, Raw: tftypes.NewValue(schema.Type().TerraformType(ctx), nil)}
	setPlanAttribute(t, ctx, &plan, "origin_reservation_id", types.StringValue(reservationID))
	setPlanAttribute(t, ctx, &plan, "endpoint_resource_uid", types.StringValue("uid-endpoint-01"))
	return plan
}

func seededActivationState(t *testing.T, ctx context.Context, schema resourceschema.Schema) tfsdk.State {
	t.Helper()
	plan := newActivationPlan(t, ctx, schema)
	setPlanAttribute(t, ctx, &plan, "space", types.StringValue("default"))
	setPlanAttribute(t, ctx, &plan, "worker_name", types.StringValue(workerName))
	setPlanAttribute(t, ctx, &plan, "worker_resource_uid", types.StringValue(workerUID))
	setPlanAttribute(t, ctx, &plan, "endpoint_name", types.StringValue(endpointName))
	setPlanAttribute(t, ctx, &plan, "canonical_public_origin", types.StringValue(canonicalOrigin))
	setPlanAttribute(t, ctx, &plan, "revision", types.StringValue("8"))
	setPlanAttribute(t, ctx, &plan, "status", types.StringValue("activated"))
	setPlanAttribute(t, ctx, &plan, "expires_at", types.StringValue("2026-08-31T18:30:00Z"))
	return tfsdk.State{Schema: schema, Raw: plan.Raw}
}

func setStateAttribute(t *testing.T, ctx context.Context, state *tfsdk.State, name string, value attr.Value) {
	t.Helper()
	if diagnostics := state.SetAttribute(ctx, path.Root(name), value); diagnostics.HasError() {
		t.Fatalf("set state %s: %v", name, diagnostics)
	}
}

func activationProjectionJSON(revision, status string) string {
	return fmt.Sprintf(`{"format":"takoserver.worker-endpoint-origin-reservation.v1","reservationId":"%s","canonicalPublicOrigin":"%s","revision":"%s","expiresAt":"2026-08-31T18:30:00Z","target":{"space":"default","workerName":"%s","endpointName":"%s"},"status":"%s","workerResourceUid":"%s","endpointResourceUid":"uid-endpoint-01"}`,
		reservationID, canonicalOrigin, revision, workerName, endpointName, status, workerUID)
}
