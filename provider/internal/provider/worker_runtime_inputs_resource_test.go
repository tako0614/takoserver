package provider

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
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
	"github.com/tako0614/takoserver/provider/internal/credentialfile"
)

const (
	workerUID       = "uid-worker-01"
	reservationID   = "reservation-01"
	canonicalOrigin = "https://community.example.test"
	workerName      = "yurucommu"
	bundleName      = "bundle-01"
	endpointName    = "public"
)

func TestWorkerRuntimeInputsCreateGetsReservationBeforeSendingValues(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	const secret = "placeholder-encryption-value"
	credentialPath := filepath.Join(t.TempDir(), "runtime-inputs.json")
	writeRuntimeCredential(t, credentialPath, secret)

	var requests atomic.Int64
	var putBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			if r.URL.EscapedPath() != "/v1/worker-endpoint-origin-reservations/"+reservationID {
				t.Fatalf("reservation path = %s", r.URL.EscapedPath())
			}
			requests.Add(1)
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, reservationJSON("bound", "7", workerUID, ""))
		case http.MethodPut:
			requests.Add(1)
			if err := json.NewDecoder(r.Body).Decode(&putBody); err != nil {
				t.Fatalf("decode preparation body: %v", err)
			}
			operationID := filepath.Base(r.URL.Path)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusCreated)
			_, _ = io.WriteString(w, runtimePreparationJSON(operationID))
		default:
			t.Fatalf("unexpected %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()
	api, err := client.New(server.URL, "provider-token", "org-01", server.Client())
	if err != nil {
		t.Fatalf("client.New() error = %v", err)
	}
	candidate := &workerRuntimeInputsResource{data: &providerData{client: api, credentialFilePath: credentialPath}}
	schemaResponse := workerRuntimeInputsSchema(t, candidate)
	plan := newRuntimePlan(t, ctx, schemaResponse.Schema)
	response := frameworkresource.CreateResponse{State: emptyState(ctx, schemaResponse.Schema)}
	candidate.Create(ctx, frameworkresource.CreateRequest{Plan: plan}, &response)
	if response.Diagnostics.HasError() {
		t.Fatalf("Create() diagnostics = %v", response.Diagnostics)
	}
	if requests.Load() != 2 {
		t.Fatalf("HTTP requests = %d, want reservation GET + preparation PUT", requests.Load())
	}
	target := putBody["target"].(map[string]any)
	if target["originReservationId"] != reservationID || target["workerResourceUid"] != workerUID {
		t.Fatalf("preparation target = %#v", target)
	}
	if putBody["materialSetNonce"] != "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" || putBody["runtimeInputReference"] != runtimeReferenceFixture() {
		t.Fatalf("preparation preflight identity = %#v", putBody)
	}
	for _, forbidden := range []string{"originResourceUid", "canonicalPublicOrigin", "endpointName"} {
		if _, ok := putBody[forbidden]; ok {
			t.Errorf("preparation body unexpectedly contains %q", forbidden)
		}
		if _, ok := target[forbidden]; ok {
			t.Errorf("preparation target unexpectedly contains %q", forbidden)
		}
	}
	var state workerRuntimeInputsModel
	if diagnostics := response.State.Get(ctx, &state); diagnostics.HasError() {
		t.Fatalf("read state: %v", diagnostics)
	}
	if state.MaterialSetID.IsNull() || state.OriginReservationID.ValueString() != reservationID || state.CanonicalPublicOrigin.ValueString() != canonicalOrigin || state.EndpointName.ValueString() != endpointName {
		t.Fatalf("state projection = %#v", state)
	}
	serialized := fmt.Sprintf("%#v", response.State.Raw)
	for _, forbidden := range []string{secret, credentialPath, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"} {
		if strings.Contains(serialized, forbidden) {
			t.Errorf("state contains forbidden runtime material %q", forbidden)
		}
	}
	if err := os.Remove(credentialPath); err != nil {
		t.Fatalf("remove run-scoped credential after apply: %v", err)
	}
	refreshPlan := newRuntimePlan(t, ctx, schemaResponse.Schema)
	refresh := frameworkresource.ModifyPlanResponse{Plan: refreshPlan}
	candidate.ModifyPlan(ctx, frameworkresource.ModifyPlanRequest{Plan: refreshPlan, State: response.State}, &refresh)
	if refresh.Diagnostics.HasError() {
		t.Fatalf("ModifyPlan() after credential cleanup diagnostics = %v", refresh.Diagnostics)
	}
	var refreshed workerRuntimeInputsModel
	if diagnostics := refresh.Plan.Get(ctx, &refreshed); diagnostics.HasError() {
		t.Fatalf("read refreshed plan: %v", diagnostics)
	}
	if refreshed.RuntimeInputReference.ValueString() != state.RuntimeInputReference.ValueString() {
		t.Fatalf("refreshed runtime input reference = %q, want prior %q", refreshed.RuntimeInputReference.ValueString(), state.RuntimeInputReference.ValueString())
	}
	if requests.Load() != 2 {
		t.Fatalf("HTTP requests after credential cleanup = %d, want no refresh request", requests.Load())
	}
}

func TestWorkerRuntimeInputsModifyPlanResolvesReferenceBeforeWorkerUIDExists(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	credentialPath := filepath.Join(t.TempDir(), "runtime-inputs.json")
	writeRuntimeCredential(t, credentialPath, "placeholder-encryption-value")
	candidate := &workerRuntimeInputsResource{data: &providerData{credentialFilePath: credentialPath}}
	schemaResponse := workerRuntimeInputsSchema(t, candidate)
	plan := newRuntimePlan(t, ctx, schemaResponse.Schema)
	setPlanAttribute(t, ctx, &plan, "worker_resource_uid", types.StringUnknown())
	response := frameworkresource.ModifyPlanResponse{Plan: plan}
	candidate.ModifyPlan(ctx, frameworkresource.ModifyPlanRequest{Plan: plan, State: emptyState(ctx, schemaResponse.Schema)}, &response)
	if response.Diagnostics.HasError() {
		t.Fatalf("ModifyPlan() diagnostics = %v", response.Diagnostics)
	}
	var planned workerRuntimeInputsModel
	if diagnostics := response.Plan.Get(ctx, &planned); diagnostics.HasError() {
		t.Fatalf("read planned model: %v", diagnostics)
	}
	if planned.WorkerResourceUID.IsUnknown() == false || planned.RuntimeInputReference.IsNull() || planned.RuntimeInputReference.IsUnknown() || planned.RuntimeInputReference.ValueString() != runtimeReferenceFixture() {
		t.Fatalf("planned preflight identity = %#v", planned)
	}
	serialized := fmt.Sprintf("%#v", response.Plan.Raw)
	for _, forbidden := range []string{"placeholder-encryption-value", credentialPath, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"} {
		if strings.Contains(serialized, forbidden) {
			t.Errorf("plan contains forbidden runtime material %q", forbidden)
		}
	}
}

func TestWorkerRuntimeInputsModifyPlanReplacesWhenPreflightEnvelopeChanges(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	credentialPath := filepath.Join(t.TempDir(), "runtime-inputs.json")
	writeRuntimeCredential(t, credentialPath, "old-material")
	candidate := &workerRuntimeInputsResource{data: &providerData{credentialFilePath: credentialPath}}
	schemaResponse := workerRuntimeInputsSchema(t, candidate)
	plan := newRuntimePlan(t, ctx, schemaResponse.Schema)
	oldReference := runtimeReferenceFixtureForValue("old-material")
	state := seededRuntimeState(t, ctx, schemaResponse.Schema)
	setStateAttribute(t, ctx, &state, "runtime_input_reference", types.StringValue(oldReference))
	writeRuntimeCredential(t, credentialPath, "new-material")
	response := frameworkresource.ModifyPlanResponse{Plan: plan}
	candidate.ModifyPlan(ctx, frameworkresource.ModifyPlanRequest{Plan: plan, State: state}, &response)
	if response.Diagnostics.HasError() {
		t.Fatalf("ModifyPlan() diagnostics = %v", response.Diagnostics)
	}
	var planned workerRuntimeInputsModel
	if diagnostics := response.Plan.Get(ctx, &planned); diagnostics.HasError() {
		t.Fatalf("read planned model: %v", diagnostics)
	}
	if planned.RuntimeInputReference.ValueString() != runtimeReferenceFixtureForValue("new-material") {
		t.Fatalf("planned reference = %q", planned.RuntimeInputReference.ValueString())
	}
	foundReplacement := false
	for _, replacement := range response.RequiresReplace {
		if replacement.Equal(path.Root("runtime_input_reference")) {
			foundReplacement = true
			break
		}
	}
	if !foundReplacement {
		t.Fatalf("RequiresReplace = %#v, want runtime_input_reference", response.RequiresReplace)
	}
}

func TestWorkerRuntimeInputsModifyPlanWithoutCredentialFailsClosedOnChangedTargetOrReference(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	credentialPath := filepath.Join(t.TempDir(), "runtime-inputs.json")
	writeRuntimeCredential(t, credentialPath, "placeholder-encryption-value")
	candidate := &workerRuntimeInputsResource{data: &providerData{credentialFilePath: credentialPath}}
	schemaResponse := workerRuntimeInputsSchema(t, candidate)
	state := seededRuntimeState(t, ctx, schemaResponse.Schema)
	if err := os.Remove(credentialPath); err != nil {
		t.Fatalf("remove credential fixture: %v", err)
	}
	changedTarget := newRuntimePlan(t, ctx, schemaResponse.Schema)
	setPlanAttribute(t, ctx, &changedTarget, "endpoint_name", types.StringValue("private"))
	targetResponse := frameworkresource.ModifyPlanResponse{Plan: changedTarget}
	candidate.ModifyPlan(ctx, frameworkresource.ModifyPlanRequest{Plan: changedTarget, State: state}, &targetResponse)
	if !targetResponse.Diagnostics.HasError() || strings.Contains(fmt.Sprintf("%v", targetResponse.Diagnostics), credentialPath) {
		t.Fatalf("changed target diagnostics = %v, want fileless fail-closed error without path", targetResponse.Diagnostics)
	}
	changedReference := newRuntimePlan(t, ctx, schemaResponse.Schema)
	setPlanAttribute(t, ctx, &changedReference, "runtime_input_reference", types.StringValue(runtimeReferenceFixtureForValue("rotated-material")))
	referenceResponse := frameworkresource.ModifyPlanResponse{Plan: changedReference}
	candidate.ModifyPlan(ctx, frameworkresource.ModifyPlanRequest{Plan: changedReference, State: state}, &referenceResponse)
	if !referenceResponse.Diagnostics.HasError() || strings.Contains(fmt.Sprintf("%v", referenceResponse.Diagnostics), credentialPath) {
		t.Fatalf("changed reference diagnostics = %v, want fileless fail-closed error without path", referenceResponse.Diagnostics)
	}
}

func TestWorkerRuntimeInputsModifyPlanWithoutCredentialRequiresFreshFileForUnknownReplacementUID(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	credentialPath := filepath.Join(t.TempDir(), "runtime-inputs.json")
	writeRuntimeCredential(t, credentialPath, "placeholder-encryption-value")
	candidate := &workerRuntimeInputsResource{data: &providerData{credentialFilePath: credentialPath}}
	schemaResponse := workerRuntimeInputsSchema(t, candidate)
	state := seededRuntimeState(t, ctx, schemaResponse.Schema)
	if err := os.Remove(credentialPath); err != nil {
		t.Fatalf("remove credential fixture: %v", err)
	}
	plan := newRuntimePlan(t, ctx, schemaResponse.Schema)
	setPlanAttribute(t, ctx, &plan, "worker_resource_uid", types.StringUnknown())
	response := frameworkresource.ModifyPlanResponse{Plan: plan}
	candidate.ModifyPlan(ctx, frameworkresource.ModifyPlanRequest{Plan: plan, State: state}, &response)
	if !response.Diagnostics.HasError() {
		t.Fatalf("unknown replacement UID diagnostics = %v, want fresh credential file error", response.Diagnostics)
	}
}

func TestWorkerRuntimeInputsCreateRejectsReservationProjectionBeforePUT(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	credentialPath := filepath.Join(t.TempDir(), "runtime-inputs.json")
	writeRuntimeCredential(t, credentialPath, "placeholder-encryption-value")
	var puts atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, reservationJSON("bound", "7", workerUID, ""))
			return
		}
		puts.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()
	api, err := client.New(server.URL, "provider-token", "org-01", server.Client())
	if err != nil {
		t.Fatalf("client.New() error = %v", err)
	}
	candidate := &workerRuntimeInputsResource{data: &providerData{client: api, credentialFilePath: credentialPath}}
	schemaResponse := workerRuntimeInputsSchema(t, candidate)
	plan := newRuntimePlan(t, ctx, schemaResponse.Schema)
	setPlanAttribute(t, ctx, &plan, "endpoint_name", types.StringValue("different"))
	response := frameworkresource.CreateResponse{State: emptyState(ctx, schemaResponse.Schema)}
	candidate.Create(ctx, frameworkresource.CreateRequest{Plan: plan}, &response)
	if !response.Diagnostics.HasError() || puts.Load() != 0 {
		t.Fatalf("Create() diagnostics=%v PUTs=%d", response.Diagnostics, puts.Load())
	}
}

func TestWorkerRuntimeInputsCreateRejectsUnboundReservationBeforePUT(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	credentialPath := filepath.Join(t.TempDir(), "runtime-inputs.json")
	writeRuntimeCredential(t, credentialPath, "placeholder-encryption-value")
	var puts atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, reservationJSON("prepared", "1", "", ""))
			return
		}
		puts.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()
	api, err := client.New(server.URL, "provider-token", "org-01", server.Client())
	if err != nil {
		t.Fatalf("client.New() error = %v", err)
	}
	candidate := &workerRuntimeInputsResource{data: &providerData{client: api, credentialFilePath: credentialPath}}
	schemaResponse := workerRuntimeInputsSchema(t, candidate)
	plan := newRuntimePlan(t, ctx, schemaResponse.Schema)
	response := frameworkresource.CreateResponse{State: emptyState(ctx, schemaResponse.Schema)}
	candidate.Create(ctx, frameworkresource.CreateRequest{Plan: plan}, &response)
	if !response.Diagnostics.HasError() || puts.Load() != 0 {
		t.Fatalf("Create() diagnostics=%v PUTs=%d", response.Diagnostics, puts.Load())
	}
}

func TestWorkerRuntimeInputsReadFailsClosedOnReservationDrift(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	var reads atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reads.Add(1)
		w.Header().Set("Content-Type", "application/json")
		if strings.Contains(r.URL.Path, "/worker-runtime-input-preparations/") {
			_, _ = io.WriteString(w, runtimePreparationJSON(filepath.Base(r.URL.Path)))
			return
		}
		_, _ = io.WriteString(w, strings.Replace(reservationJSON("bound", "8", workerUID, ""), canonicalOrigin, "https://other.example.test", 1))
	}))
	defer server.Close()
	api, err := client.New(server.URL, "provider-token", "org-01", server.Client())
	if err != nil {
		t.Fatalf("client.New() error = %v", err)
	}
	candidate := &workerRuntimeInputsResource{data: &providerData{client: api}}
	schemaResponse := workerRuntimeInputsSchema(t, candidate)
	state := seededRuntimeState(t, ctx, schemaResponse.Schema)
	response := frameworkresource.ReadResponse{State: state}
	candidate.Read(ctx, frameworkresource.ReadRequest{State: state}, &response)
	if !response.Diagnostics.HasError() || reads.Load() != 2 {
		t.Fatalf("Read() diagnostics=%v reads=%d", response.Diagnostics, reads.Load())
	}
}

func TestWorkerRuntimeInputsDeleteIsIdempotent(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete || !strings.Contains(r.URL.Path, "/v1/organizations/org-01/worker-runtime-input-preparations/") {
			t.Fatalf("request = %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()
	api, err := client.New(server.URL, "provider-token", "org-01", server.Client())
	if err != nil {
		t.Fatalf("client.New() error = %v", err)
	}
	candidate := &workerRuntimeInputsResource{data: &providerData{client: api}}
	schemaResponse := workerRuntimeInputsSchema(t, candidate)
	state := seededRuntimeState(t, ctx, schemaResponse.Schema)
	response := frameworkresource.DeleteResponse{}
	candidate.Delete(ctx, frameworkresource.DeleteRequest{State: state}, &response)
	if response.Diagnostics.HasError() {
		t.Fatalf("Delete() diagnostics = %v", response.Diagnostics)
	}
}

func workerRuntimeInputsSchema(t *testing.T, candidate frameworkresource.Resource) frameworkresource.SchemaResponse {
	t.Helper()
	var response frameworkresource.SchemaResponse
	candidate.Schema(context.Background(), frameworkresource.SchemaRequest{}, &response)
	if response.Diagnostics.HasError() {
		t.Fatalf("schema diagnostics = %v", response.Diagnostics)
	}
	return response
}

func newRuntimePlan(t *testing.T, ctx context.Context, schema resourceschema.Schema) tfsdk.Plan {
	t.Helper()
	plan := tfsdk.Plan{Schema: schema, Raw: tftypes.NewValue(schema.Type().TerraformType(ctx), nil)}
	setPlanAttribute(t, ctx, &plan, "space", types.StringValue("default"))
	setPlanAttribute(t, ctx, &plan, "worker_name", types.StringValue(workerName))
	setPlanAttribute(t, ctx, &plan, "worker_resource_uid", types.StringValue(workerUID))
	setPlanAttribute(t, ctx, &plan, "bundle_name", types.StringValue(bundleName))
	setPlanAttribute(t, ctx, &plan, "endpoint_name", types.StringValue(endpointName))
	setPlanAttribute(t, ctx, &plan, "binding_names", types.SetValueMust(types.StringType, []attr.Value{types.StringValue("ENCRYPTION_KEY")}))
	return plan
}

func seededRuntimeState(t *testing.T, ctx context.Context, schema resourceschema.Schema) tfsdk.State {
	t.Helper()
	plan := newRuntimePlan(t, ctx, schema)
	setPlanAttribute(t, ctx, &plan, "material_set_id", types.StringValue("material-set:v1:0000000000000000000000000000000000000000000000000000000000000000"))
	setPlanAttribute(t, ctx, &plan, "origin_reservation_id", types.StringValue(reservationID))
	setPlanAttribute(t, ctx, &plan, "canonical_public_origin", types.StringValue(canonicalOrigin))
	var model workerRuntimeInputsModel
	state := tfsdk.State{Schema: schema, Raw: plan.Raw}
	if diagnostics := state.Get(ctx, &model); diagnostics.HasError() {
		t.Fatalf("read seeded model: %v", diagnostics)
	}
	operationID, err := deriveOperationID(model, model.MaterialSetID.ValueString(), []string{"ENCRYPTION_KEY"})
	if err != nil {
		t.Fatalf("derive seeded operation ID: %v", err)
	}
	setPlanAttribute(t, ctx, &plan, "operation_id", types.StringValue(operationID))
	setPlanAttribute(t, ctx, &plan, "runtime_input_reference", types.StringValue(runtimeReferenceFixture()))
	setPlanAttribute(t, ctx, &plan, "status", types.StringValue("prepared"))
	setPlanAttribute(t, ctx, &plan, "expires_at", types.StringValue("2026-08-31T18:30:00Z"))
	return tfsdk.State{Schema: schema, Raw: plan.Raw}
}

func emptyState(ctx context.Context, schema resourceschema.Schema) tfsdk.State {
	return tfsdk.State{Schema: schema, Raw: tftypes.NewValue(schema.Type().TerraformType(ctx), nil)}
}

func setPlanAttribute(t *testing.T, ctx context.Context, plan *tfsdk.Plan, name string, value attr.Value) {
	t.Helper()
	state := tfsdk.State{Schema: plan.Schema, Raw: plan.Raw}
	if diagnostics := state.SetAttribute(ctx, path.Root(name), value); diagnostics.HasError() {
		t.Fatalf("set %s: %v", name, diagnostics)
	}
	plan.Raw = state.Raw
}

func writeRuntimeCredential(t *testing.T, path, secret string) {
	t.Helper()
	contents := fmt.Sprintf(`{
  "format":"takosumi.provider-credential-file@v1",
  "materialSetNonce":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "target":{"space":"default","workerName":"%s","bundleName":"%s","endpointName":"%s"},
  "originReservationId":"%s",
  "canonicalPublicOrigin":"%s",
  "values":{"ENCRYPTION_KEY":%q}
}
`, workerName, bundleName, endpointName, reservationID, canonicalOrigin, secret)
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatalf("write credential fixture: %v", err)
	}
}

func reservationJSON(status, revision, workerResourceUID, endpointResourceUID string) string {
	optional := ""
	if workerResourceUID != "" {
		optional += fmt.Sprintf(`,"workerResourceUid":%q`, workerResourceUID)
	}
	if endpointResourceUID != "" {
		optional += fmt.Sprintf(`,"endpointResourceUid":%q`, endpointResourceUID)
	}
	return fmt.Sprintf(`{"format":"takoserver.worker-endpoint-origin-reservation.v1","reservationId":"%s","canonicalPublicOrigin":"%s","revision":"%s","expiresAt":"2026-08-31T18:30:00Z","target":{"space":"default","workerName":"%s","endpointName":"%s"},"status":"%s"%s}`,
		reservationID, canonicalOrigin, revision, workerName, endpointName, status, optional)
}

func runtimePreparationJSON(operationID string) string {
	reference := runtimeReferenceFixture()
	parts := strings.Split(reference, ".")
	return fmt.Sprintf(`{"format":"takoserver.worker-runtime-input-preparation@v1","operationId":"%s","preparationId":"%s","runtimeInputReference":"%s","status":"prepared","expiresAt":"2026-08-31T18:30:00Z","target":{"space":"default","workerName":"%s","workerResourceUid":"%s","bundleName":"%s","originReservationId":"%s"},"canonicalPublicOrigin":"%s","bindingNames":["ENCRYPTION_KEY"]}`,
		operationID, parts[1], reference, workerName, workerUID, bundleName, reservationID, canonicalOrigin)
}

func runtimeReferenceFixture() string {
	return runtimeReferenceFixtureForValue("placeholder-encryption-value")
}

func runtimeReferenceFixtureForValue(value string) string {
	reference, err := credentialfile.ComputeRuntimeInputReference(credentialfile.Envelope{
		Format:                credentialfile.FormatV1,
		MaterialSetNonce:      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		Target:                credentialfile.Target{Space: "default", WorkerName: workerName, BundleName: bundleName, EndpointName: endpointName},
		OriginReservationID:   reservationID,
		CanonicalPublicOrigin: canonicalOrigin,
		Values:                map[string]string{"ENCRYPTION_KEY": value},
	})
	if err != nil {
		panic(err)
	}
	return reference
}
